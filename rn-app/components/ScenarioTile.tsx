import { Pressable, Text, StyleSheet, View } from 'react-native';
import { LucideIcon } from 'lucide-react-native';

interface ScenarioTileProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  color: string;
  onPress: () => void;
}

export function ScenarioTile({ icon: Icon, title, subtitle, color, onPress }: ScenarioTileProps) {
  return (
    <Pressable
      style={[styles.tile, { backgroundColor: color }]}
      onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
    >
      <Icon color="#fff" size={32} />
      <View style={styles.textContainer}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderRadius: 16,
    padding: 24,
    minHeight: 140,
    justifyContent: 'space-between',
  },
  textContainer: {
    marginTop: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
  },
});
