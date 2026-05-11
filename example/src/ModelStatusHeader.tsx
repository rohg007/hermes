import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { BitNetMetrics, DownloadProgress } from '@bitnet/react-native';

import { CONFIGURED_MODEL_ID } from './exampleConfig';
import { styles } from './styles';

type Props = {
  busy: boolean;
  downloadPercent: number;
  downloadProgress?: DownloadProgress | null;
  generating: boolean;
  metrics: BitNetMetrics | null;
  modelLoaded: boolean;
  modelActionLabel: string;
  modelStatus: string;
  modelStatusText: string;
  onReload(): void;
};

export function ModelStatusHeader({
  busy,
  downloadPercent,
  downloadProgress,
  generating,
  metrics,
  modelLoaded,
  modelActionLabel,
  modelStatus,
  modelStatusText,
  onReload,
}: Props) {
  return (
    <>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>BitNet Chat</Text>
          <Text style={styles.subtitle}>{modelLoaded ? CONFIGURED_MODEL_ID : 'No model loaded'}</Text>
        </View>
        <Pressable disabled={busy} onPress={onReload} style={[styles.button, busy && styles.disabled]}>
          <Text style={styles.buttonText}>{modelActionLabel}</Text>
        </Pressable>
      </View>

      <View style={[styles.status, modelStatus === 'error' && styles.statusError]}>
        {busy && !generating ? <ActivityIndicator /> : null}
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
    </>
  );
}
