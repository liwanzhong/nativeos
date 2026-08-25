/**
 * Stats 格式化工具
 *
 * 三种时间格式,分别给单视频页 / 集合页 / 统计页用:
 *   - formatLong(ms)   → "1 小时 20 分钟"  (单视频页 扁平展示)
 *   - formatShort(ms)  → "1h20m"           (集合页 VideoRow, 卡片紧凑)
 *   - formatCount(n)   → "14 次"           (跟读次数)
 */

/** 长格式:单视频页、视频数据弹窗 */
export function formatLong(ms: number): string {
  if (ms <= 0) return '0 分钟';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin} 分钟`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

/** 短格式:集合页 VideoRow 卡片(限宽) */
export function formatShort(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/** 跟读次数 */
export function formatCount(n: number): string {
  return `${n} 次`;
}

/**
 * 集合页 VideoRow 用的"看 Xm · 听 Ym · 跟读 Z"格式化。
 * 三段都不是 0 时全显示,任一为 0 时省略对应段。
 */
export function formatVideoRowStats(stats: {
  foregroundMs: number;
  backgroundMs: number;
  shadowingCount: number;
}): string | null {
  const parts: string[] = [];
  if (stats.foregroundMs > 0) parts.push(`看 ${formatShort(stats.foregroundMs)}`);
  if (stats.backgroundMs > 0) parts.push(`听 ${formatShort(stats.backgroundMs)}`);
  if (stats.shadowingCount > 0) parts.push(`跟读 ${stats.shadowingCount}`);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}
