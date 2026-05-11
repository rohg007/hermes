import { errorMessage, webLog, webNativeLog, withTimeout } from './diagnostics';
import { detectWebRuntimeCapabilities, type WebResolvedRuntime as ResolvedRuntime } from './runtime';
import type { WebModelCache } from './modelCache';
import type { Backend, GenerationConfig, LoadOptions, Metrics, TokenEvent } from './workerTypes';

type WorkerScope = {
  BitNetWasm?: unknown;
  crossOriginIsolated?: boolean;
  location: Location;
  navigator?: unknown;
};

type TokenEventEmitter = (generationHandle: string, event: TokenEvent) => void;

const NATIVE_ERROR_HANDLE_PREFIX = '__BITNET_ERROR__:';

let wasmModuleUrl: string | undefined = '/bitnet_wasm.js';
let wasmModulePromise: Promise<any> | undefined;

export function configureWasmLoader(url: string | undefined): void {
  wasmModuleUrl = url ?? '/bitnet_wasm.js';
  wasmModulePromise = undefined;
}

export class WasmCPUBackend implements Backend {
  private module: any;
  private handle: string | undefined;
  private generationHandle: string | undefined;
  private cancelled = false;
  private metrics: Metrics;

  constructor(
    private readonly cache: WebModelCache,
    private readonly scope: WorkerScope,
    private readonly emitTokenEvent: TokenEventEmitter
  ) {
    this.metrics = baseMetrics('cpu', scope);
  }

  async loadModel(path: string, options: LoadOptions = {}): Promise<void> {
    webLog(`loadModel start path=${path}`);
    this.module = await withTimeout(
      loadWasmModule(this.scope),
      45_000,
      'BITNET_NATIVE_UNAVAILABLE: BitNet WASM module initialization timed out. Restart `yarn web`; the example builds bitnet_wasm.js and bitnet_wasm.wasm automatically when they are missing.'
    );
    webLog('WASM module ready');
    await this.cache.materializeModelFile(this.module, path);
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
      threadCount: currentWebThreadCount(this.scope),
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
            this.emitTokenEvent(generationHandle, event);
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

function throwIfNativeJsonError(response: unknown): void {
  if (response && typeof response === 'object' && 'error' in response) {
    const nativeError = (response as { error?: unknown }).error;
    if (typeof nativeError === 'string' && nativeError.length > 0) {
      throw new Error(nativeError);
    }
  }
}

async function loadWasmModule(scope: WorkerScope): Promise<any> {
  if (wasmModulePromise) {
    webLog('reusing WASM module promise');
    return wasmModulePromise;
  }
  const globalModule = scope.BitNetWasm;
  if (globalModule) {
    webLog('using global BitNetWasm module');
    wasmModulePromise = Promise.resolve(typeof globalModule === 'function' ? globalModule() : globalModule);
    return wasmModulePromise;
  }
  if (wasmModuleUrl) {
    webLog(`loading WASM module from ${wasmModuleUrl}`);
    wasmModulePromise = instantiateWasmModuleFromAsset(scope, wasmModuleUrl).catch((error: unknown) => {
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

async function instantiateWasmModuleFromAsset(scope: WorkerScope, moduleUrl: string): Promise<any> {
  const loaderUrl = new URL(moduleUrl, scope.location.href).toString();
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

function baseMetrics(runtimeUsed: ResolvedRuntime, scope: WorkerScope): Metrics {
  return {
    modelId: '',
    runtimeUsed,
    generatedTokens: 0,
    tokensPerSecond: 0,
    latencyMs: 0,
    memoryUsageMB: estimateWebMemoryMB(),
    threadCount: currentWebThreadCount(scope),
  };
}

function currentWebThreadCount(scope: WorkerScope): number {
  return detectWebRuntimeCapabilities(scope).cpu.threadCount;
}

function estimateWebMemoryMB(): number {
  const memory = (performance as any).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize / 1024 / 1024 : 0;
}
