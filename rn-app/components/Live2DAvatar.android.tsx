/**
 * Live2DAvatar — Android implementation
 *
 * Uses react-native-live2d (Cubism SDK for Java / OpenGL ES).
 * Falls back to emoji avatar if native module is unavailable.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { setLipSyncVolumeCallback } from '../lib/volcengine/tts';

interface Props {
  modelUrl?: string;
  npcEmoji: string;
  isSpeaking?: boolean;
}

let ReactNativeLive2dView: any = null;
let ReactNativeLive2dModule: any = null;
try {
  const { requireNativeViewManager } = require('expo-modules-core');
  ReactNativeLive2dView = requireNativeViewManager('ReactNativeLive2d');
  const mod = require('react-native-live2d');
  ReactNativeLive2dModule = mod.ReactNativeLive2dModule ?? null;
  console.log('[Live2D] NativeView loaded:', !!ReactNativeLive2dView, 'Module loaded:', !!ReactNativeLive2dModule);
} catch (e) {
  console.warn('[Live2D] Native module load failed:', e);
}

const DEFAULT_MODEL_URL = 'models/senko/senko.model3.json';

export default function Live2DAvatar({ modelUrl = DEFAULT_MODEL_URL, npcEmoji, isSpeaking }: Props) {
  const [loadError, setLoadError] = useState(false);
  const [loadMsg, setLoadMsg] = useState('');
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 2000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 2000, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  useEffect(() => {
    if (isSpeaking) {
      const speak = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.5, duration: 200, useNativeDriver: true }),
        ])
      );
      speak.start();
      return () => speak.stop();
    } else {
      Animated.timing(glowAnim, { toValue: 0.4, duration: 400, useNativeDriver: true }).start();
    }
  }, [isSpeaking]);

  useEffect(() => {
    if (!ReactNativeLive2dModule) return;
    setLipSyncVolumeCallback((volume: number) => {
      try {
        ReactNativeLive2dModule.setMouthValue(volume);
      } catch { /* ignore */ }
    });
    return () => {
      setLipSyncVolumeCallback(null);
      try { ReactNativeLive2dModule.setMouthValue(0); } catch { /* ignore */ }
    };
  }, []);

  console.log('[Live2D] render check - View:', !!ReactNativeLive2dView, 'modelUrl:', modelUrl, 'loadError:', loadError);

  if (!ReactNativeLive2dView || !modelUrl || loadError) {
    return (
      <View style={styles.container}>
        <Animated.View
          style={[
            styles.avatarRing,
            {
              transform: [{ scale: pulseAnim }],
              opacity: glowAnim,
            },
            isSpeaking && styles.avatarRingSpeaking,
          ]}
        />
        <Animated.View style={[styles.avatarCircle, { transform: [{ scale: pulseAnim }] }]}>
          <Text style={styles.emoji}>{npcEmoji}</Text>
          {loadError && loadMsg ? (
            <Text style={styles.errorHint} numberOfLines={2}>{loadMsg}</Text>
          ) : null}
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={StyleSheet.absoluteFill}>
        <ReactNativeLive2dView
          style={styles.nativeView}
          modelPath={modelUrl}
          motionGroup="Idle"
          onError={(e: any) => {
            const msg = e?.nativeEvent?.message || 'Live2D error';
            console.warn('[Live2D] error:', msg);
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 360,
    height: 360,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarRing: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 180,
    borderWidth: 2,
    borderColor: '#60A5FA',
    backgroundColor: 'rgba(96,165,250,0.08)',
  },
  avatarRingSpeaking: {
    borderColor: '#34D399',
    backgroundColor: 'rgba(52,211,153,0.08)',
  },
  avatarCircle: {
    width: 288,
    height: 288,
    borderRadius: 144,
    backgroundColor: 'rgba(96,165,250,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(96,165,250,0.25)',
  },
  nativeView: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  emoji: { fontSize: 52 },
  errorHint: {
    fontSize: 8,
    color: '#F87171',
    textAlign: 'center',
    marginTop: 2,
  },
});
