import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { BitNet, downloadProgressPercent, useBitNet } from '@bitnet/react-native';
import type { CachedModel, ChatMessage } from '@bitnet/react-native';

import {
  CONFIGURED_MODEL_ID,
  EXAMPLE_CONTEXT_SIZE,
  EXAMPLE_MAX_TOKENS,
  EXAMPLE_THREADS,
  SYSTEM_PROMPT,
} from './exampleConfig';
import type { Message } from './types';

const INITIAL_MESSAGES: Message[] = [
  { id: 'welcome', role: 'system', text: 'Preparing the configured BitNet model. You can chat once it is ready.' },
];

export function useExampleChat() {
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [prompt, setPrompt] = useState('Say hello');
  const [cachedModels, setCachedModels] = useState<CachedModel[]>([]);
  const [diskUsageBytes, setDiskUsageBytes] = useState(0);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const messageIdRef = useRef(0);
  const bitnet = useBitNet({
    modelId: CONFIGURED_MODEL_ID,
    clearStaleModels: true,
    contextSize: EXAMPLE_CONTEXT_SIZE,
    threads: EXAMPLE_THREADS,
  });
  const {
    model,
    status: modelStatus,
    statusText: modelStatusText,
    progress: downloadProgress,
    metrics,
    ready,
    busy,
    generating,
    reload,
    chat,
    cancelGeneration,
    unload,
  } = bitnet;

  const canSend = useMemo(() => ready && prompt.trim().length > 0 && !busy, [busy, prompt, ready]);
  const modelActionLabel = model ? 'Reload' : modelStatus === 'error' ? 'Retry' : 'Load';
  const downloadPercent = downloadProgress ? downloadProgressPercent(downloadProgress) : 0;

  const nextMessageId = useCallback((role: Message['role']) => {
    messageIdRef.current += 1;
    return `${role}-${Date.now()}-${messageIdRef.current}`;
  }, []);

  const append = useCallback(
    (message: Omit<Message, 'id'> & { id?: string }) => {
      setMessages((current) => [
        ...current,
        { ...message, id: message.id ?? nextMessageId(message.role) },
      ]);
    },
    [nextMessageId]
  );

  const refreshCache = useCallback(async () => {
    setCacheError(null);
    const [models, usage] = await Promise.all([BitNet.listModels(), BitNet.diskUsage()]);
    setCachedModels(models);
    setDiskUsageBytes(usage);
  }, []);

  useEffect(() => {
    void refreshCache().catch((error) => {
      setCacheError(error instanceof Error ? error.message : String(error));
    });
  }, [refreshCache]);

  useEffect(() => {
    if (modelStatus === 'loaded' || downloadProgress?.status === 'completed') {
      void refreshCache().catch((error) => {
        setCacheError(error instanceof Error ? error.message : String(error));
      });
    }
  }, [downloadProgress?.status, modelStatus, refreshCache]);

  async function send() {
    if (!canSend) {
      return;
    }

    const text = prompt.trim();
    setPrompt('');
    const assistantId = nextMessageId('assistant');

    append({ role: 'user', text });
    append({ id: assistantId, role: 'assistant', text: '', chunks: [], streaming: true });

    try {
      const history: ChatMessage[] = messages
        .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.text.trim().length > 0)
        .slice(-6)
        .map((message) => ({
          role: message.role,
          content: message.text,
        }));

      for await (const token of chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        topK: 20,
        topP: 0.9,
        maxTokens: EXAMPLE_MAX_TOKENS,
        repeatPenalty: 1.1,
        stopSequences: ['\nUser:', '\nSystem:', '\nAssistant:', '\nResponse:'],
      })) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  chunks: [...(message.chunks ?? []), token],
                  streaming: true,
                  text: message.text + token,
                }
              : message
          )
        );
      }
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                chunks: message.text ? message.chunks : [error instanceof Error ? error.message : String(error)],
                streaming: false,
                text: message.text || (error instanceof Error ? error.message : String(error)),
              }
            : message
        )
      );
    } finally {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                streaming: false,
              }
            : message
        )
      );
    }
  }

  async function deleteCachedModel(modelId: string) {
    if (cacheBusy || busy) {
      return;
    }
    setCacheBusy(true);
    setCacheError(null);
    try {
      if (model?.id === modelId) {
        await unload();
      }
      const deleted = await BitNet.deleteModel(modelId);
      await refreshCache();
      append({
        role: 'system',
        text: deleted ? `Deleted cached model ${modelId}.` : `No cached model found for ${modelId}.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCacheError(message);
      append({ role: 'system', text: message });
    } finally {
      setCacheBusy(false);
    }
  }

  return {
    busy,
    cacheBusy,
    cacheError,
    cachedModels,
    canSend,
    cancel: cancelGeneration,
    deleteCachedModel,
    diskUsageBytes,
    downloadPercent,
    downloadProgress,
    generating,
    listRef,
    messages,
    metrics,
    model,
    modelActionLabel,
    modelStatus,
    modelStatusText,
    prompt,
    ready,
    refreshCache,
    reload,
    send,
    setCacheError,
    setPrompt,
  };
}
