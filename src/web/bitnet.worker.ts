import { errorMessage, setWebDiagnosticsEnabled } from './diagnostics';
import {
  WebUnsupportedRuntimeError,
  configureWebRuntime,
  detectWebRuntimeCapabilities,
  selectWebRuntime,
  type WebResolvedRuntime as ResolvedRuntime,
  type WebRuntime as Runtime,
} from './runtime';
import { WebModelCache } from './modelCache';
import { configureWasmLoader, WasmCPUBackend } from './wasmBackend';
import type { Backend, GenerationConfig, LoadOptions, TokenEvent } from './workerTypes';

type WorkerRequest = {
  id: number;
  method: string;
  payload?: Record<string, unknown>;
};

type ModelSession = {
  id: string;
  path: string;
  requestedRuntime: Runtime;
  runtimeUsed: ResolvedRuntime;
  backend: Backend;
  busy: boolean;
};

type GenerationSession = {
  id: string;
  model: ModelSession;
  events: TokenEvent[];
  done: boolean;
  cancelled: boolean;
  cancelFlag?: Int32Array;
  waiters: Array<() => void>;
};

declare const self: any;

const models = new Map<string, ModelSession>();
const generations = new Map<string, GenerationSession>();
const modelCache = new WebModelCache(self);
let nextModelId = 1;
let nextGenerationId = 1;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data)
    .then((result) => self.postMessage({ id: event.data.id, ok: true, result }))
    .catch((error) => self.postMessage({ id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
};

async function handleRequest(request: WorkerRequest): Promise<string | boolean | number | null> {
  const payload = request.payload ?? {};
  switch (request.method) {
    case 'configure':
      configureWasmLoader(typeof payload.wasmModuleUrl === 'string' ? payload.wasmModuleUrl : '/bitnet_wasm.js');
      setWebDiagnosticsEnabled(Boolean(payload.webDebug));
      configureWebRuntime({
        webThreads: Boolean(payload.webThreads),
        webThreadCount: typeof payload.webThreadCount === 'number' ? payload.webThreadCount : undefined,
      });
      return null;
    case 'getRuntimeCapabilities':
      return JSON.stringify(detectWebRuntimeCapabilities(self));
    case 'loadModel':
      return JSON.stringify(await loadModel(String(payload.modelPath), String(payload.optionsJson)));
    case 'unloadModel':
      unloadModel(String(payload.modelHandle));
      return null;
    case 'startGeneration':
      return startGeneration(
        String(payload.modelHandle),
        JSON.parse(String(payload.paramsJson)) as GenerationConfig,
        typeof SharedArrayBuffer !== 'undefined' && payload.cancelBuffer instanceof SharedArrayBuffer
          ? payload.cancelBuffer
          : undefined
      );
    case 'nextTokenBatch':
      return JSON.stringify(
        await nextTokenBatch(String(payload.generationHandle), Number(payload.maxTokens), Number(payload.timeoutMs))
      );
    case 'cancelGeneration':
      cancelGeneration(String(payload.generationHandle));
      return null;
    case 'downloadModel':
      return modelCache.startDownload(String(payload.requestJson));
    case 'getDownloadProgress':
      return JSON.stringify(modelCache.downloadProgress(String(payload.jobHandle)));
    case 'awaitDownload':
      return JSON.stringify(await modelCache.awaitDownload(String(payload.jobHandle)));
    case 'cancelDownload':
      modelCache.cancelDownload(String(payload.jobHandle));
      return null;
    case 'listModels':
      return JSON.stringify(await modelCache.listCachedModels());
    case 'deleteModel':
      return modelCache.deleteModel(String(payload.modelId));
    case 'getDiskUsage':
      return modelCache.diskUsage();
    default:
      throw new Error(`Unknown BitNet web worker method: ${request.method}`);
  }
}

async function loadModel(modelPath: string, optionsJson: string) {
  await modelCache.ensureReady();
  const options = JSON.parse(optionsJson) as LoadOptions;
  const requestedRuntime: Runtime = options.runtime ?? 'cpu';
  const selection = selectWebRuntime(requestedRuntime, detectWebRuntimeCapabilities(self));
  const warnings = selection.warnings;
  const runtimeUsed = selection.runtime;
  const backend = createBackend(runtimeUsed);
  await backend.loadModel(modelPath, { ...options, runtime: runtimeUsed });

  const handle = `web-model-${nextModelId++}`;
  models.set(handle, {
    id: options.id ?? modelPath,
    path: modelPath,
    requestedRuntime,
    runtimeUsed,
    backend,
    busy: false,
  });
  return { handle, id: options.id ?? modelPath, path: modelPath, runtimeUsed, warnings };
}

function unloadModel(modelHandle: string): void {
  const model = requireModel(modelHandle);
  model.backend.cancel();
  model.backend.unload();
  models.delete(modelHandle);
}

function startGeneration(modelHandle: string, config: GenerationConfig, cancelBuffer?: SharedArrayBuffer): string {
  const model = requireModel(modelHandle);
  if (model.busy) {
    // Concurrent decoding leads to memory contention and unpredictable latency
    // because each model session shares loaded weights and KV-cache state.
    throw new Error('BITNET_INFERENCE_BUSY: max concurrency is one generation per model');
  }
  model.busy = true;
  const generation: GenerationSession = {
    id: `web-generation-${nextGenerationId++}`,
    model,
    events: [],
    done: false,
    cancelled: false,
    cancelFlag: cancelBuffer ? new Int32Array(cancelBuffer) : undefined,
    waiters: [],
  };
  generations.set(generation.id, generation);
  const blockingBackend = generation.model.backend as WasmCPUBackend;
  if (typeof blockingBackend.generateBlocking === 'function') {
    setTimeout(() => runGenerationBlocking(generation, config), 0);
  } else {
    void runGeneration(generation, config);
  }
  return generation.id;
}

function runGenerationBlocking(generation: GenerationSession, config: GenerationConfig): void {
  try {
    (generation.model.backend as WasmCPUBackend).generateBlocking(config, generation.id, generation.cancelFlag);
  } catch (error) {
    self.postMessage({
      type: 'tokenEvent',
      generationHandle: generation.id,
      event: { type: 'error', error: errorMessage(error) },
    });
  } finally {
    generation.done = true;
    generation.model.busy = false;
    generations.delete(generation.id);
  }
}

async function runGeneration(generation: GenerationSession, config: GenerationConfig): Promise<void> {
  try {
    for await (const token of generation.model.backend.generate(config)) {
      if (generation.cancelled) {
        pushEvent(generation, { type: 'cancelled' });
        return;
      }
      pushEvent(generation, { type: 'token', text: token });
    }
    pushEvent(generation, { type: 'metrics', metrics: generation.model.backend.getMetrics() });
    pushEvent(generation, { type: 'end' });
  } catch (error) {
    pushEvent(generation, { type: 'error', error: errorMessage(error) });
  } finally {
    generation.done = true;
    generation.model.busy = false;
    wake(generation);
  }
}

async function nextTokenBatch(generationHandle: string, maxTokens: number, timeoutMs: number): Promise<TokenEvent[]> {
  const generation = requireGeneration(generationHandle);
  if (generation.events.length === 0 && !generation.done) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      generation.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  const batch = generation.events.splice(0, Math.max(1, maxTokens));
  if (generation.done && generation.events.length === 0) {
    generations.delete(generationHandle);
  }
  return batch;
}

function cancelGeneration(generationHandle: string): void {
  const generation = requireGeneration(generationHandle);
  generation.cancelled = true;
  if (generation.cancelFlag) {
    Atomics.store(generation.cancelFlag, 0, 1);
  }
  generation.model.backend.cancel();
  wake(generation);
}

function pushEvent(generation: GenerationSession, event: TokenEvent): void {
  generation.events.push(event);
  wake(generation);
}

function wake(generation: GenerationSession): void {
  const waiters = generation.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function createBackend(runtime: ResolvedRuntime): Backend {
  if (runtime === 'cpu') {
    return new WasmCPUBackend(modelCache, self, (generationHandle, event) => {
      self.postMessage({ type: 'tokenEvent', generationHandle, event });
    });
  }
  throw new WebUnsupportedRuntimeError('WebGPU backend is not available in this build.');
}

function requireModel(handle: string): ModelSession {
  const model = models.get(handle);
  if (!model) {
    throw new Error(`BITNET_MODEL_NOT_FOUND: invalid model handle ${handle}`);
  }
  return model;
}

function requireGeneration(handle: string): GenerationSession {
  const generation = generations.get(handle);
  if (!generation) {
    throw new Error(`BITNET_MODEL_NOT_FOUND: invalid generation handle ${handle}`);
  }
  return generation;
}

export {};
