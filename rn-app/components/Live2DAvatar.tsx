/**
 * Live2DAvatar — Native fallback (iOS / Android)
 * Renders an animated emoji avatar with a glowing pulse effect.
 * Live2D requires WebGL/DOM which is unavailable in native RN.
 */
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useEffect, useRef } from 'react';

interface Props {
  modelUrl?: string;
  npcEmoji: string;
  isSpeaking?: boolean;
}

export default function Live2DAvatar({ npcEmoji, isSpeaking }: Props) {
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

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.avatarRing,
          {
            transform: [{ scale: pulseAnim }],
            opacity: glowAnim,
          },
        ]}
      />
      <Animated.View style={[styles.avatarCircle, { transform: [{ scale: pulseAnim }] }]}>
        <Text style={styles.emoji}>{npcEmoji}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 120,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarRing: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: '#60A5FA',
    backgroundColor: 'rgba(96,165,250,0.08)',
  },
  avatarCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(96,165,250,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(96,165,250,0.25)',
  },
  emoji: { fontSize: 52 },
});
