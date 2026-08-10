/**
 * Membership benefit comparison data.
 *
 * 单文件数据源 — Buy Pro sheet 和 membership page 都从这里读。
 * 数字跟 lib/quota.ts 的 DEFAULT_QUOTA_CONFIG 保持一致：
 *   - Free: 30 / 60 / 150（硬限 = 软限）
 *   - Pro:  200 / 500 / 2000（UI 只展示软限；硬限 1000/2500/10000 是静默的"墙"）
 * 视频字幕: Pro 120-480 min/day, 取上限 8 小时展示
 */

export type BenefitRow = {
  key: string;
  label: string;
  free: string; // "30 次/天" or "—"
  pro: string;  // "200 次/天" or "✓"
};

export const BENEFIT_ROWS: BenefitRow[] = [
  {
    key: 'ai_rounds',
    label: 'AI 对话',
    free: '30 次/天',
    pro: '200 次/天',
  },
  {
    key: 'asr',
    label: '语音识别',
    free: '60 次/天',
    pro: '500 次/天',
  },
  {
    key: 'tts',
    label: '语音朗读',
    free: '150 次/天',
    pro: '2,000 次/天',
  },
  {
    key: 'subtitle',
    label: '视频字幕',
    free: '—',
    pro: '8 小时/天',
  },
  {
    key: 'byok',
    label: '自带 API Key',
    free: '—',
    pro: '✓',
  },
];

/**
 * Buy Pro sheet "联系作者" 4 步购买指南
 * 微信沟通默认模式：扫码 → 备注 → 转账 → 收兑换码
 */
export const PURCHASE_STEPS: string[] = [
  '长按上方二维码，保存到相册或微信扫一扫',
  '备注 "NativeOS Pro + 月数"（如 1 / 3 / 12 个月）',
  '完成转账后 24 小时内收到兑换码',
  '切到「兑换码」标签页，输入兑换码激活',
];

export const AUTHOR_NAME = '太风';
export const AUTHOR_REGION = '广东 广州';
export const AUTHOR_APP_NAME = '共创口语 App';
