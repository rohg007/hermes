import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native';

import type { Message } from './types';

export function MessageBubble({ item }: { item: Message }) {
  const isUser = item.role === 'user';
  const isAssistant = item.role === 'assistant';
  const isSystem = item.role === 'system';

  return (
    <View
      style={[
        styles.message,
        isUser && styles.user,
        isAssistant && styles.assistant,
        isSystem && styles.systemMessage,
        item.streaming && styles.streamingMessage,
      ]}
    >
      <View style={styles.roleRow}>
        <Text style={[styles.role, isUser && styles.userRole, isSystem && styles.systemRole]}>{item.role}</Text>
        {item.streaming ? (
          <View style={styles.generatingBadge}>
            <ActivityIndicator size="small" />
            <Text style={styles.generatingBadgeText}>Generating</Text>
          </View>
        ) : null}
      </View>

      {isAssistant && item.chunks ? (
        <Text style={styles.messageText}>
          {item.chunks.length > 0 ? (
            item.chunks.map((chunk, index) => (
              <FadingTokenChunk key={`${item.id}-${index}`}>
                {chunk}
              </FadingTokenChunk>
            ))
          ) : (
            <Text style={styles.pendingText}>Waiting for first token...</Text>
          )}
        </Text>
      ) : (
        <Text style={[styles.messageText, isUser && styles.userMessageText, isSystem && styles.systemMessageText]}>
          {item.text}
        </Text>
      )}
    </View>
  );
}

function FadingTokenChunk({ children }: { children: string }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(3)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        duration: 180,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: false,
      }),
      Animated.timing(translateY, {
        duration: 180,
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: false,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.Text style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  message: {
    borderRadius: 8,
    maxWidth: '88%',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  streamingMessage: {
    borderColor: '#abefc6',
  },
  user: {
    alignSelf: 'flex-end',
    backgroundColor: '#0f766e',
  },
  assistant: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    borderColor: '#dde2ea',
    borderWidth: StyleSheet.hairlineWidth,
  },
  systemMessage: {
    alignSelf: 'center',
    backgroundColor: '#eef2ff',
    borderColor: '#c7d7fe',
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '92%',
  },
  roleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  role: {
    color: '#667085',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  systemRole: {
    color: '#3538cd',
  },
  generatingBadge: {
    alignItems: 'center',
    backgroundColor: '#ecfdf3',
    borderColor: '#abefc6',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  generatingBadgeText: {
    color: '#067647',
    fontSize: 11,
    fontWeight: '700',
  },
  messageText: {
    color: '#111827',
    fontSize: 15,
    lineHeight: 21,
  },
  systemMessageText: {
    color: '#3538cd',
    fontSize: 14,
  },
  pendingText: {
    color: '#667085',
    fontStyle: 'italic',
  },
  userMessageText: {
    color: '#ffffff',
  },
  userRole: {
    color: '#ccfbf1',
  },
});
