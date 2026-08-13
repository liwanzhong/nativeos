/**
 * RecommendedCollectionCard — a single card representing either a
 * "recommended" (official) series the user can browse, or a
 * subscribed collection the user has already added. One component
 * drives both:
 *
 *   - **Vertical layout** (default; used in the /library discovery
 *     page): cover spans the full card width at the top in a 16:9
 *     frame, then badges / title / description / a full-width
 *     action button. The cover is the primary visual signal — the
 *     user hasn't decided yet and needs the strongest cue.
 *
 *   - **Horizontal layout** (used in the home / 视频跟练 list):
 *     cover sits on the left as a 72x72 thumbnail, content flows
 *     to the right. The user already owns this content; the
 *     progress bar + meta line are the primary signals.
 *
 * Mode is decided implicitly by which props the caller passes:
 *
 *   - `onTogglePick` present  → "browse" mode: render an action
 *     button (加入我的合集 / 已加入) at the bottom
 *   - `completedCount` set    → "subscribed" mode: render a
 *     progress bar + completion meta
 *   - `onMorePress` present   → render a "..." button in the
 *     header for the management menu (only used in subscribed
 *     mode today, but harmless in browse mode if a caller ever
 *     wants it)
 *
 * Why one component for two layouts: both surfaces represent the
 * same underlying entity (an official series, possibly picked).
 * The data shape differs only in the *augmentation* the user has
 * added (progress, picked-state). Sharing the visual language
 * means the user sees a consistent "this is a video collection"
 * shape across the two pages, with the same cover, same title
 * typography, same badge palette — just oriented differently
 * because the surrounding context (browse vs. owned) is
 * different.
 */

import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Check, Cloud, CloudOff, Download, Link2, MoreVertical, Plus, RefreshCw } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';

export interface RecommendedCollectionCardProps {
  /**
   * Optional. When set, tapping the card body fires this. The
   * three-dot menu and the action button use their own
   * handlers and stop propagation so the card-press doesn't
   * also fire.
   */
  onPress?: () => void;

  /**
   * 'vertical' puts the cover on top (good for discovery pages
   * where the cover is the primary signal). 'horizontal' puts
   * the cover on the left (good for owned-list pages where
   * progress is the primary signal). Default 'vertical'.
   */
  layout?: 'vertical' | 'horizontal';

  // ── Identity / content ──
  title: string;
  coverImageUri?: string;
  description?: string;

  // ── Badge row ──
  // Browse mode: show level + category badges (e.g. "A1 口语表达")
  // Subscribed mode: show one kind badge (e.g. "推荐" / "默认" / "我的")
  // Either or both may be set; the card renders whichever it gets.
  level?: string;
  category?: string;
  kindBadge?: string;
  kindAccent?: { bg: string; text: string };

  // ── Stats ──
  /**
   * Used as "X 集" in browse mode (official series) or as the
   * total count in subscribed mode (mixed official + user).
   * Mutually exclusive with `episodeCount` in practice but we
   * accept both and prefer `episodeCount` if set.
   */
  episodeCount?: number;
  videoCount?: number;

  // ── Subscribed-mode extras ──
  completedCount?: number;
  /**
   * Right-aligned header button (3-dot). Stops propagation so
   * the card-press handler doesn't fire too.
   */
  onMorePress?: () => void;

  // ── Browse-mode extras ──
  /**
   * "加入我的合集" / "已加入" action button at the bottom of
   * vertical cards. Setting this prop switches the card into
   * browse mode and renders the button.
   */
  isPicked?: boolean;
  isPicking?: boolean;
  onTogglePick?: () => void;

  // ── Cloud-drive status (browse-mode only, vertical layout) ──
  // Two status badges that show on the library page so the user
  // can see at a glance whether each official series is
  // (a) bound to their Baidu pan (or another configured cloud
  // drive), and (b) cached locally for offline playback.
  //
  // Surfaced as small chips below the description, before the
  // "加入我的合集" action button. When the user hasn't bound
  // anything yet (no provider configured), pass `null` /
  // `undefined` and the card just doesn't render the chip row
  // — saves vertical space for the unauthenticated case.
  bindingStatus?: 'bound' | 'unbound' | 'stale' | 'error' | 'not_synced' | null;
  cacheStatus?: 'remote' | 'downloading' | 'cached' | 'error' | null;
  /**
   * Optional handler for tapping the binding chip. Stops
   * propagation so the card-press handler doesn't also fire.
   * Typically opens the cloud-drive auth / scan sheet.
   */
  onBindingPress?: () => void;
  /**
   * Optional handler for tapping the cache chip. Stops
   * propagation. Triggers a download (if not cached) or no-op
   * (if already cached) — the caller decides.
   */
  onCachePress?: () => void;

  /**
   * Optional small label that sits to the LEFT of the action
   * button (e.g. "17 集 · 共 1.2 小时"). Compact one-liner.
   */
  actionMetaLabel?: string;
}

export function RecommendedCollectionCard({
  onPress,
  layout = 'vertical',
  title,
  coverImageUri,
  description,
  level,
  category,
  kindBadge,
  kindAccent,
  episodeCount,
  videoCount,
  completedCount,
  onMorePress,
  isPicked,
  isPicking,
  onTogglePick,
  actionMetaLabel,
  bindingStatus,
  cacheStatus,
  onBindingPress,
  onCachePress,
}: RecommendedCollectionCardProps) {
  const isBrowseMode = typeof onTogglePick === 'function';
  const isSubscribedMode = typeof completedCount === 'number';

  const totalEpisodes = episodeCount ?? videoCount ?? 0;
  const progressFraction = isSubscribedMode && totalEpisodes > 0
    ? Math.min(1, completedCount! / totalEpisodes)
    : 0;
  const showProgressBar = isSubscribedMode && totalEpisodes > 0 && completedCount! > 0;

  // Compact meta line. In subscribed mode we show progress
  // ("已学 5 / 17") rather than restating the total separately
  // — the cover/title already imply it's a collection, so the
  // counter is what carries the at-a-glance value. In browse
  // mode we just show the total ("17 集").
  const metaLine = isSubscribedMode
    ? `已学 ${completedCount} / ${totalEpisodes}`
    : totalEpisodes > 0
      ? `${totalEpisodes} ${episodeCount != null ? '集' : '个视频'}`
      : '';

  return (
    <Pressable
      style={[
        styles.card,
        layout === 'vertical' ? styles.cardVertical : styles.cardHorizontal,
      ]}
      onPress={onPress}
    >
      {/* ── Cover (only when the user has actually picked / set one) ──
          We deliberately do NOT render a placeholder block for
          collections that have no cover. The old behaviour was a
          tinted square with the title's first 2 characters, but
          that is decoration for a state the user is never going to
          fill in (default + user-built collections don't have a
          cover upload flow in v1). Showing a fake "ab" tile
          competes with the title for attention and pretends to
          carry information it doesn't. Cards without a cover
          collapse to title + meta + progress — the title is the
          identity, the meta is the value. */}
      {coverImageUri ? (
        <View
          style={
            layout === 'vertical'
              ? styles.coverVerticalWrap
              : styles.coverHorizontalWrap
          }
        >
          <Image
            source={{ uri: coverImageUri }}
            style={
              layout === 'vertical'
                ? styles.coverVerticalImg
                : styles.coverHorizontalImg
            }
          />
        </View>
      ) : null}

      {/* ── Body ── */}
      <View
        style={
          layout === 'vertical'
            ? styles.bodyVertical
            : styles.bodyHorizontal
        }
      >
        {/* Top row: badges + episode count + (more button) */}
        <View style={styles.badgeRow}>
          {level ? (
            <View style={[styles.badge, styles.levelBadge]}>
              <Text style={[styles.badgeText, styles.levelBadgeText]}>
                {level}
              </Text>
            </View>
          ) : null}
          {category ? (
            <View style={[styles.badge, styles.categoryBadge]}>
              <Text style={[styles.badgeText, styles.categoryBadgeText]}>
                {category}
              </Text>
            </View>
          ) : null}
          {kindBadge ? (
            <View
              style={[
                styles.badge,
                kindAccent
                  ? { backgroundColor: kindAccent.bg }
                  : styles.kindBadgeDefault,
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  kindAccent
                    ? { color: kindAccent.text }
                    : styles.kindBadgeTextDefault,
                ]}
              >
                {kindBadge}
              </Text>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {totalEpisodes > 0 && !isSubscribedMode ? (
            <Text style={styles.episodeCountRight}>
              {totalEpisodes} {episodeCount != null ? '集' : '个视频'}
            </Text>
          ) : null}
          {onMorePress ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                onMorePress();
              }}
              hitSlop={8}
              style={styles.moreBtn}
            >
              <MoreVertical size={16} color={colors.text.secondary} />
            </Pressable>
          ) : null}
        </View>

        {/* Title */}
        <Text
          style={styles.title}
          numberOfLines={layout === 'vertical' ? 2 : 1}
        >
          {title}
        </Text>

        {/* Description (vertical only by default — horizontal
            rows would feel cramped with a 2-line description) */}
        {description && layout === 'vertical' ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}

        {/* Cloud-drive status row (browse-mode / vertical only).
            Shows at most two chips: binding + cache. Each can be
            tapped if the caller wired the matching handler —
            typically "未绑定" → open auth sheet, "未缓存" →
            trigger download. We only render a chip when there's
            something to surface; an empty state (provider not
            configured yet) shows nothing, keeping the card tidy
            for the unauthenticated case. */}
        {layout === 'vertical' && (bindingStatus || cacheStatus) ? (
          <View style={styles.cloudStatusRow}>
            {bindingStatus ? (
              <BindingChip
                status={bindingStatus}
                onPress={onBindingPress}
              />
            ) : null}
            {cacheStatus ? (
              <CacheChip
                status={cacheStatus}
                onPress={onCachePress}
              />
            ) : null}
          </View>
        ) : null}

        {/* Subscribed-mode meta line ("5 / 17 集 · 已完成 5") */}
        {isSubscribedMode ? (
          <Text style={styles.metaLine} numberOfLines={1}>
            {metaLine}
          </Text>
        ) : null}

        {/* Progress bar (subscribed mode only, when there's
            actual progress to show) */}
        {showProgressBar ? (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.round(progressFraction * 100)}%` },
              ]}
            />
          </View>
        ) : null}

        {/* Browse-mode action: full-width button at the bottom
            of vertical cards. Horizontal browse cards aren't
            used today, but if one ever is, fall back to an
            inline right-aligned chip so it doesn't dominate. */}
        {isBrowseMode ? (
          layout === 'vertical' ? (
            <Pressable
              style={[
                styles.actionBtn,
                isPicked && styles.actionBtnPicked,
                isPicking && styles.actionBtnDisabled,
              ]}
              onPress={(e) => {
                e.stopPropagation();
                onTogglePick!();
              }}
              disabled={isPicking}
            >
              {isPicked ? (
                <>
                  <Check size={16} color="#0F766E" />
                  <Text style={[styles.actionBtnText, styles.actionBtnTextPicked]}>
                    已加入
                  </Text>
                </>
              ) : (
                <>
                  <Plus size={16} color="#FFFFFF" />
                  <Text style={styles.actionBtnText}>加入我的合集</Text>
                </>
              )}
            </Pressable>
          ) : null
        ) : null}
      </View>
    </Pressable>
  );
}

// ── Cloud-drive status chips ────────────────────────────────────────
// Two thin presentation components used by the browse-mode (library)
// cards. Both honour the same colour palette as the per-row
// chips on the collection detail page so the two UIs read as the
// same language.

type BindingChipStatus = NonNullable<RecommendedCollectionCardProps['bindingStatus']>;
type CacheChipStatus = NonNullable<RecommendedCollectionCardProps['cacheStatus']>;

function BindingChip({
  status,
  onPress,
}: {
  status: BindingChipStatus;
  onPress?: () => void;
}) {
  // Match the per-row chip language used on the collection
  // detail page: "已绑定" green, "需刷新" amber, "未绑定"
  // grey actionable, "绑定出错" red actionable.
  const isActionable = typeof onPress === 'function' && status !== 'bound';
  const palette = (() => {
    switch (status) {
      case 'bound':
        return { bg: 'rgba(15,118,110,0.10)', fg: '#0F766E', label: '已绑定', Icon: Link2 };
      case 'stale':
        return { bg: 'rgba(245,158,11,0.10)', fg: '#B45309', label: '需刷新', Icon: RefreshCw };
      case 'error':
        return { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626', label: '绑定出错', Icon: Link2 };
      case 'unbound':
      case 'not_synced':
      default:
        return { bg: 'rgba(37,99,235,0.08)', fg: colors.text.secondary, label: '绑定到网盘', Icon: CloudOff };
    }
  })();
  const { bg, fg, label, Icon } = palette;
  const containerStyle = [
    styles.cloudStatusChip,
    { backgroundColor: bg },
    isActionable && styles.cloudStatusChipActionable,
  ];
  const iconColor = isActionable ? colors.primary : fg;
  const textStyle = [styles.cloudStatusChipText, { color: fg }];
  if (isActionable) {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onPress!(); }}
        hitSlop={6}
        style={containerStyle}
      >
        <Icon size={10} color={iconColor} />
        <Text style={textStyle}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={containerStyle}>
      <Icon size={10} color={iconColor} />
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

function CacheChip({
  status,
  onPress,
}: {
  status: CacheChipStatus;
  onPress?: () => void;
}) {
  // Actionable only for "remote" — the user can tap to start a
  // download. "cached" is read-only; "downloading" / "error"
  // stay static in v1 (no cancel / retry from the card).
  const isActionable = typeof onPress === 'function' && status === 'remote';
  const palette = (() => {
    switch (status) {
      case 'cached':
        return { bg: 'rgba(15,118,110,0.10)', fg: '#0F766E', label: '已缓存', Icon: Check };
      case 'downloading':
        return { bg: 'rgba(37,99,235,0.10)', fg: '#1D4ED8', label: '下载中', Icon: Download };
      case 'error':
        return { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626', label: '下载失败', Icon: Download };
      case 'remote':
      default:
        return { bg: 'rgba(37,99,235,0.08)', fg: colors.text.secondary, label: '缓存到本地', Icon: Cloud };
    }
  })();
  const { bg, fg, label, Icon } = palette;
  const containerStyle = [
    styles.cloudStatusChip,
    { backgroundColor: bg },
    isActionable && styles.cloudStatusChipActionable,
  ];
  const iconColor = isActionable ? colors.primary : fg;
  const textStyle = [styles.cloudStatusChipText, { color: fg }];
  if (isActionable) {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onPress!(); }}
        hitSlop={6}
        style={containerStyle}
      >
        <Icon size={10} color={iconColor} />
        <Text style={textStyle}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={containerStyle}>
      <Icon size={10} color={iconColor} />
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  cardVertical: {
    padding: 0,
  },
  cardHorizontal: {
    flexDirection: 'row',
    padding: spacing.md,
    gap: spacing.md,
  },

  // ── Cover ──
  coverVerticalWrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#E2E8F0',
  },
  coverVerticalImg: {
    width: '100%',
    height: '100%',
  },
  coverHorizontalWrap: {
    width: 72,
    height: 72,
    flexShrink: 0,
  },
  coverHorizontalImg: {
    width: '100%',
    height: '100%',
    borderRadius: borderRadius.md,
  },

  // ── Body ──
  bodyVertical: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  bodyHorizontal: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },

  // ── Badge row ──
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: fontWeight.semibold,
  },
  levelBadge: {
    backgroundColor: '#DBEAFE',
  },
  levelBadgeText: {
    color: '#1E40AF',
  },
  categoryBadge: {
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  categoryBadgeText: {
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  kindBadgeDefault: {
    backgroundColor: 'rgba(15,118,110,0.10)',
  },
  kindBadgeTextDefault: {
    color: '#0F766E',
  },
  episodeCountRight: {
    fontSize: 11,
    color: colors.text.secondary,
  },
  moreBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Title / description / meta ──
  title: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  description: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  metaLine: {
    fontSize: 12,
    color: colors.text.secondary,
  },

  // ── Progress bar ──
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
    marginTop: 2,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },

  // ── Action button (browse mode, vertical) ──
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: borderRadius.md,
    backgroundColor: colors.primary,
    marginTop: spacing.xs,
  },
  actionBtnPicked: {
    backgroundColor: 'rgba(15,118,110,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.4)',
  },
  actionBtnDisabled: {
    opacity: 0.55,
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  actionBtnTextPicked: {
    color: '#0F766E',
  },

  // ── Cloud-drive status chips (library / browse-mode only) ──
  // Sits between the description and the action button on
  // vertical cards. Flex-wrap is on so a long-label translation
  // doesn't overflow the card; the gap is small enough that two
  // chips fit comfortably on one row in zh-CN.
  cloudStatusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.xs,
  },
  cloudStatusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  cloudStatusChipActionable: {
    // Subtle press-tint shift; the icon+text colour swap in the
    // chip itself does the heavy lifting.
    backgroundColor: 'rgba(37,99,235,0.12)',
  },
  cloudStatusChipText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
  },
});
