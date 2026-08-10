import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Volume2 } from 'lucide-react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { resolveAudioUri } from '../../lib/dictionary/media';

let _currentPlayer: ReturnType<typeof useAudioPlayer> | null = null;

export function DictionaryAudioButton({ audioKey, size = 18 }: { audioKey: string | null | undefined; size?: number }) {
  const uri = resolveAudioUri(audioKey);
  const player = useAudioPlayer(uri ? { uri } : null);
  const status = useAudioPlayerStatus(player);

  const playing = status.playing ?? false;

  useEffect(() => {
    return () => {
      try { player.pause(); } catch { /* noop */ }
    };
  }, [player]);

  const handlePress = useCallback(() => {
    if (!uri) return;

    if (playing) {
      player.pause();
      return;
    }

    if (_currentPlayer && _currentPlayer !== player) {
      try { _currentPlayer.pause(); } catch { /* noop */ }
    }
    _currentPlayer = player;

    player.seekTo(0);
    player.play();
  }, [uri, player, playing]);

  if (!uri) return null;

  return (
    <Pressable onPress={handlePress} hitSlop={8} style={styles.btn}>
      {playing
        ? <ActivityIndicator size="small" color="#3B82F6" />
        : <Volume2 size={size} color="#3B82F6" />
      }
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
