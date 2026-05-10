/**
 * Runtime preference used when loading a model.
 *
 * `cpu` is the production default. `gpu` is capability-gated and optional.
 * `auto` may attempt GPU first and fall back to CPU before generation starts.
 */
export type BitNetRuntime = 'cpu' | 'gpu' | 'auto';
export type BitNetResolvedRuntime = Exclude<BitNetRuntime, 'auto'>;

/** Global SDK configuration. Most apps do not need to call BitNet.configure(). */
export interface BitNetConfiguration {
  /**
   * Local BitNet.cpp checkout path used by native build tooling.
   *
   * Native Android/iOS builds read this from bitnet.config.json at build time.
   * At runtime this value is retained for diagnostics and Web helper defaults.
   */
  bitnetPath?: string;
  /**
   * Build-time hint consumed by native tooling when writing bitnet.config.json.
   * CPU stays the runtime default; GPU requires a backend compiled for the target platform.
   */
  enableGPU?: boolean;
  /**
   * Default runtime used by BitNet.load when no per-load runtime is supplied.
   * Defaults to "cpu"; BitNet.cpp's supported mobile path is CPU-first.
   */
  runtime?: BitNetRuntime;
  /**
   * Web worker module URL for the Emscripten-generated BitNet WASM loader.
   * Defaults to /bitnet_wasm.js.
   */
  wasmModuleUrl?: string;
  /**
   * Enables verbose Web worker/WASM lifecycle logs. Defaults to false so
   * production web apps do not get internal diagnostics in the console.
   */
  webDebug?: boolean;
  /**
   * Reserved for pthread-enabled WASM builds. Keep false unless the WASM
   * runtime was built with the matching thread setting.
   */
  webThreads?: boolean;
  /**
   * Thread count reported by Web capabilities when webThreads is enabled.
   * This should match the WASM pthread pool size used at build time.
   */
  webThreadCount?: number;
}

/** Runtime capabilities reported by the current platform backend. */
export interface RuntimeCapabilities {
  cpu: {
    available: boolean;
    arch: string;
    neon: boolean;
    avx2: boolean;
    threadCount: number;
  };
  gpu: {
    available: boolean;
    compiled: boolean;
    api?: string;
    reason?: string;
  };
}

/** Options for BitNet.load(). */
export interface LoadModelOptions {
  /** Runtime preference for this model load. Defaults to the configured runtime, then CPU. */
  runtime?: BitNetRuntime;
  /** Native context window size. Larger values use more memory. */
  contextSize?: number;
  /**
   * Native decode thread count. Leave undefined/0 for mobile-tuned defaults.
   *
   * BitNet inference is memory-bound and mobile CPUs use big.LITTLE cores.
   * Using fewer threads avoids memory contention and thermal throttling.
   */
  threads?: number;
  /** Keep model weights resident until model.unload(). Defaults to true. */
  keepInMemory?: boolean;
  /**
   * Cancels the implicit recommended-model download performed by BitNet.load().
   * Native model loading cannot be interrupted after the download has completed.
   */
  abortSignal?: BitNetAbortSignal;
  /**
   * Used when loading the recommended model and the model is not cached yet.
   * Kept consistent with BitNet.downloadModel().
   */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Used when loading the recommended model and the model is not cached yet.
   * @deprecated Use onProgress.
   */
  onDownloadProgress?: (progress: DownloadProgress) => void;
  downloadTimeoutMs?: number;
  downloadStallTimeoutMs?: number;
}

/** Parameters for one text generation request. */
export interface GenerationParams {
  /** Prompt text to send to BitNet.cpp. */
  prompt: string;
  /**
   * Raw prompt sends the text exactly as provided. Chat applies the model's
   * llama.cpp chat template, equivalent to BitNet.cpp/llama.cpp conversation mode.
   */
  promptMode?: 'raw' | 'chat';
  /** Optional system instruction used when promptMode is "chat". */
  systemPrompt?: string;
  /** Optional llama.cpp chat template override. Most apps should leave this unset. */
  chatTemplate?: string;
  /** Sampling temperature. Lower values are more deterministic. Defaults to 0.8. */
  temperature?: number;
  /** Top-k sampling cutoff. Defaults to 40. */
  topK?: number;
  /** Nucleus sampling cutoff. Defaults to 0.95. */
  topP?: number;
  /** Maximum generated tokens. Defaults to 512. */
  maxTokens?: number;
  /** RNG seed. Use a fixed value for reproducible sampling, or omit for runtime default. */
  seed?: number;
  /** Repetition penalty used by the native sampler. Defaults to 1.1. */
  repeatPenalty?: number;
  /**
   * Stop sequences are enforced by the SDK stream wrapper.
   * Matching text is not yielded, and native generation is cancelled immediately.
   */
  stopSequences?: string[];
  /** Abort signal used to cancel this generation. */
  abortSignal?: BitNetAbortSignal;
}

export type ChatRole = 'system' | 'user' | 'assistant';

/** OpenAI-style chat message used by BitNetModel.chat() and useBitNet().chat(). */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Parameters for OpenAI-style chat generation. */
export interface ChatGenerationParams
  extends Omit<GenerationParams, 'prompt' | 'promptMode' | 'systemPrompt' | 'chatTemplate'> {
  /** Ordered conversation history. Include a system message when needed. */
  messages: ChatMessage[];
}

/** AbortSignal-compatible shape used across React Native and Web. */
export interface BitNetAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: string, listener: (...args: any[]) => void, options?: { once?: boolean } | boolean): void;
  removeEventListener(type: string, listener: (...args: any[]) => void): void;
}

/** Metrics emitted after generation completes. */
export interface BitNetMetrics {
  modelId: string;
  runtimeUsed: BitNetResolvedRuntime;
  /**
   * Present only when the backend can report prompt tokenization count.
   * Current BitNet.cpp mobile/Web paths do not expose it reliably.
   */
  promptTokens?: number;
  generatedTokens: number;
  tokensPerSecond: number;
  latencyMs: number;
  memoryUsageMB: number;
  memoryUsageBytes?: number;
  firstTokenLatencyMs?: number;
  threadCount?: number;
}

export type MetricsListener = (metrics: BitNetMetrics) => void;

/** Metadata for a model cached by the SDK. */
export interface CachedModel {
  id: string;
  path: string;
  source: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
}

/** Progress event for model downloads. */
export interface DownloadProgress {
  jobId: string;
  modelId: string;
  receivedBytes: number;
  totalBytes?: number;
  status: 'queued' | 'downloading' | 'validating' | 'completed' | 'cancelled' | 'failed';
  error?: string;
}

/** Model source accepted by BitNet.downloadModel(). */
export type DownloadSource =
  | {
      url: string;
      id?: string;
      fileName?: string;
      checksumSha256?: string;
    }
  | {
      hf: string;
      file: string;
      revision?: string;
      id?: string;
      checksumSha256?: string;
    };

/** Options for explicit model downloads. */
export interface DownloadModelOptions {
  onProgress?: (progress: DownloadProgress) => void;
  pollIntervalMs?: number;
  abortSignal?: BitNetAbortSignal;
  timeoutMs?: number;
  stallTimeoutMs?: number;
}

/** Native token stream event payload. App code usually consumes generated strings instead. */
export interface NativeTokenEvent {
  type: 'token' | 'metrics' | 'warning' | 'end' | 'error' | 'cancelled';
  text?: string;
  metrics?: BitNetMetrics;
  warning?: string;
  error?: string;
}
