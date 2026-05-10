import { errorMessage, setWebDiagnosticsEnabled, webLog, webNativeLog, withTimeout } from './diagnostics';
import {
  WebUnsupportedRuntimeError,
  configureWebRuntime,
  detectWebRuntimeCapabilities,
  selectWebRuntime,
  type WebResolvedRuntime as ResolvedRuntime,
  type WebRuntime as Runtime,
} from './runtime';

type GenerationConfig = {
  prompt: string;
  systemPrompt?: string;
  chatTemplate?: string;
  useChatTemplate?: boolean;
  temperature: number;
  topK: number;
  topP: number;
  maxTokens: number;
  seed: number;
  repeatPenalty?: number;
};

type Metrics = {
  modelId: string;
  runtimeUsed: ResolvedRuntime;
  promptTokens?: number;
  generatedTokens: number;
  tokensPerSecond: number;
  latencyMs: number;
  memoryUsageMB: number;
  threadCount: number;
};

type LoadOptions = {
  id?: string;
  runtime?: Runtime;
  contextSize?: number;
  threads?: number;
  keepInMemory?: boolean;
};

type TokenEvent =
  | { type: 'token'; text: string }
  | { type: 'warning'; warning: string }
  | { type: 'metrics'; metrics: Metrics }
  | { type: 'end' }
  | { type: 'cancelled'; error?: string }
  | { type: 'error'; error: string };

interface Backend {
  loadModel(path: string, options?: LoadOptions): Promise<void>;
  generate(config: GenerationConfig): AsyncIterable<string>;
  cancel(): void;
  getMetrics(): Metrics;
  unload(): void;
}

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

type CachedModel = {
  id: string;
  path: string;
  source: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
};

type DownloadProgressState = {
  jobId: string;
  modelId: string;
  receivedBytes: number;
  totalBytes?: number;
  status: 'queued' | 'downloading' | 'validating' | 'completed' | 'cancelled' | 'failed';
  error?: string;
};

declare const self: any;

const models = new Map<string, ModelSession>();
const generations = new Map<string, GenerationSession>();
const downloads = new Map<string, { progress: DownloadProgressState; promise: Promise<CachedModel>; cancel: AbortController }>();
const modelRegistry = new Map<string, CachedModel>();
const modelBlobs = new Map<string, Blob>();
const workerFsMounts = new Set<string>();
let wasmModuleUrl: string | undefined = '/bitnet_wasm.js';
let wasmModulePromise: Promise<any> | undefined;
let cacheDbPromise: Promise<IDBDatabase | undefined> | undefined;
let cacheReadyPromise: Promise<void> | undefined;
let nextModelId = 1;
let nextGenerationId = 1;
let nextDownloadId = 1;
const NATIVE_ERROR_HANDLE_PREFIX = '__BITNET_ERROR__:';
const WEB_CACHE_DB_NAME = 'bitnet-rn-web-cache';
const WEB_CACHE_DB_VERSION = 1;
const MODEL_STORE = 'models';
const BLOB_STORE = 'modelBlobs';

class WasmCPUBackend implements Backend {
  private module: any;
  private handle: string | undefined;
  private generationHandle: string | undefined;
  private cancelled = false;
  private metrics: Metrics = baseMetrics('cpu');

  async loadModel(path: string, options: LoadOptions = {}): Promise<void> {
    webLog(`loadModel start path=${path}`);
    this.module = await withTimeout(
      loadWasmModule(),
      45_000,
      'BITNET_NATIVE_UNAVAILABLE: BitNet WASM module initialization timed out. Restart `yarn web`; the example builds bitnet_wasm.js and bitnet_wasm.wasm automatically when they are missing.'
    );
    webLog('WASM module ready');
    await materializeModelFile(this.module, path);
    webLog(`model file ready path=${path}`);
    if (typeof this.module.loadModelJson === 'function') {
      webLog('calling native loadModelJson');
      const response = JSON.parse(
        this.module.loadModelJson(
          path,
          options.id ?? path,
          'cpu',
          options.contextSize ?? 2048,
          options.threads ?? 1,
          options.keepInMemory ?? true
        )
      );
      webLog('native loadModelJson returned');
      throwIfNativeJsonError(response);
      this.handle = response.handle;
      webLog(`native model handle=${this.handle}`);
      return;
    }
    if (typeof this.module.loadModel === 'function') {
      this.handle = await this.module.loadModel(path, { runtime: 'cpu' });
      return;
    }
    throw new Error('BITNET_NATIVE_UNAVAILABLE: BitNet WASM module does not expose a supported model loader.');
  }

  async *generate(config: GenerationConfig): AsyncIterable<string> {
    if (!this.module || !this.handle) {
      throw new Error('BITNET_MODEL_NOT_FOUND: Web WASM model is not loaded.');
    }
    this.cancelled = false;
    const startedAt = performance.now();
    let generated = 0;

    if (typeof this.module.startGenerationJson === 'function') {
      this.generationHandle = this.module.startGenerationJson(
        this.handle,
        config.prompt,
        config.systemPrompt ?? '',
        config.chatTemplate ?? '',
        config.temperature,
        config.topK,
        config.topP,
        config.maxTokens,
        config.seed,
        config.repeatPenalty ?? 1.1,
        Boolean(config.useChatTemplate)
      );
      if (typeof this.generationHandle === 'string' && this.generationHandle.startsWith(NATIVE_ERROR_HANDLE_PREFIX)) {
        throw new Error(this.generationHandle.slice(NATIVE_ERROR_HANDLE_PREFIX.length));
      }
      while (true) {
        const events = JSON.parse(this.module.nextTokenBatchJson(this.generationHandle, 8, 25)) as TokenEvent[];
        for (const event of events) {
          if (event.type === 'token') {
            if (this.cancelled) {
              return;
            }
            generated += 1;
            yield event.text;
          } else if (event.type === 'metrics') {
            this.metrics = event.metrics;
          } else if (event.type === 'end') {
            this.generationHandle = undefined;
            return;
          } else if (event.type === 'error') {
            throw new Error(event.error);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } else if (typeof this.module.generate === 'function') {
      const iterator = this.module.generate(this.handle, config);
      for await (const token of iterator) {
        if (this.cancelled) {
          return;
        }
        generated += 1;
        yield String(token);
      }
    } else {
      throw new Error('BITNET_NATIVE_UNAVAILABLE: BitNet WASM module does not expose a supported generator.');
    }

    const latencyMs = Math.max(1, performance.now() - startedAt);
    this.metrics = {
      modelId: this.handle,
      runtimeUsed: 'cpu',
      generatedTokens: generated,
      tokensPerSecond: generated / (latencyMs / 1000),
      latencyMs,
      memoryUsageMB: estimateWebMemoryMB(),
      threadCount: currentWebThreadCount(),
    };
  }

  generateBlocking(config: GenerationConfig, generationHandle: string, cancelFlag?: Int32Array): void {
    if (!this.module || !this.handle) {
      throw new Error('BITNET_MODEL_NOT_FOUND: Web WASM model is not loaded.');
    }
    if (typeof this.module.generateBlockingJson !== 'function') {
      throw new Error('BITNET_NATIVE_UNAVAILABLE: BitNet WASM module does not expose the web streaming generator.');
    }

    this.cancelled = false;
    const response = JSON.parse(
      this.module.generateBlockingJson(
        this.handle,
        config.prompt,
        config.systemPrompt ?? '',
        config.chatTemplate ?? '',
        config.temperature,
        config.topK,
        config.topP,
        config.maxTokens,
        config.seed,
        config.repeatPenalty ?? 1.1,
        Boolean(config.useChatTemplate),
        (eventsJson: string) => {
          const events = JSON.parse(eventsJson) as TokenEvent[];
          for (const event of events) {
            if (event.type === 'metrics') {
              this.metrics = event.metrics;
            }
            self.postMessage({ type: 'tokenEvent', generationHandle, event });
          }
          return !this.cancelled && (!cancelFlag || Atomics.load(cancelFlag, 0) === 0);
        }
      )
    );
    throwIfNativeJsonError(response);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.module && this.generationHandle && typeof this.module.cancelGenerationJson === 'function') {
      this.module.cancelGenerationJson(this.generationHandle);
    }
    if (this.module && this.handle && typeof this.module.cancel === 'function') {
      this.module.cancel(this.handle);
    }
  }

  getMetrics(): Metrics {
    return this.metrics;
  }

  unload(): void {
    if (this.module && this.handle && typeof this.module.unloadModel === 'function') {
      this.module.unloadModel(this.handle);
    } else if (this.module && this.handle && typeof this.module.unloadModelJson === 'function') {
      this.module.unloadModelJson(this.handle);
    }
    this.handle = undefined;
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data)
    .then((result) => self.postMessage({ id: event.data.id, ok: true, result }))
    .catch((error) => self.postMessage({ id: event.data.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
};

async function handleRequest(request: WorkerRequest): Promise<string | boolean | number | null> {
  const payload = request.payload ?? {};
  switch (request.method) {
    case 'configure':
      wasmModuleUrl = typeof payload.wasmModuleUrl === 'string' ? payload.wasmModuleUrl : '/bitnet_wasm.js';
      setWebDiagnosticsEnabled(Boolean(payload.webDebug));
      configureWebRuntime({
        webThreads: Boolean(payload.webThreads),
        webThreadCount: typeof payload.webThreadCount === 'number' ? payload.webThreadCount : undefined,
      });
      wasmModulePromise = undefined;
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
      return startDownload(String(payload.requestJson));
    case 'getDownloadProgress':
      return JSON.stringify(downloadProgress(String(payload.jobHandle)));
    case 'awaitDownload':
      return JSON.stringify(await awaitDownload(String(payload.jobHandle)));
    case 'cancelDownload':
      cancelDownload(String(payload.jobHandle));
      return null;
    case 'listModels':
      return JSON.stringify(await listCachedModels());
    case 'deleteModel':
      return deleteModel(String(payload.modelId));
    case 'getDiskUsage':
      return diskUsage();
    default:
      throw new Error(`Unknown BitNet web worker method: ${request.method}`);
  }
}

async function loadModel(modelPath: string, optionsJson: string) {
  await ensureWebCacheReady();
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
    return new WasmCPUBackend();
  }
  throw new WebUnsupportedRuntimeError('WebGPU backend is not available in this build.');
}

function throwIfNativeJsonError(response: unknown): void {
  if (response && typeof response === 'object' && 'error' in response) {
    const nativeError = (response as { error?: unknown }).error;
    if (typeof nativeError === 'string' && nativeError.length > 0) {
      throw new Error(nativeError);
    }
  }
}

async function loadWasmModule(): Promise<any> {
  if (wasmModulePromise) {
    webLog('reusing WASM module promise');
    return wasmModulePromise;
  }
  const globalModule = (self as any).BitNetWasm;
  if (globalModule) {
    webLog('using global BitNetWasm module');
    wasmModulePromise = Promise.resolve(typeof globalModule === 'function' ? globalModule() : globalModule);
    return wasmModulePromise;
  }
  if (wasmModuleUrl) {
    webLog(`loading WASM module from ${wasmModuleUrl}`);
    wasmModulePromise = instantiateWasmModuleFromAsset(wasmModuleUrl).catch((error: unknown) => {
        wasmModulePromise = undefined;
        throw new Error(
          `BITNET_NATIVE_UNAVAILABLE: BitNet WASM module could not be loaded from ${wasmModuleUrl}. ` +
            `Restart \`yarn web\` so the example can build it, or call configureBitNetWeb({ wasmModuleUrl }) in a custom app. ` +
            `Reason: ${errorMessage(error)}`
        );
      });
    return wasmModulePromise;
  }
  throw new Error(
    'BITNET_NATIVE_UNAVAILABLE: BitNet WASM module is not installed. Run `yarn web` in the example, or place bitnet_wasm.js in your web public directory.'
  );
}

async function instantiateWasmModuleFromAsset(moduleUrl: string): Promise<any> {
  const loaderUrl = new URL(moduleUrl, self.location.href).toString();
  webLog(`fetching WASM loader ${loaderUrl}`);
  const response = await fetch(loaderUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${loaderUrl}`);
  }

  webLog('WASM loader fetched');
  const factory = await loadWasmFactory(loaderUrl, await response.text());
  webLog('creating WASM module');
  const module = await factory({
    mainScriptUrlOrBlob: loaderUrl,
    print(message: string) {
      webLog(message);
    },
    printErr(message: string) {
      webNativeLog(message);
    },
    monitorRunDependencies(remaining: number) {
      webLog(`WASM run dependencies remaining=${remaining}`);
    },
    onAbort(reason: unknown) {
      console.error(`[BitNet WASM] aborted: ${String(reason)}`);
    },
    locateFile(path: string) {
      return new URL(path, loaderUrl).toString();
    },
  });
  webLog('WASM module created');
  return module;
}

async function loadWasmFactory(loaderUrl: string, source: string): Promise<(options?: Record<string, unknown>) => any> {
  try {
    const module = await import(/* @vite-ignore */ loaderUrl);
    const factory = (module as any).default ?? (module as any).createBitNetWasmModule;
    if (typeof factory === 'function') {
      return factory;
    }
  } catch {
    // Some app servers may block direct module imports from public assets. Fall
    // back to evaluating the fetched source while preserving mainScriptUrlOrBlob
    // above so Emscripten can resolve sibling WASM assets from the real URL.
  }

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const module = await import(/* @vite-ignore */ blobUrl);
    const factory = (module as any).default ?? (module as any).createBitNetWasmModule;
    if (typeof factory === 'function') {
      return factory;
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const factory = new Function(
    `${source}\nreturn typeof createBitNetWasmModule === "function" ? createBitNetWasmModule : undefined;\n//# sourceURL=${loaderUrl}`
  )();
  if (typeof factory !== 'function') {
    throw new Error(`No createBitNetWasmModule factory exported by ${loaderUrl}`);
  }
  return factory;
}

function baseMetrics(runtimeUsed: ResolvedRuntime): Metrics {
  return {
    modelId: '',
    runtimeUsed,
    generatedTokens: 0,
    tokensPerSecond: 0,
    latencyMs: 0,
    memoryUsageMB: estimateWebMemoryMB(),
    threadCount: currentWebThreadCount(),
  };
}

function currentWebThreadCount(): number {
  return detectWebRuntimeCapabilities(self).cpu.threadCount;
}

function estimateWebMemoryMB(): number {
  const memory = (performance as any).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / 1024 / 1024 : 0;
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

async function startDownload(requestJson: string): Promise<string> {
  await ensureWebCacheReady();
  const request = JSON.parse(requestJson) as {
    id: string;
    url: string;
    fileName: string;
    source?: string;
    checksumSha256?: string;
  };
  const jobId = `web-download-${nextDownloadId++}`;
  const controller = new AbortController();
  const existing = modelRegistry.get(request.id);
  const existingBlobAvailable = existing
    ? modelBlobs.has(existing.path) || await hasCachedModelBlob(existing.path)
    : false;
  const progress: DownloadProgressState = {
    jobId,
    modelId: request.id,
    receivedBytes: existing?.sizeBytes ?? 0,
    totalBytes: existing?.sizeBytes,
    status: existing && existingBlobAvailable ? 'completed' : 'queued',
  };

  if (existing && !existingBlobAvailable) {
    modelRegistry.delete(existing.id);
    void deleteCachedModel(existing).catch((error) => {
      console.warn(`[BitNet Web] failed to remove stale cached model ${existing.id}: ${errorMessage(error)}`);
    });
  }

  const promise =
    existing && existingBlobAvailable
      ? Promise.resolve(existing)
      : download(request, progress, controller).catch((error) => {
          progress.status = controller.signal.aborted ? 'cancelled' : 'failed';
          progress.error = errorMessage(error);
          throw error;
        });
  downloads.set(jobId, { progress, promise, cancel: controller });
  return jobId;
}

async function download(
  request: { id: string; url: string; fileName: string; source?: string; checksumSha256?: string },
  progress: DownloadProgressState,
  controller: AbortController
): Promise<CachedModel> {
  progress.status = 'downloading';
  const response = await fetch(request.url, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`BITNET_DOWNLOAD_FAILED: HTTP ${response.status} while downloading ${request.url}`);
  }
  const total = response.headers.get('Content-Length');
  progress.totalBytes = total ? Number(total) : undefined;
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
    progress.receivedBytes += value.byteLength;
  }
  progress.status = 'validating';
  const blob = new Blob(chunks);
  const checksumSha256 = await validateChecksum(blob, request.checksumSha256, request.id);
  const fileName = sanitizePathSegment(request.fileName || request.id);
  const path = `/models/${sanitizePathSegment(request.id)}/${fileName}`;
  modelBlobs.set(path, blob);
  const now = new Date().toISOString();
  const cached = {
    id: request.id,
    path,
    source: request.source ?? request.url,
    fileName: request.fileName,
    sizeBytes: blob.size,
    checksumSha256,
    createdAt: now,
    updatedAt: now,
  };
  modelRegistry.set(request.id, cached);
  const persisted = await persistCachedModel(cached, blob).catch((error) => {
    console.warn(`[BitNet Web] model downloaded but could not be persisted for reloads: ${errorMessage(error)}`);
    return false;
  });
  if (persisted) {
    webLog(`cached model ${cached.id} in browser storage`);
  }
  progress.status = 'completed';
  return cached;
}

function downloadProgress(jobHandle: string): any {
  const job = downloads.get(jobHandle);
  if (!job) {
    throw new Error(`BITNET_INVALID_ARGUMENT: unknown download job ${jobHandle}`);
  }
  if (job.progress.status === 'failed' || job.progress.status === 'cancelled') {
    void job.promise.catch(() => undefined);
    downloads.delete(jobHandle);
  }
  return job.progress;
}

async function validateChecksum(blob: Blob, expected: string | undefined, modelId: string): Promise<string | undefined> {
  const normalizedExpected = normalizeSha256(expected);
  if (!normalizedExpected) {
    return undefined;
  }

  const subtle = self.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      `BITNET_CHECKSUM_MISMATCH: SHA-256 validation is unavailable in this browser worker for ${modelId}.`
    );
  }

  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = bytesToHex(new Uint8Array(digest));
  if (actual !== normalizedExpected) {
    throw new Error(`BITNET_CHECKSUM_MISMATCH: expected ${normalizedExpected} but got ${actual}`);
  }
  return actual;
}

function normalizeSha256(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`BITNET_CHECKSUM_MISMATCH: expected SHA-256 value is invalid: ${value}`);
  }
  return normalized;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function awaitDownload(jobHandle: string): Promise<CachedModel> {
  const job = downloads.get(jobHandle);
  if (!job) {
    throw new Error(`BITNET_INVALID_ARGUMENT: unknown download job ${jobHandle}`);
  }
  try {
    return await job.promise;
  } finally {
    downloads.delete(jobHandle);
  }
}

function cancelDownload(jobHandle: string): void {
  const job = downloads.get(jobHandle);
  if (job) {
    job.cancel.abort();
    job.progress.status = 'cancelled';
    void job.promise.catch(() => undefined);
    downloads.delete(jobHandle);
  }
}

async function deleteModel(modelId: string): Promise<boolean> {
  await ensureWebCacheReady();
  const model = modelRegistry.get(modelId);
  if (!model) {
    return false;
  }
  if (model.path.startsWith('blob:')) {
    URL.revokeObjectURL(model.path);
  }
  modelBlobs.delete(model.path);
  modelRegistry.delete(modelId);
  await deleteCachedModel(model);
  return true;
}

async function listCachedModels(): Promise<CachedModel[]> {
  await ensureWebCacheReady();
  return [...modelRegistry.values()];
}

async function diskUsage(): Promise<number> {
  await ensureWebCacheReady();
  return [...modelRegistry.values()].reduce((sum, model) => sum + model.sizeBytes, 0);
}

async function ensureWebCacheReady(): Promise<void> {
  if (cacheReadyPromise) {
    return cacheReadyPromise;
  }
  cacheReadyPromise = (async () => {
    const db = await openCacheDb().catch((error) => {
      console.warn(`[BitNet Web] browser model cache is unavailable: ${errorMessage(error)}`);
      return undefined;
    });
    if (!db) {
      return;
    }

    const cachedModels = await getAllCachedModels(db).catch((error) => {
      console.warn(`[BitNet Web] failed to read browser model cache: ${errorMessage(error)}`);
      return [];
    });
    for (const model of cachedModels) {
      modelRegistry.set(model.id, model);
    }
    if (cachedModels.length > 0) {
      webLog(`hydrated ${cachedModels.length} cached web model${cachedModels.length === 1 ? '' : 's'}`);
    }
  })();
  return cacheReadyPromise;
}

async function openCacheDb(): Promise<IDBDatabase | undefined> {
  const idb = (self as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return undefined;
  }
  if (cacheDbPromise) {
    return cacheDbPromise;
  }

  cacheDbPromise = new Promise((resolve, reject) => {
    const request = idb.open(WEB_CACHE_DB_NAME, WEB_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODEL_STORE)) {
        db.createObjectStore(MODEL_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: 'path' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another open BitNet tab'));
  });

  return cacheDbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function getAllCachedModels(db: IDBDatabase): Promise<CachedModel[]> {
  const transaction = db.transaction(MODEL_STORE, 'readonly');
  const models = await idbRequest<CachedModel[]>(transaction.objectStore(MODEL_STORE).getAll());
  await idbTransactionDone(transaction);
  return models;
}

async function hasCachedModelBlob(path: string): Promise<boolean> {
  const db = await openCacheDb();
  if (!db) {
    return false;
  }
  const transaction = db.transaction(BLOB_STORE, 'readonly');
  const count = await idbRequest<number>(transaction.objectStore(BLOB_STORE).count(path));
  await idbTransactionDone(transaction);
  return count > 0;
}

async function readCachedModelBlob(path: string): Promise<Blob | undefined> {
  const db = await openCacheDb();
  if (!db) {
    return undefined;
  }
  const transaction = db.transaction(BLOB_STORE, 'readonly');
  const stored = await idbRequest<{ path: string; blob: Blob } | undefined>(
    transaction.objectStore(BLOB_STORE).get(path)
  );
  await idbTransactionDone(transaction);
  return stored?.blob;
}

async function persistCachedModel(model: CachedModel, blob: Blob): Promise<boolean> {
  const db = await openCacheDb();
  if (!db) {
    return false;
  }
  const transaction = db.transaction([MODEL_STORE, BLOB_STORE], 'readwrite');
  transaction.objectStore(MODEL_STORE).put(model);
  transaction.objectStore(BLOB_STORE).put({ path: model.path, blob });
  await idbTransactionDone(transaction);
  return true;
}

async function deleteCachedModel(model: CachedModel): Promise<void> {
  const db = await openCacheDb();
  if (!db) {
    return;
  }
  const transaction = db.transaction([MODEL_STORE, BLOB_STORE], 'readwrite');
  transaction.objectStore(MODEL_STORE).delete(model.id);
  transaction.objectStore(BLOB_STORE).delete(model.path);
  await idbTransactionDone(transaction);
}

async function materializeModelFile(module: any, path: string): Promise<void> {
  let blob = modelBlobs.get(path);
  if (!blob) {
    blob = await readCachedModelBlob(path);
    if (blob) {
      modelBlobs.set(path, blob);
      webLog(`restored cached model blob for ${path}`);
    }
  }
  if (!blob) {
    throw new Error(
      `BITNET_MODEL_NOT_FOUND: downloaded model data is not available for ${path}. Download the model again.`
    );
  }
  webLog(`materializing model path=${path} sizeMB=${(blob.size / 1024 / 1024).toFixed(1)}`);

  const fs = module?.FS;
  if (!fs || typeof fs.writeFile !== 'function') {
    throw new Error(
      'BITNET_NATIVE_UNAVAILABLE: BitNet WASM module does not expose the Emscripten filesystem. Restart `yarn web` so the example can rebuild the WASM runtime.'
    );
  }

  if (typeof fs.analyzePath === 'function' && fs.analyzePath(path).exists) {
    webLog('model already exists in WASM filesystem');
    return;
  }

  const modelDir = path.slice(0, path.lastIndexOf('/')) || '/models';
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const workerFs = fs.filesystems?.WORKERFS;

  if (workerFs && typeof fs.mount === 'function') {
    ensureDirectory(fs, modelDir);
    if (!workerFsMounts.has(modelDir)) {
      webLog(`mounting model through WORKERFS at ${modelDir}`);
      fs.mount(workerFs, { blobs: [{ name: fileName, data: blob }] }, modelDir);
      workerFsMounts.add(modelDir);
    }
    if (typeof fs.analyzePath !== 'function' || fs.analyzePath(path).exists) {
      webLog('WORKERFS mount ready');
      return;
    }
    throw new Error(`BITNET_RUNTIME_ERROR: failed to mount downloaded model at ${path}`);
  }

  ensureDirectory(fs, modelDir);
  webLog('WORKERFS unavailable; copying model into MEMFS');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  fs.writeFile(path, bytes);

  if (typeof fs.analyzePath === 'function' && !fs.analyzePath(path).exists) {
    throw new Error(`BITNET_RUNTIME_ERROR: failed to materialize downloaded model at ${path}`);
  }
}

function ensureDirectory(fs: any, path: string): void {
  if (typeof fs.analyzePath === 'function' && fs.analyzePath(path).exists) {
    return;
  }
  if (typeof fs.mkdirTree === 'function') {
    fs.mkdirTree(path);
    return;
  }
  if (typeof fs.mkdir === 'function') {
    const segments = path.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      try {
        fs.mkdir(current);
      } catch {
        // Directory may already exist.
      }
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export {};
