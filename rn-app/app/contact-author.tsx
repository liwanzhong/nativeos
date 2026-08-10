import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, MessageCircle } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../constants/theme';

const AUTHOR_QR_IMAGE = require('../assets/contact-author/author-wechat-qr.jpg');
const AUTHOR_QR_SOURCE = Image.resolveAssetSource(AUTHOR_QR_IMAGE);

export default function ContactAuthorScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const qrWidth = Math.min(width - spacing.lg * 2 - spacing.md * 2, 360);
  const qrHeight = AUTHOR_QR_SOURCE.width > 0
    ? Math.round(qrWidth * (AUTHOR_QR_SOURCE.height / AUTHOR_QR_SOURCE.width))
    : Math.round(qrWidth * 1.3333);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
          <Text style={styles.backBtnText}>返回</Text>
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroCard}>
          <View style={styles.heroIconBox}>
            <MessageCircle size={22} color={colors.primary} />
          </View>
          <Text style={styles.title}>共创口语 App</Text>
          <Image source={AUTHOR_QR_IMAGE} style={[styles.qrImage, { width: qrWidth, height: qrHeight }]} resizeMode="contain" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  backBtnText: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  heroIconBox: {
    width: 52,
    height: 52,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  qrImage: {
    borderRadius: borderRadius.xl,
    backgroundColor: '#FFFFFF',
  },
});
