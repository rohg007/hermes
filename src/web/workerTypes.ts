import type { WebResolvedRuntime as ResolvedRuntime, WebRuntime as Runtime } from './runtime';

export type GenerationConfig = {
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

export type Metrics = {
  modelId: string;
  runtimeUsed: ResolvedRuntime;
  promptTokens?: number;
  generatedTokens: number;
  tokensPerSecond: number;
  latencyMs: number;
  memoryUsageMB: number;
  threadCount: number;
};

export type LoadOptions = {
  id?: string;
  runtime?: Runtime;
  contextSize?: number;
  threads?: number;
  keepInMemory?: boolean;
};

export type TokenEvent =
  | { type: 'token'; text: string }
  | { type: 'warning'; warning: string }
  | { type: 'metrics'; metrics: Metrics }
  | { type: 'end' }
  | { type: 'cancelled'; error?: string }
  | { type: 'error'; error: string };

export interface Backend {
  loadModel(path: string, options?: LoadOptions): Promise<void>;
  generate(config: GenerationConfig): AsyncIterable<string>;
  cancel(): void;
  getMetrics(): Metrics;
  unload(): void;
}

export type CachedModel = {
  id: string;
  path: string;
  source: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256?: string;
  createdAt: string;
  updatedAt: string;
};

export type DownloadProgressState = {
  jobId: string;
  modelId: string;
  receivedBytes: number;
  totalBytes?: number;
  status: 'queued' | 'downloading' | 'validating' | 'completed' | 'cancelled' | 'failed';
  error?: string;
};
