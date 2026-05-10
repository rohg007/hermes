import NativeBitNet from './native/NativeBitNet';
import { BitNetModel } from './BitNetModel';
import { configureBitNet, getBitNetConfig, getDefaultRuntime } from './config';
import { DownloadCancelledError, DownloadError, fromNativeError, ModelNotFoundError } from './errors';
import { getBitNetLogger } from './logger';
import {
  RECOMMENDED_BITNET_MODEL,
  downloadRequestMatchesCachedModel,
  modelIdFromSource,
  toDownloadRequest,
} from './modelSource';
import { parseNativeJson, stringifyNativeJson } from './nativeJson';
import type {
  BitNetConfiguration,
  CachedModel,
  DownloadModelOptions,
  DownloadProgress,
  DownloadSource,
  LoadModelOptions,
  BitNetResolvedRuntime,
  RuntimeCapabilities,
} from './types';

const DEFAULT_DOWNLOAD_POLL_MS = 250;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MODEL_ID = modelIdFromSource(RECOMMENDED_BITNET_MODEL);

export { RECOMMENDED_BITNET_MODEL };

type AbortLike = DownloadModelOptions['abortSignal'];

function delay(ms: number, abortSignal?: AbortLike): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    abortSignal?.addEventListener('abort', finish, { once: true });
  });
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) {
    return `${Math.round(ms / 60_000)} minutes`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

export class BitNet {
  /** Configure SDK defaults. Most apps can skip this and use CPU defaults. */
  static configure(config: BitNetConfiguration = {}): BitNetConfiguration {
    const next = configureBitNet(config);
    if (config.bitnetPath) {
      getBitNetLogger().info(
        'bitnetPath is a native build-time setting. Android/iOS builds read bitnet.config.json or BITNET_CPP_DIR; Web uses wasmModuleUrl.'
      );
    }
    return next;
  }

  /** Return the current SDK configuration. */
  static config(): BitNetConfiguration {
    return getBitNetConfig();
  }

  /** Convert a URL or Hugging Face source into the stable cache id used by the SDK. */
  static modelId(source: DownloadSource): string {
    return modelIdFromSource(source);
  }

  /** Inspect runtime capabilities for diagnostics or advanced runtime selection. */
  static async capabilities(): Promise<RuntimeCapabilities> {
    try {
      return parseNativeJson<RuntimeCapabilities>(
        await NativeBitNet.getRuntimeCapabilities(),
        'runtime capabilities'
      );
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  /**
   * Load a model and return a reusable native model handle.
   *
   * Calling BitNet.load() with no arguments uses the recommended BitNet GGUF and
   * downloads it automatically when it is not already cached.
   */
  static async load(
    modelIdOrPath: string = DEFAULT_MODEL_ID,
    options: LoadModelOptions = {}
  ): Promise<BitNetModel> {
    try {
      const resolved = await this.resolveModelForLoad(modelIdOrPath, options);
      const response = parseNativeJson<{
        handle: string;
        id: string;
        path: string;
        runtimeUsed: BitNetResolvedRuntime;
        warnings?: string[];
      }>(
        await NativeBitNet.loadModel(
          resolved.path,
          stringifyNativeJson({
            id: resolved.id,
            runtime: options.runtime ?? getDefaultRuntime(),
            contextSize: options.contextSize ?? 2048,
            threads: options.threads ?? 0,
            keepInMemory: options.keepInMemory ?? true,
          })
        ),
        'load model'
      );

      getBitNetLogger().info(`runtime selected: ${response.runtimeUsed}`);
      for (const warning of response.warnings ?? []) {
        getBitNetLogger().warn(warning);
      }

      return new BitNetModel(response);
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  /**
   * Download a model into the SDK cache.
   *
   * Most apps can skip this and call BitNet.load(), which downloads the
   * recommended model automatically. Use this when you need explicit progress,
   * cancellation, or a custom source.
   */
  static async downloadModel(
    source: DownloadSource,
    options: DownloadModelOptions = {}
  ): Promise<CachedModel> {
    const request = toDownloadRequest(source);
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DOWNLOAD_POLL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastProgressKey = '';
    let jobId: string | undefined;
    let abortListener: (() => void) | undefined;

    try {
      const modelId = String(request.id);
      if (options.abortSignal?.aborted) {
        throw new DownloadCancelledError(modelId);
      }

      const cachedModels = await this.listModels();
      const cached = cachedModels.find((model) => model.id === modelId);
      if (cached && !downloadRequestMatchesCachedModel(cached, request)) {
        getBitNetLogger().warn(
          `Cached model ${modelId} no longer matches the configured source; deleting stale cache entry.`
        );
        await this.deleteModel(modelId);
      } else if (cached) {
        return cached;
      }

      jobId = await NativeBitNet.downloadModel(stringifyNativeJson(request));
      abortListener = () => {
        if (jobId) {
          void NativeBitNet.cancelDownload(jobId).catch(() => undefined);
        }
      };
      options.abortSignal?.addEventListener('abort', abortListener, { once: true });

      while (true) {
        if (options.abortSignal?.aborted) {
          await NativeBitNet.cancelDownload(jobId).catch(() => undefined);
          throw new DownloadCancelledError(modelId);
        }

        const progress = parseNativeJson<DownloadProgress>(
          await NativeBitNet.getDownloadProgress(jobId),
          'download progress'
        );
        const now = Date.now();
        const progressKey = `${progress.status}:${progress.receivedBytes}:${progress.totalBytes ?? ''}`;
        if (progressKey !== lastProgressKey) {
          lastActivityAt = now;
          lastProgressKey = progressKey;
        }
        options.onProgress?.(progress);

        if (progress.status === 'completed') {
          return parseNativeJson<CachedModel>(
            await NativeBitNet.awaitDownload(jobId),
            'download result'
          );
        }
        if (progress.status === 'failed') {
          throw new DownloadError(progress.error ?? `Download failed for ${progress.modelId}.`);
        }
        if (progress.status === 'cancelled') {
          throw new DownloadCancelledError(progress.modelId);
        }
        if (timeoutMs > 0 && now - startedAt > timeoutMs) {
          await NativeBitNet.cancelDownload(jobId).catch(() => undefined);
          throw new DownloadError(
            `Download timed out for ${progress.modelId} after ${formatDuration(timeoutMs)}. Check the network and retry.`
          );
        }
        if (
          stallTimeoutMs > 0 &&
          (progress.status === 'queued' || progress.status === 'downloading') &&
          now - lastActivityAt > stallTimeoutMs
        ) {
          await NativeBitNet.cancelDownload(jobId).catch(() => undefined);
          throw new DownloadError(
            `Download stalled for ${progress.modelId} for ${formatDuration(stallTimeoutMs)}. Check the network and retry.`
          );
        }

        await delay(pollIntervalMs, options.abortSignal);
      }
    } catch (error) {
      throw fromNativeError(error);
    } finally {
      if (abortListener) {
        options.abortSignal?.removeEventListener('abort', abortListener);
      }
    }
  }

  /** List models currently cached by the SDK. */
  static async listModels(): Promise<CachedModel[]> {
    try {
      return parseNativeJson<CachedModel[]>(await NativeBitNet.listModels(), 'model list');
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  /** Delete one cached model by id. Returns true when an entry was deleted. */
  static async deleteModel(modelId: string): Promise<boolean> {
    try {
      return await NativeBitNet.deleteModel(modelId);
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  /** Return total bytes used by the SDK model cache. */
  static async diskUsage(): Promise<number> {
    try {
      return await NativeBitNet.getDiskUsage();
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  private static async resolveModelForLoad(
    modelIdOrPath: string,
    options: LoadModelOptions
  ): Promise<{ id: string; path: string }> {
    if (modelIdOrPath === DEFAULT_MODEL_ID) {
      const model = await this.downloadModel(RECOMMENDED_BITNET_MODEL, {
        abortSignal: options.abortSignal,
        onProgress: options.onProgress ?? options.onDownloadProgress,
        timeoutMs: options.downloadTimeoutMs,
        stallTimeoutMs: options.downloadStallTimeoutMs,
      });
      return { id: model.id, path: model.path };
    }

    if (this.isDirectModelPath(modelIdOrPath)) {
      return { id: modelIdOrPath, path: modelIdOrPath };
    }

    const models = await this.listModels();
    const model = models.find((candidate) => candidate.id === modelIdOrPath);
    if (!model) {
      throw new ModelNotFoundError(modelIdOrPath);
    }
    return { id: model.id, path: model.path };
  }

  private static isDirectModelPath(modelIdOrPath: string): boolean {
    return modelIdOrPath.startsWith('/') || modelIdOrPath.startsWith('file://');
  }
}
