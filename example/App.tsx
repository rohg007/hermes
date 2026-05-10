import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  StatusBar,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BitNet,
  RECOMMENDED_BITNET_MODEL,
  downloadProgressPercent,
  formatBytes,
  useBitNet,
} from '@bitnet/react-native';
import type { CachedModel, ChatMessage } from '@bitnet/react-native';

import { MessageBubble } from './src/MessageBubble';
import type { Message } from './src/types';

const SYSTEM_PROMPT = 'You are a helpful assistant. Answer directly and keep responses concise.';
const CONFIGURED_MODEL = RECOMMENDED_BITNET_MODEL;
const CONFIGURED_MODEL_ID = BitNet.modelId(CONFIGURED_MODEL);

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 'welcome', role: 'system', text: 'Preparing the configured BitNet model. You can chat once it is ready.' },
  ]);
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
    contextSize: Platform.OS === 'web' ? 512 : 2048,
    threads: Platform.OS === 'web' ? 1 : 2,
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

  const canSend = useMemo(
    () => ready && prompt.trim().length > 0 && !busy,
    [busy, prompt, ready]
  );
  const modelActionLabel = model ? 'Reload' : modelStatus === 'error' ? 'Retry' : 'Load';
  const isGenerating = generating;
  const downloadPercent = downloadProgress ? downloadProgressPercent(downloadProgress) : 0;

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
        maxTokens: Platform.OS === 'web' ? 128 : 64,
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
          message.id === assistantId ? { ...message, streaming: false } : message
        )
      );
    }
  }

  function cancel() {
    cancelGeneration();
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

  function append(message: Omit<Message, 'id'> & { id?: string }) {
    setMessages((current) => [
      ...current,
      { ...message, id: message.id ?? nextMessageId(message.role) },
    ]);
  }

  function nextMessageId(role: Message['role']) {
    messageIdRef.current += 1;
    return `${role}-${Date.now()}-${messageIdRef.current}`;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>BitNet Chat</Text>
            <Text style={styles.subtitle}>
              {model ? CONFIGURED_MODEL_ID : 'No model loaded'}
            </Text>
          </View>
          <Pressable disabled={busy} onPress={() => void reload().catch(() => undefined)} style={[styles.button, busy && styles.disabled]}>
            <Text style={styles.buttonText}>{modelActionLabel}</Text>
          </Pressable>
        </View>

        <View style={[styles.status, modelStatus === 'error' && styles.statusError]}>
          {busy && !isGenerating ? <ActivityIndicator /> : null}
          <Text style={[styles.statusText, modelStatus === 'error' && styles.statusErrorText]}>{modelStatusText}</Text>
        </View>

        {downloadProgress && downloadProgress.status !== 'completed' ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${downloadPercent}%` }]} />
          </View>
        ) : null}

        {metrics ? (
          <Text style={styles.metrics}>
            {metrics.tokensPerSecond.toFixed(1)} tok/s · {Math.round(metrics.latencyMs)} ms ·{' '}
            {metrics.memoryUsageMB.toFixed(0)} MB
          </Text>
        ) : null}

        <View style={styles.cachePanel}>
          <View style={styles.cacheHeader}>
            <View>
              <Text style={styles.cacheTitle}>Model cache</Text>
              <Text style={styles.cacheMeta}>
                {formatBytes(diskUsageBytes)} · {cachedModels.length} model{cachedModels.length === 1 ? '' : 's'}
              </Text>
            </View>
            <Pressable disabled={cacheBusy} onPress={() => void refreshCache().catch((error) => setCacheError(error instanceof Error ? error.message : String(error)))} style={[styles.smallButton, cacheBusy && styles.disabled]}>
              <Text style={styles.smallButtonText}>Refresh</Text>
            </Pressable>
          </View>
          {cacheError ? <Text style={styles.cacheError}>{cacheError}</Text> : null}
          {cachedModels.length === 0 ? (
            <Text style={styles.cacheEmpty}>No cached models yet.</Text>
          ) : (
            cachedModels.map((cachedModel) => (
              <View key={cachedModel.id} style={styles.cacheRow}>
                <View style={styles.cacheModelCopy}>
                  <Text style={styles.cacheModelId} numberOfLines={1}>{cachedModel.id}</Text>
                  <Text style={styles.cacheModelMeta}>{formatBytes(cachedModel.sizeBytes)}</Text>
                </View>
                <Pressable
                  disabled={cacheBusy || busy}
                  onPress={() => void deleteCachedModel(cachedModel.id)}
                  style={[styles.deleteButton, (cacheBusy || busy) && styles.disabled]}
                >
                  <Text style={styles.deleteButtonText}>Delete</Text>
                </Pressable>
              </View>
            ))
          )}
        </View>

        {isGenerating ? (
          <View style={styles.inferenceStatus}>
            <ActivityIndicator />
            <View style={styles.inferenceStatusCopy}>
              <Text style={styles.inferenceStatusTitle}>Generating response</Text>
              <Text style={styles.inferenceStatusText}>Streaming tokens from the native BitNet runtime.</Text>
            </View>
          </View>
        ) : null}

        <FlatList
          data={messages}
          ref={listRef}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => <MessageBubble item={item} />}
        />

        <View style={styles.composer}>
          <TextInput
            editable={ready && !busy}
            multiline
            onChangeText={setPrompt}
            placeholder={ready ? 'Message BitNet' : modelStatus === 'error' ? 'Fix model setup and retry' : 'Preparing model...'}
            style={styles.input}
            value={prompt}
          />
          {isGenerating ? (
            <Pressable onPress={cancel} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable disabled={!canSend} onPress={send} style={[styles.button, !canSend && styles.disabled]}>
              <Text style={styles.buttonText}>Send</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f7f8fb',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0,
    paddingBottom: Platform.OS === 'android' ? 8 : 0,
  },
  container: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: '#dde2ea',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    color: '#111827',
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: '#667085',
    fontSize: 13,
    marginTop: 2,
  },
  status: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  statusError: {
    backgroundColor: '#fef3f2',
  },
  statusText: {
    color: '#475467',
    fontSize: 13,
    flex: 1,
  },
  statusErrorText: {
    color: '#b42318',
  },
  progressTrack: {
    backgroundColor: '#e4e7ec',
    height: 3,
    marginHorizontal: 16,
    marginBottom: 8,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: '#0f766e',
    height: 3,
  },
  metrics: {
    color: '#475467',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  cachePanel: {
    backgroundColor: '#ffffff',
    borderColor: '#dde2ea',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
  },
  cacheHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  cacheTitle: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '700',
  },
  cacheMeta: {
    color: '#667085',
    fontSize: 12,
    marginTop: 2,
  },
  cacheError: {
    color: '#b42318',
    fontSize: 12,
    marginTop: 8,
  },
  cacheEmpty: {
    color: '#667085',
    fontSize: 12,
    marginTop: 8,
  },
  cacheRow: {
    alignItems: 'center',
    borderTopColor: '#eef2f6',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    marginTop: 10,
    paddingTop: 10,
  },
  cacheModelCopy: {
    flex: 1,
  },
  cacheModelId: {
    color: '#111827',
    fontSize: 12,
    fontWeight: '600',
  },
  cacheModelMeta: {
    color: '#667085',
    fontSize: 12,
    marginTop: 2,
  },
  smallButton: {
    alignItems: 'center',
    backgroundColor: '#f2f4f7',
    borderColor: '#d0d5dd',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  smallButtonText: {
    color: '#344054',
    fontSize: 12,
    fontWeight: '700',
  },
  deleteButton: {
    alignItems: 'center',
    backgroundColor: '#fff1f3',
    borderColor: '#fecdd6',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  deleteButtonText: {
    color: '#b42318',
    fontSize: 12,
    fontWeight: '700',
  },
  inferenceStatus: {
    alignItems: 'center',
    backgroundColor: '#ecfdf3',
    borderColor: '#abefc6',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inferenceStatusCopy: {
    flex: 1,
  },
  inferenceStatusTitle: {
    color: '#067647',
    fontSize: 13,
    fontWeight: '700',
  },
  inferenceStatusText: {
    color: '#344054',
    fontSize: 12,
    marginTop: 2,
  },
  messages: {
    gap: 10,
    padding: 16,
  },
  composer: {
    alignItems: 'flex-end',
    borderTopColor: '#dde2ea',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    padding: 12,
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: '#cfd6e2',
    borderRadius: 8,
    borderWidth: 1,
    color: '#111827',
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    minHeight: 44,
    minWidth: 88,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#fef3f2',
    borderColor: '#fecdca',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    minWidth: 72,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: '#b42318',
    fontSize: 14,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.45,
  },
});
