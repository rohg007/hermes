import React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { styles } from './styles';

type Props = {
  busy: boolean;
  canSend: boolean;
  generating: boolean;
  modelStatus: string;
  prompt: string;
  ready: boolean;
  onCancel(): void;
  onPromptChange(prompt: string): void;
  onSend(): void;
};

export function Composer({
  busy,
  canSend,
  generating,
  modelStatus,
  prompt,
  ready,
  onCancel,
  onPromptChange,
  onSend,
}: Props) {
  return (
    <View style={styles.composer}>
      <TextInput
        editable={ready && !busy}
        multiline
        onChangeText={onPromptChange}
        placeholder={ready ? 'Message BitNet' : modelStatus === 'error' ? 'Fix model setup and retry' : 'Preparing model...'}
        style={styles.input}
        value={prompt}
      />
      {generating ? (
        <Pressable onPress={onCancel} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Stop</Text>
        </Pressable>
      ) : (
        <Pressable disabled={!canSend} onPress={onSend} style={[styles.button, !canSend && styles.disabled]}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      )}
    </View>
  );
}
