import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Volume2 } from 'lucide-react-native';
import { LearningCard as LearningCardType } from '../types';

interface LearningCardProps {
  card: LearningCardType;
  onPlayAudio?: () => void;
}

export function LearningCard({ card, onPlayAudio }: LearningCardProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.type}>{getCardTypeLabel(card.type)}</Text>
        {card.audioUrl && (
          <Pressable onPress={onPlayAudio} style={styles.audioButton}>
            <Volume2 color="#007AFF" size={20} />
          </Pressable>
        )}
      </View>

      <Text style={styles.targetWord}>{card.targetWord}</Text>
      
      {card.context && (
        <Text style={styles.context}>{card.context}</Text>
      )}
      
      {card.explanation && (
        <View style={styles.explanationBox}>
          <Text style={styles.explanation}>{card.explanation}</Text>
        </View>
      )}
    </View>
  );
}

function getCardTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'deep-understanding': '词根拆解',
    'context-fill': '语境填空',
    'collocation': '词块搭配',
    'contrast': '对比辨析',
    'visual': '视觉记忆',
    'cross-domain': '跨学科',
    'pronunciation': '语音重音',
    'register-shift': '语体转换',
  };
  return labels[type] || type;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  type: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  audioButton: {
    padding: 4,
  },
  targetWord: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 12,
  },
  context: {
    fontSize: 16,
    color: '#ccc',
    lineHeight: 24,
    marginBottom: 12,
  },
  explanationBox: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 12,
  },
  explanation: {
    fontSize: 14,
    color: '#888',
    lineHeight: 20,
  },
});
