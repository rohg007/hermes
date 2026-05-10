import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BitNet, RECOMMENDED_BITNET_MODEL } from './BitNet';
import type { BitNetModel } from './BitNetModel';
import { InferenceBusyError, ModelNotFoundError, fromNativeError } from './errors';
import { formatDownloadProgress } from './formatters';
import type {
  BitNetAbortSignal,
  BitNetMetrics,
  ChatGenerationParams,
  DownloadProgress,
  GenerationParams,
  LoadModelOptions,
  MetricsListener,
} from './types';

export type BitNetLoadStatus =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'error';

/** Options for the React hook wrapper around BitNet.load(). */
export interface UseBitNetOptions
  extends Omit<LoadModelOptions, 'abortSignal' | 'onProgress' | 'onDownloadProgress'> {
  /** Model id or direct model path. Defaults to the recommended BitNet model. */
  modelId?: string;
  /** Automatically download/load the model when the component mounts. Defaults to true. */
  autoLoad?: boolean;
  /** Delete cached models that do not match modelId before loading. */
  clearStaleModels?: boolean;
  /** Download progress callback for the implicit model download. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Metrics callback for completed generations. */
  onMetrics?: MetricsListener;
}

/** State and actions returned by useBitNet(). */
export interface UseBitNetResult {
  /** Loaded model handle, or null before load completes. */
  model: BitNetModel | null;
  /** Current model lifecycle state. */
  status: BitNetLoadStatus;
  /** Human-readable load/download status. */
  statusText: string;
  /** Latest download progress event, when a download is active. */
  progress: DownloadProgress | null;
  /** Formatted download progress text. */
  progressText: string;
  /** Latest generation metrics emitted by the model. */
  metrics: BitNetMetrics | null;
  /** Last load error, if any. */
  error: Error | null;
  /** True when a model is loaded and ready for generation. */
  ready: boolean;
  /** True while load, reload, unload, or download is active. */
  loading: boolean;
  /** True while one generation is active. */
  generating: boolean;
  /** True when loading or generating. Use this to disable Send buttons. */
  busy: boolean;
  /** Load the configured model. */
  load: () => Promise<BitNetModel | null>;
  /** Unload and load the configured model again. */
  reload: () => Promise<BitNetModel | null>;
  /** Unload the current native model. */
  unload: () => Promise<void>;
  /** Stream text from a prompt. */
  generate: (params: GenerationParams) => AsyncIterable<string>;
  /** Stream text from OpenAI-style chat messages. */
  chat: (params: ChatGenerationParams) => AsyncIterable<string>;
  /** Cancel the active generation, if one exists. */
  cancelGeneration: () => void;
  /** Cancel the active model load or download, if one exists. */
  cancelLoad: () => void;
}

type AbortControllerLike = {
  abort(): void;
  signal: BitNetAbortSignal;
};

function createAbortController(): AbortControllerLike {
  const Controller = globalThis.AbortController;
  if (!Controller) {
    throw new Error('AbortController is unavailable in this JavaScript runtime.');
  }
  return new Controller() as AbortControllerLike;
}

function isDirectModelPath(modelIdOrPath: string): boolean {
  return modelIdOrPath.startsWith('/') || modelIdOrPath.startsWith('file://');
}

export function useBitNet(options: UseBitNetOptions = {}): UseBitNetResult {
  const {
    modelId = BitNet.modelId(RECOMMENDED_BITNET_MODEL),
    autoLoad = true,
    clearStaleModels = false,
    onProgress,
    onMetrics,
    runtime,
    contextSize,
    threads,
    keepInMemory,
    downloadTimeoutMs,
    downloadStallTimeoutMs,
  } = options;

  const [model, setModel] = useState<BitNetModel | null>(null);
  const [status, setStatus] = useState<BitNetLoadStatus>(autoLoad ? 'checking' : 'idle');
  const [statusText, setStatusText] = useState(
    autoLoad ? 'Checking model cache...' : 'Model is not loaded.'
  );
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [metrics, setMetrics] = useState<BitNetMetrics | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [generating, setGenerating] = useState(false);

  const modelRef = useRef<BitNetModel | null>(null);
  const runRef = useRef(0);
  const loadAbortRef = useRef<AbortControllerLike | null>(null);
  const generationAbortRef = useRef<AbortControllerLike | null>(null);
  const metricsUnsubscribeRef = useRef<(() => void) | null>(null);
  const onProgressRef = useRef(onProgress);
  const onMetricsRef = useRef(onMetrics);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onMetricsRef.current = onMetrics;
  }, [onMetrics]);

  const cleanupLoadedModel = useCallback(async () => {
    metricsUnsubscribeRef.current?.();
    metricsUnsubscribeRef.current = null;
    const current = modelRef.current;
    modelRef.current = null;
    setModel(null);
    if (current) {
      await current.unload();
    }
  }, []);

  const pruneStaleModels = useCallback(async () => {
    if (!clearStaleModels || isDirectModelPath(modelId)) {
      return;
    }
    const cachedModels = await BitNet.listModels();
    const staleModels = cachedModels.filter((cachedModel) => cachedModel.id !== modelId);
    if (staleModels.length === 0) {
      return;
    }
    setStatusText(
      `Model configuration changed. Clearing ${staleModels.length} stale cached model${staleModels.length === 1 ? '' : 's'}...`
    );
    for (const staleModel of staleModels) {
      await BitNet.deleteModel(staleModel.id);
    }
  }, [clearStaleModels, modelId]);

  const load = useCallback(async () => {
    const runId = runRef.current + 1;
    runRef.current = runId;
    loadAbortRef.current?.abort();
    generationAbortRef.current?.abort();
    const controller = createAbortController();
    loadAbortRef.current = controller;

    setStatus('checking');
    setStatusText('Checking model cache...');
    setProgress(null);
    setMetrics(null);
    setError(null);

    try {
      const current = modelRef.current;
      if (current) {
        if (current.id === modelId || current.path === modelId) {
          setStatus('loaded');
          setStatusText(`Ready: ${current.id}`);
          return current;
        }
        await cleanupLoadedModel();
        if (runRef.current !== runId) {
          return null;
        }
      }

      await pruneStaleModels();
      if (runRef.current !== runId) {
        return null;
      }

      setStatus('loading');
      setStatusText(`Loading ${modelId}...`);
      const loaded = await BitNet.load(modelId, {
        runtime,
        contextSize,
        threads,
        keepInMemory,
        abortSignal: controller.signal,
        downloadTimeoutMs,
        downloadStallTimeoutMs,
        onProgress: (nextProgress) => {
          if (runRef.current !== runId) {
            return;
          }
          setProgress(nextProgress);
          onProgressRef.current?.(nextProgress);
          if (nextProgress.status === 'completed') {
            setStatus('loading');
            setStatusText(`Cached model ready. Loading ${nextProgress.modelId}...`);
          } else {
            setStatus(nextProgress.status === 'failed' || nextProgress.status === 'cancelled' ? 'error' : 'downloading');
            setStatusText(formatDownloadProgress(nextProgress));
          }
        },
      });
      if (runRef.current !== runId) {
        await loaded.unload();
        return null;
      }

      metricsUnsubscribeRef.current?.();
      metricsUnsubscribeRef.current = loaded.onMetrics((nextMetrics) => {
        setMetrics(nextMetrics);
        onMetricsRef.current?.(nextMetrics);
      });
      modelRef.current = loaded;
      setModel(loaded);
      setStatus('loaded');
      setStatusText(`Ready: ${loaded.id}`);
      return loaded;
    } catch (caught) {
      const nextError = fromNativeError(caught);
      if (runRef.current === runId) {
        setError(nextError);
        setStatus('error');
        setStatusText(nextError.message);
      }
      throw nextError;
    } finally {
      if (runRef.current === runId) {
        loadAbortRef.current = null;
      }
    }
  }, [
    contextSize,
    cleanupLoadedModel,
    downloadStallTimeoutMs,
    downloadTimeoutMs,
    keepInMemory,
    modelId,
    pruneStaleModels,
    runtime,
    threads,
  ]);

  const unload = useCallback(async () => {
    runRef.current += 1;
    loadAbortRef.current?.abort();
    generationAbortRef.current?.abort();
    setStatus('unloading');
    setStatusText('Unloading model...');
    await cleanupLoadedModel();
    setProgress(null);
    setMetrics(null);
    setStatus('idle');
    setStatusText('Model is not loaded.');
  }, [cleanupLoadedModel]);

  const reload = useCallback(async () => {
    runRef.current += 1;
    loadAbortRef.current?.abort();
    generationAbortRef.current?.abort();
    setStatus('unloading');
    setStatusText('Unloading current model...');
    await cleanupLoadedModel();
    return load();
  }, [cleanupLoadedModel, load]);

  const cancelLoad = useCallback(() => {
    loadAbortRef.current?.abort();
  }, []);

  const cancelGeneration = useCallback(() => {
    generationAbortRef.current?.abort();
  }, []);

  const runGeneration = useCallback(
    async function* runGenerationWithState(
      params: { abortSignal?: BitNetAbortSignal },
      createStream: (model: BitNetModel, abortSignal: BitNetAbortSignal) => AsyncIterable<string>
    ): AsyncIterable<string> {
      const current = modelRef.current;
      if (!current) {
        throw new ModelNotFoundError(modelId);
      }
      if (generationAbortRef.current) {
        throw new InferenceBusyError();
      }

      const controller = createAbortController();
      generationAbortRef.current = controller;
      const externalAbort = () => controller.abort();
      if (params.abortSignal?.aborted) {
        controller.abort();
      } else {
        params.abortSignal?.addEventListener('abort', externalAbort, { once: true });
      }

      setGenerating(true);
      try {
        for await (const token of createStream(current, controller.signal)) {
          yield token;
        }
      } finally {
        params.abortSignal?.removeEventListener('abort', externalAbort);
        generationAbortRef.current = null;
        setGenerating(false);
      }
    },
    [modelId]
  );

  const generate = useCallback(
    async function* generateWithState(params: GenerationParams): AsyncIterable<string> {
      yield* runGeneration(params, (current, abortSignal) =>
        current.generate({ ...params, abortSignal })
      );
    },
    [runGeneration]
  );

  const chat = useCallback(
    async function* chatWithState(params: ChatGenerationParams): AsyncIterable<string> {
      yield* runGeneration(params, (current, abortSignal) =>
        current.chat({ ...params, abortSignal })
      );
    },
    [runGeneration]
  );

  useEffect(() => {
    if (!autoLoad) {
      return undefined;
    }
    void load().catch(() => undefined);
    return () => {
      runRef.current += 1;
      loadAbortRef.current?.abort();
      generationAbortRef.current?.abort();
      void cleanupLoadedModel().catch(() => undefined);
    };
  }, [autoLoad, cleanupLoadedModel, load]);

  const progressText = useMemo(() => (progress ? formatDownloadProgress(progress) : ''), [progress]);
  const loading = status === 'checking' || status === 'downloading' || status === 'loading' || status === 'unloading';

  return {
    model,
    status,
    statusText,
    progress,
    progressText,
    metrics,
    error,
    ready: status === 'loaded' && model !== null,
    loading,
    generating,
    busy: loading || generating,
    load,
    reload,
    unload,
    generate,
    chat,
    cancelGeneration,
    cancelLoad,
  };
}
