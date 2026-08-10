/**
 * Shared page / section header styles for the three primary tabs
 * (video, AI practice, knowledge base). Keep these in lockstep with
 * videos.tsx, AiPracticeHome.tsx, and review.tsx so the apps feel like
 * one product.
 *
 * Two-level header pattern:
 *   pageTitle    (xl, bold)  — top-of-page name like "知识库" / "AI陪练"
 *   sectionTitle (base, bold) — sub-section labels like "全部卡片" / "推荐话题"
 *
 * No back arrow. These are top-level tabs, not sub-pages.
 */

import { StyleSheet } from 'react-native';
import { colors, spacing, fontSize, fontWeight } from './theme';

export const sectionStyles = StyleSheet.create({
  // ── Page-level (top of the screen, no back arrow) ───────────────
  pageHeader: {
    backgroundColor: colors.background,
    paddingTop: spacing.sm,
  },
  pageHeaderInfo: {
    gap: 4,
  },
  pageTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },

  // ── Section-level (mid-page sub-headers like "推荐话题") ─────────
  sectionBlock: {
    gap: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sectionHeaderInfo: {
    gap: 4,
  },
  sectionHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
});
