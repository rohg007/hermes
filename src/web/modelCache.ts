import { errorMessage, webLog } from './diagnostics';
import type { CachedModel, DownloadProgressState } from './workerTypes';

type DownloadRequest = {
  id: string;
  url: string;
  fileName: string;
  source?: string;
  checksumSha256?: string;
};

type DownloadJob = {
  progress: DownloadProgressState;
  promise: Promise<CachedModel>;
  cancel: AbortController;
};

const WEB_CACHE_DB_NAME = 'bitnet-rn-web-cache';
const WEB_CACHE_DB_VERSION = 1;
const MODEL_STORE = 'models';
const BLOB_STORE = 'modelBlobs';

export class WebModelCache {
  private readonly downloads = new Map<string, DownloadJob>();
  private readonly modelRegistry = new Map<string, CachedModel>();
  private readonly modelBlobs = new Map<string, Blob>();
  private readonly workerFsMounts = new Set<string>();
  private cacheDbPromise: Promise<IDBDatabase | undefined> | undefined;
  private cacheReadyPromise: Promise<void> | undefined;
  private nextDownloadId = 1;

  constructor(private readonly scope: { indexedDB?: IDBFactory; crypto?: Crypto }) {}

  async startDownload(requestJson: string): Promise<string> {
    await this.ensureReady();
    const request = JSON.parse(requestJson) as DownloadRequest;
    const jobId = `web-download-${this.nextDownloadId++}`;
    const controller = new AbortController();
    const existing = this.modelRegistry.get(request.id);
    const existingBlobAvailable = existing
      ? this.modelBlobs.has(existing.path) || (await this.hasCachedModelBlob(existing.path))
      : false;
    const progress: DownloadProgressState = {
      jobId,
      modelId: request.id,
      receivedBytes: existing?.sizeBytes ?? 0,
      totalBytes: existing?.sizeBytes,
      status: existing && existingBlobAvailable ? 'completed' : 'queued',
    };

    if (existing && !existingBlobAvailable) {
      this.modelRegistry.delete(existing.id);
      void this.deleteCachedModel(existing).catch((error) => {
        console.warn(`[BitNet Web] failed to remove stale cached model ${existing.id}: ${errorMessage(error)}`);
      });
    }

    const promise =
      existing && existingBlobAvailable
        ? Promise.resolve(existing)
        : this.download(request, progress, controller).catch((error) => {
            progress.status = controller.signal.aborted ? 'cancelled' : 'failed';
            progress.error = errorMessage(error);
            throw error;
          });
    this.downloads.set(jobId, { progress, promise, cancel: controller });
    return jobId;
  }

  downloadProgress(jobHandle: string): DownloadProgressState {
    const job = this.downloads.get(jobHandle);
    if (!job) {
      throw new Error(`BITNET_INVALID_ARGUMENT: unknown download job ${jobHandle}`);
    }
    if (job.progress.status === 'failed' || job.progress.status === 'cancelled') {
      void job.promise.catch(() => undefined);
      this.downloads.delete(jobHandle);
    }
    return job.progress;
  }

  async awaitDownload(jobHandle: string): Promise<CachedModel> {
    const job = this.downloads.get(jobHandle);
    if (!job) {
      throw new Error(`BITNET_INVALID_ARGUMENT: unknown download job ${jobHandle}`);
    }
    try {
      return await job.promise;
    } finally {
      this.downloads.delete(jobHandle);
    }
  }

  cancelDownload(jobHandle: string): void {
    const job = this.downloads.get(jobHandle);
    if (job) {
      job.cancel.abort();
      job.progress.status = 'cancelled';
      void job.promise.catch(() => undefined);
      this.downloads.delete(jobHandle);
    }
  }

  async deleteModel(modelId: string): Promise<boolean> {
    await this.ensureReady();
    const model = this.modelRegistry.get(modelId);
    if (!model) {
      return false;
    }
    if (model.path.startsWith('blob:')) {
      URL.revokeObjectURL(model.path);
    }
    this.modelBlobs.delete(model.path);
    this.modelRegistry.delete(modelId);
    await this.deleteCachedModel(model);
    return true;
  }

  async listCachedModels(): Promise<CachedModel[]> {
    await this.ensureReady();
    return [...this.modelRegistry.values()];
  }

  async diskUsage(): Promise<number> {
    await this.ensureReady();
    return [...this.modelRegistry.values()].reduce((sum, model) => sum + model.sizeBytes, 0);
  }

  async ensureReady(): Promise<void> {
    if (this.cacheReadyPromise) {
      return this.cacheReadyPromise;
    }
    this.cacheReadyPromise = (async () => {
      const db = await this.openCacheDb().catch((error) => {
        console.warn(`[BitNet Web] browser model cache is unavailable: ${errorMessage(error)}`);
        return undefined;
      });
      if (!db) {
        return;
      }

      const cachedModels = await this.getAllCachedModels(db).catch((error) => {
        console.warn(`[BitNet Web] failed to read browser model cache: ${errorMessage(error)}`);
        return [];
      });
      for (const model of cachedModels) {
        this.modelRegistry.set(model.id, model);
      }
      if (cachedModels.length > 0) {
        webLog(`hydrated ${cachedModels.length} cached web model${cachedModels.length === 1 ? '' : 's'}`);
      }
    })();
    return this.cacheReadyPromise;
  }

  async materializeModelFile(module: any, path: string): Promise<void> {
    let blob = this.modelBlobs.get(path);
    if (!blob) {
      blob = await this.readCachedModelBlob(path);
      if (blob) {
        this.modelBlobs.set(path, blob);
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
      if (!this.workerFsMounts.has(modelDir)) {
        webLog(`mounting model through WORKERFS at ${modelDir}`);
        fs.mount(workerFs, { blobs: [{ name: fileName, data: blob }] }, modelDir);
        this.workerFsMounts.add(modelDir);
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

  private async download(
    request: DownloadRequest,
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
    const checksumSha256 = await this.validateChecksum(blob, request.checksumSha256, request.id);
    const fileName = sanitizePathSegment(request.fileName || request.id);
    const path = `/models/${sanitizePathSegment(request.id)}/${fileName}`;
    this.modelBlobs.set(path, blob);
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
    this.modelRegistry.set(request.id, cached);
    const persisted = await this.persistCachedModel(cached, blob).catch((error) => {
      console.warn(`[BitNet Web] model downloaded but could not be persisted for reloads: ${errorMessage(error)}`);
      return false;
    });
    if (persisted) {
      webLog(`cached model ${cached.id} in browser storage`);
    }
    progress.status = 'completed';
    return cached;
  }

  private async validateChecksum(
    blob: Blob,
    expected: string | undefined,
    modelId: string
  ): Promise<string | undefined> {
    const normalizedExpected = normalizeSha256(expected);
    if (!normalizedExpected) {
      return undefined;
    }

    const subtle = this.scope.crypto?.subtle;
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

  private async openCacheDb(): Promise<IDBDatabase | undefined> {
    const idb = this.scope.indexedDB;
    if (!idb) {
      return undefined;
    }
    if (this.cacheDbPromise) {
      return this.cacheDbPromise;
    }

    this.cacheDbPromise = new Promise((resolve, reject) => {
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

    return this.cacheDbPromise;
  }

  private async getAllCachedModels(db: IDBDatabase): Promise<CachedModel[]> {
    const transaction = db.transaction(MODEL_STORE, 'readonly');
    const models = await idbRequest<CachedModel[]>(transaction.objectStore(MODEL_STORE).getAll());
    await idbTransactionDone(transaction);
    return models;
  }

  private async hasCachedModelBlob(path: string): Promise<boolean> {
    const db = await this.openCacheDb();
    if (!db) {
      return false;
    }
    const transaction = db.transaction(BLOB_STORE, 'readonly');
    const count = await idbRequest<number>(transaction.objectStore(BLOB_STORE).count(path));
    await idbTransactionDone(transaction);
    return count > 0;
  }

  private async readCachedModelBlob(path: string): Promise<Blob | undefined> {
    const db = await this.openCacheDb();
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

  private async persistCachedModel(model: CachedModel, blob: Blob): Promise<boolean> {
    const db = await this.openCacheDb();
    if (!db) {
      return false;
    }
    const transaction = db.transaction([MODEL_STORE, BLOB_STORE], 'readwrite');
    transaction.objectStore(MODEL_STORE).put(model);
    transaction.objectStore(BLOB_STORE).put({ path: model.path, blob });
    await idbTransactionDone(transaction);
    return true;
  }

  private async deleteCachedModel(model: CachedModel): Promise<void> {
    const db = await this.openCacheDb();
    if (!db) {
      return;
    }
    const transaction = db.transaction([MODEL_STORE, BLOB_STORE], 'readwrite');
    transaction.objectStore(MODEL_STORE).delete(model.id);
    transaction.objectStore(BLOB_STORE).delete(model.path);
    await idbTransactionDone(transaction);
  }
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
