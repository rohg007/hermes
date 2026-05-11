import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatBytes } from '@bitnet/react-native';
import type { CachedModel } from '@bitnet/react-native';

import { styles } from './styles';

type Props = {
  busy: boolean;
  cacheBusy: boolean;
  cacheError: string | null;
  cachedModels: CachedModel[];
  diskUsageBytes: number;
  onDelete(modelId: string): void;
  onRefresh(): void;
};

export function ModelCachePanel({
  busy,
  cacheBusy,
  cacheError,
  cachedModels,
  diskUsageBytes,
  onDelete,
  onRefresh,
}: Props) {
  return (
    <View style={styles.cachePanel}>
      <View style={styles.cacheHeader}>
        <View>
          <Text style={styles.cacheTitle}>Model cache</Text>
          <Text style={styles.cacheMeta}>
            {formatBytes(diskUsageBytes)} · {cachedModels.length} model{cachedModels.length === 1 ? '' : 's'}
          </Text>
        </View>
        <Pressable disabled={cacheBusy} onPress={onRefresh} style={[styles.smallButton, cacheBusy && styles.disabled]}>
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
              <Text style={styles.cacheModelId} numberOfLines={1}>
                {cachedModel.id}
              </Text>
              <Text style={styles.cacheModelMeta}>{formatBytes(cachedModel.sizeBytes)}</Text>
            </View>
            <Pressable
              disabled={cacheBusy || busy}
              onPress={() => onDelete(cachedModel.id)}
              style={[styles.deleteButton, (cacheBusy || busy) && styles.disabled]}
            >
              <Text style={styles.deleteButtonText}>Delete</Text>
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}
