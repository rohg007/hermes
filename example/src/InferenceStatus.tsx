import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { styles } from './styles';

export function InferenceStatus() {
  return (
    <View style={styles.inferenceStatus}>
      <ActivityIndicator />
      <View style={styles.inferenceStatusCopy}>
        <Text style={styles.inferenceStatusTitle}>Generating response</Text>
        <Text style={styles.inferenceStatusText}>Streaming tokens from the native BitNet runtime.</Text>
      </View>
    </View>
  );
}
