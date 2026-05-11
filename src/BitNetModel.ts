import NativeBitNet from './native/NativeBitNet';
import { fromNativeError, InferenceCancelledError, ModelNotFoundError } from './errors';
import { getBitNetConfig } from './config';
import { getBitNetLogger, normalizeMetrics } from './logger';
import { parseNativeJson, stringifyNativeJson } from './nativeJson';
import { logPerformanceAuditMetrics } from './performanceAudit';
import type {
  BitNetMetrics,
  BitNetResolvedRuntime,
  ChatGenerationParams,
  ChatMessage,
  GenerationParams,
  MetricsListener,
  NativeTokenEvent,
} from './types';

// Native already batches token pieces before they cross the RN/Web boundary.
// JS only drains ready chunks and appends them to UI state.
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_WAIT_MS = 50;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_CHAT_STOP_SEQUENCES = [
  '\nUser:',
  '\nSystem:',
  '\nAssistant:',
  '\nResponse:',
  '\nInstruction:',
  '<|user|>',
  '<|system|>',
  '<|assistant|>',
  '<|eot_id|>',
  '<|end_of_text|>',
];

function normalizeStopSequences(stopSequences: string[] | undefined): string[] {
  return Array.from(new Set((stopSequences ?? []).filter((sequence) => sequence.length > 0)));
}

function mergeChatStopSequences(stopSequences: string[] | undefined): string[] {
  return normalizeStopSequences([...(stopSequences ?? []), ...DEFAULT_CHAT_STOP_SEQUENCES]);
}

function earliestStopIndex(text: string, stopSequences: string[]): number {
  let bestIndex = -1;
  for (const sequence of stopSequences) {
    const index = text.indexOf(sequence);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  return bestIndex;
}

function createStopSequenceFilter(stopSequences: string[]) {
  const maxStopLength = stopSequences.reduce((max, sequence) => Math.max(max, sequence.length), 0);
  let pending = '';

  return {
    push(chunk: string): { text: string; stopped: boolean } {
      if (stopSequences.length === 0) {
        return { text: chunk, stopped: false };
      }

      pending += chunk;
      const stopIndex = earliestStopIndex(pending, stopSequences);
      if (stopIndex >= 0) {
        const text = pending.slice(0, stopIndex);
        pending = '';
        return { text, stopped: true };
      }

      // Keep the tail that could still become a stop sequence across token
      // boundaries. This avoids leaking partial stop text to app UI.
      const keepLength = Math.max(0, maxStopLength - 1);
      if (pending.length <= keepLength) {
        return { text: '', stopped: false };
      }
      const emitLength = pending.length - keepLength;
      const text = pending.slice(0, emitLength);
      pending = pending.slice(emitLength);
      return { text, stopped: false };
    },
    flush(): string {
      const text = pending;
      pending = '';
      return text;
    },
  };
}

function chatRoleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'system':
      return 'System';
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
  }
}

function buildChatPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    throw new Error('BitNet chat requires at least one message.');
  }

  const transcript = messages
    .map((message) => `${chatRoleLabel(message.role)}: ${message.content.trim()}`)
    .join('\n\n');

  return `${transcript}\n\nAssistant:`;
}

function buildNativeChatPrompt(messages: ChatMessage[]): { systemPrompt: string; prompt: string } | null {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversationMessages = messages.filter((message) => message.role !== 'system');

  if (conversationMessages.length !== 1 || conversationMessages[0]?.role !== 'user') {
    return null;
  }

  return {
    systemPrompt: systemMessages.map((message) => message.content.trim()).filter(Boolean).join('\n\n'),
    prompt: conversationMessages[0].content.trim(),
  };
}

/** Loaded BitNet model handle. Keep one instance loaded and reuse it across prompts. */
export class BitNetModel {
  readonly id: string;
  readonly path: string;
  readonly runtimeUsed: BitNetResolvedRuntime;

  private readonly handle: string;
  private readonly metricsListeners = new Set<MetricsListener>();
  private unloaded = false;

  constructor(args: { handle: string; id: string; path: string; runtimeUsed: BitNetResolvedRuntime }) {
    this.handle = args.handle;
    this.id = args.id;
    this.path = args.path;
    this.runtimeUsed = args.runtimeUsed;
  }

  /** Subscribe to per-generation metrics. Returns an unsubscribe function. */
  onMetrics(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener);
    return () => {
      this.metricsListeners.delete(listener);
    };
  }

  /** Free native model memory and stop using this model instance. */
  async unload(): Promise<void> {
    if (this.unloaded) {
      return;
    }
    try {
      await NativeBitNet.unloadModel(this.handle);
      this.unloaded = true;
    } catch (error) {
      throw fromNativeError(error);
    }
  }

  /**
   * Generate text from a raw prompt or llama.cpp chat-template prompt.
   *
   * Tokenization, sampling, and decoding stay in BitNet.cpp. The iterator yields
   * small ordered text chunks that are safe to append directly to UI state.
   */
  async *generate(params: GenerationParams): AsyncIterable<string> {
    if (this.unloaded) {
      throw new ModelNotFoundError(this.id);
    }

    const generationParams = {
      prompt: params.prompt,
      systemPrompt: params.systemPrompt ?? '',
      chatTemplate: params.chatTemplate ?? '',
      useChatTemplate: params.promptMode === 'chat',
      temperature: params.temperature ?? 0.8,
      topK: params.topK ?? 40,
      topP: params.topP ?? 0.95,
      maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      seed: params.seed ?? -1,
      repeatPenalty: params.repeatPenalty ?? 1.1,
    };
    const stopFilter = createStopSequenceFilter(normalizeStopSequences(params.stopSequences));

    // Tokenization, sampling, and the decode loop stay inside BitNet.cpp. The
    // TypeScript iterator only receives already-generated text chunks.
    let generationHandle: string | undefined;
    let completed = false;
    const abortHandler = () => {
      if (generationHandle) {
        void NativeBitNet.cancelGeneration(generationHandle);
      }
    };

    try {
      if (params.abortSignal?.aborted) {
        throw new InferenceCancelledError();
      }

      generationHandle = await NativeBitNet.startGeneration(
        this.handle,
        stringifyNativeJson(generationParams)
      );
      params.abortSignal?.addEventListener('abort', abortHandler, { once: true });
      if (params.abortSignal?.aborted) {
        await NativeBitNet.cancelGeneration(generationHandle).catch(() => undefined);
        throw new InferenceCancelledError();
      }

      while (true) {
        const payload = await NativeBitNet.nextTokenBatch(
          generationHandle,
          DEFAULT_BATCH_SIZE,
          DEFAULT_WAIT_MS
        );
        const events = parseNativeJson<NativeTokenEvent[]>(payload, 'token batch');

        for (const event of events) {
          switch (event.type) {
            case 'token':
              if (event.text !== undefined) {
                const filtered = stopFilter.push(event.text);
                if (filtered.text.length > 0) {
                  yield filtered.text;
                }
                if (filtered.stopped) {
                  completed = true;
                  await NativeBitNet.cancelGeneration(generationHandle).catch(() => undefined);
                  return;
                }
              }
              break;
            case 'metrics':
              if (event.metrics) {
                this.emitMetrics(normalizeMetrics(event.metrics));
              }
              break;
            case 'warning':
              if (event.warning) {
                getBitNetLogger().warn(event.warning);
              }
              break;
            case 'cancelled':
              throw new InferenceCancelledError();
            case 'error':
              throw new Error(event.error ?? 'BitNet inference failed.');
            case 'end':
              {
                const remaining = stopFilter.flush();
                if (remaining.length > 0) {
                  yield remaining;
                }
              }
              completed = true;
              return;
            default:
              throw new Error(`Unknown BitNet token event: ${(event as { type?: string }).type ?? 'unknown'}`);
          }
        }
      }
    } catch (error) {
      throw fromNativeError(error);
    } finally {
      params.abortSignal?.removeEventListener('abort', abortHandler);
      if (generationHandle && !completed) {
        await NativeBitNet.cancelGeneration(generationHandle).catch(() => undefined);
      }
    }
  }

  /**
   * OpenAI-style chat helper.
   *
   * The common single-turn shape uses the native llama.cpp chat template. Multi-turn
   * history falls back to a compact raw transcript until the native layer accepts
   * full message arrays.
   */
  async *chat(params: ChatGenerationParams): AsyncIterable<string> {
    const { messages, ...generationParams } = params;
    const chatGenerationParams = {
      ...generationParams,
      stopSequences: mergeChatStopSequences(generationParams.stopSequences),
    };
    const nativeChat = buildNativeChatPrompt(messages);
    if (nativeChat) {
      yield* this.generate({
        ...chatGenerationParams,
        ...nativeChat,
        promptMode: 'chat',
      });
      return;
    }

    yield* this.generate({
      ...chatGenerationParams,
      prompt: buildChatPrompt(messages),
      promptMode: 'raw',
    });
  }

  private emitMetrics(metrics: BitNetMetrics): void {
    if (getBitNetConfig().performanceAudit) {
      logPerformanceAuditMetrics(metrics);
    }
    for (const listener of this.metricsListeners) {
      listener(metrics);
    }
  }
}
