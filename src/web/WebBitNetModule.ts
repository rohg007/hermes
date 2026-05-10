import type { Spec } from '../specs/NativeBitNet';
import { getBitNetConfig } from '../config';

type WorkerResult = string | boolean | number | null;

type PendingRequest = {
  resolve(value: WorkerResult): void;
  reject(error: Error): void;
};

type WorkerMessage =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };

type WorkerMethodMap = {
  configure: {
    payload: { wasmModuleUrl?: string; webDebug?: boolean; webThreads?: boolean; webThreadCount?: number };
    result: null;
  };
  getRuntimeCapabilities: { payload: Record<string, never>; result: string };
  loadModel: { payload: { modelPath: string; optionsJson: string }; result: string };
  unloadModel: { payload: { modelHandle: string }; result: null };
  startGeneration: {
    payload: { modelHandle: string; paramsJson: string; cancelBuffer?: SharedArrayBuffer };
    result: string;
  };
  nextTokenBatch: {
    payload: { generationHandle: string; maxTokens: number; timeoutMs: number };
    result: string;
  };
  cancelGeneration: { payload: { generationHandle: string }; result: null };
  downloadModel: { payload: { requestJson: string }; result: string };
  getDownloadProgress: { payload: { jobHandle: string }; result: string };
  awaitDownload: { payload: { jobHandle: string }; result: string };
  cancelDownload: { payload: { jobHandle: string }; result: null };
  listModels: { payload: Record<string, never>; result: string };
  deleteModel: { payload: { modelId: string }; result: boolean };
  getDiskUsage: { payload: Record<string, never>; result: number };
};

type WorkerMethod = keyof WorkerMethodMap;
type WorkerPayload<Method extends WorkerMethod> = WorkerMethodMap[Method]['payload'];
type WorkerResponse<Method extends WorkerMethod> = WorkerMethodMap[Method]['result'];

type TokenEvent =
  | { type: 'token'; text?: string }
  | { type: 'warning'; warning?: string }
  | { type: 'metrics'; metrics?: unknown }
  | { type: 'end' }
  | { type: 'cancelled'; error?: string }
  | { type: 'error'; error?: string };

type GenerationQueue = {
  events: TokenEvent[];
  waiters: Array<() => void>;
  cancelFlag?: Int32Array;
};

class WebBitNetModuleImpl implements Partial<Spec> {
  private worker?: Worker;
  private nextId = 1;
  private configuredKey = '';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly generationQueues = new Map<string, GenerationQueue>();

  getConstants() {
    return {
      nativeVersion: '0.1.0-web',
      maxConcurrencyPerModel: 1,
    };
  }

  async configure(options: {
    wasmModuleUrl?: string;
    webDebug?: boolean;
    webThreads?: boolean;
    webThreadCount?: number;
  }): Promise<void> {
    const config = getBitNetConfig();
    const wasmModuleUrl = options.wasmModuleUrl ?? config.wasmModuleUrl;
    const webDebug = options.webDebug ?? config.webDebug ?? false;
    const webThreads = options.webThreads ?? config.webThreads ?? false;
    const webThreadCount = options.webThreadCount ?? config.webThreadCount;
    await this.post('configure', { wasmModuleUrl, webDebug, webThreads, webThreadCount });
    this.configuredKey = this.configKey({ wasmModuleUrl, webDebug, webThreads, webThreadCount });
  }

  async getRuntimeCapabilities(): Promise<string> {
    return this.request('getRuntimeCapabilities');
  }

  async loadModel(modelPath: string, optionsJson: string): Promise<string> {
    return this.request('loadModel', { modelPath, optionsJson });
  }

  async unloadModel(modelHandle: string): Promise<void> {
    await this.request('unloadModel', { modelHandle });
  }

  async startGeneration(modelHandle: string, paramsJson: string): Promise<string> {
    const cancelBuffer = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(4) : undefined;
    const generationHandle = await this.request('startGeneration', { modelHandle, paramsJson, cancelBuffer });
    this.generationQueues.set(String(generationHandle), {
      events: [],
      waiters: [],
      cancelFlag: cancelBuffer ? new Int32Array(cancelBuffer) : undefined,
    });
    return String(generationHandle);
  }

  async nextTokenBatch(generationHandle: string, maxTokens: number, timeoutMs: number): Promise<string> {
    const queue = this.generationQueues.get(generationHandle);
    if (queue) {
      if (queue.events.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          queue.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const events = queue.events.splice(0, Math.max(1, maxTokens));
      if (events.some((event) => event.type === 'end' || event.type === 'cancelled' || event.type === 'error')) {
        this.generationQueues.delete(generationHandle);
      }
      return JSON.stringify(events);
    }
    return this.request('nextTokenBatch', { generationHandle, maxTokens, timeoutMs });
  }

  async cancelGeneration(generationHandle: string): Promise<void> {
    const queue = this.generationQueues.get(generationHandle);
    if (queue) {
      if (queue.cancelFlag) {
        Atomics.store(queue.cancelFlag, 0, 1);
      }
      queue.events.push({ type: 'cancelled' });
      this.wakeGeneration(queue);
      return;
    }
    await this.request('cancelGeneration', { generationHandle });
  }

  async downloadModel(requestJson: string): Promise<string> {
    return this.request('downloadModel', { requestJson });
  }

  async getDownloadProgress(jobHandle: string): Promise<string> {
    return this.request('getDownloadProgress', { jobHandle });
  }

  async awaitDownload(jobHandle: string): Promise<string> {
    return this.request('awaitDownload', { jobHandle });
  }

  async cancelDownload(jobHandle: string): Promise<void> {
    await this.request('cancelDownload', { jobHandle });
  }

  async listModels(): Promise<string> {
    return this.request('listModels');
  }

  async deleteModel(modelId: string): Promise<boolean> {
    return this.request('deleteModel', { modelId });
  }

  async getDiskUsage(): Promise<number> {
    return this.request('getDiskUsage');
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(new URL('./bitnet.worker.ts', import.meta.url), {
      type: 'module',
      name: 'bitnet-web-worker',
    });
    worker.onmessage = (event) => {
      if (event.data?.type === 'tokenEvent') {
        this.enqueueTokenEvent(String(event.data.generationHandle), event.data.event as TokenEvent);
        return;
      }
      const pending = this.pending.get(event.data.id);
      if (!pending) {
        return;
      }
      this.pending.delete(event.data.id);
      if (event.data.ok) {
        pending.resolve(event.data.result);
      } else {
        pending.reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(event.message || 'BitNet web worker crashed.'));
      }
      this.pending.clear();
      worker.terminate();
      this.worker = undefined;
    };
    this.worker = worker;
    return worker;
  }

  private async ensureConfigured(): Promise<void> {
    const wasmModuleUrl = getBitNetConfig().wasmModuleUrl;
    const webDebug = getBitNetConfig().webDebug ?? false;
    const webThreads = getBitNetConfig().webThreads ?? false;
    const webThreadCount = getBitNetConfig().webThreadCount;
    const key = this.configKey({ wasmModuleUrl, webDebug, webThreads, webThreadCount });
    if (key === this.configuredKey) {
      return;
    }
    await this.post('configure', { wasmModuleUrl, webDebug, webThreads, webThreadCount });
    this.configuredKey = key;
  }

  private configKey(config: {
    wasmModuleUrl?: string;
    webDebug: boolean;
    webThreads: boolean;
    webThreadCount?: number;
  }): string {
    return JSON.stringify({
      wasmModuleUrl: config.wasmModuleUrl ?? '',
      webDebug: config.webDebug,
      webThreads: config.webThreads,
      webThreadCount: config.webThreadCount ?? 0,
    });
  }

  private async request<Method extends WorkerMethod>(
    method: Method,
    payload: WorkerPayload<Method> = {} as WorkerPayload<Method>
  ): Promise<WorkerResponse<Method>> {
    await this.ensureConfigured();
    return this.post(method, payload);
  }

  private post<Method extends WorkerMethod>(
    method: Method,
    payload: WorkerPayload<Method>
  ): Promise<WorkerResponse<Method>> {
    const id = this.nextId++;
    const worker = this.getWorker();
    return new Promise<WorkerResponse<Method>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: WorkerResult) => void, reject });
      worker.postMessage({ id, method, payload });
    });
  }

  private enqueueTokenEvent(generationHandle: string, event: TokenEvent): void {
    const queue = this.generationQueues.get(generationHandle);
    if (!queue) {
      return;
    }
    queue.events.push(event);
    this.wakeGeneration(queue);
  }

  private wakeGeneration(queue: GenerationQueue): void {
    const waiters = queue.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

export const WebBitNetModule = new WebBitNetModuleImpl();
