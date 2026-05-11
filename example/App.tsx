import React from 'react';
import { FlatList, KeyboardAvoidingView, Platform, SafeAreaView } from 'react-native';

import { Composer } from './src/Composer';
import { InferenceStatus } from './src/InferenceStatus';
import { MessageBubble } from './src/MessageBubble';
import { ModelCachePanel } from './src/ModelCachePanel';
import { ModelStatusHeader } from './src/ModelStatusHeader';
import { configureExampleBitNet } from './src/exampleConfig';
import { styles } from './src/styles';
import { useExampleChat } from './src/useExampleChat';

configureExampleBitNet();

export default function App() {
  const chat = useExampleChat();

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <ModelStatusHeader
          busy={chat.busy}
          downloadPercent={chat.downloadPercent}
          downloadProgress={chat.downloadProgress}
          generating={chat.generating}
          metrics={chat.metrics}
          modelActionLabel={chat.modelActionLabel}
          modelLoaded={Boolean(chat.model)}
          modelStatus={chat.modelStatus}
          modelStatusText={chat.modelStatusText}
          onReload={() => void chat.reload().catch(() => undefined)}
        />

        <ModelCachePanel
          busy={chat.busy}
          cacheBusy={chat.cacheBusy}
          cacheError={chat.cacheError}
          cachedModels={chat.cachedModels}
          diskUsageBytes={chat.diskUsageBytes}
          onDelete={(modelId) => void chat.deleteCachedModel(modelId)}
          onRefresh={() =>
            void chat
              .refreshCache()
              .catch((error) => chat.setCacheError(error instanceof Error ? error.message : String(error)))
          }
        />

        {chat.generating ? <InferenceStatus /> : null}

        <FlatList
          data={chat.messages}
          ref={chat.listRef}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => chat.listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => <MessageBubble item={item} />}
        />

        <Composer
          busy={chat.busy}
          canSend={chat.canSend}
          generating={chat.generating}
          modelStatus={chat.modelStatus}
          onCancel={chat.cancel}
          onPromptChange={chat.setPrompt}
          onSend={() => void chat.send()}
          prompt={chat.prompt}
          ready={chat.ready}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
