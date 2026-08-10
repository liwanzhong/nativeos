export type OfficialVideoTransferProvider = 'baidu_pan';

export type OfficialVideoTransferProviderInfo = {
  provider: OfficialVideoTransferProvider;
  label?: string;
  shareUrl: string;
  accessCode?: string;
  description?: string;
  saveHint?: string;
  steps?: string[];
  copyText?: string;
};

export type OfficialVideoTransferConfig = {
  version: number;
  title?: string;
  intro?: string;
  updatedAt?: string;
  providers: OfficialVideoTransferProviderInfo[];
  notes?: string[];
};

export const OFFICIAL_VIDEO_TRANSFER_CONFIG_URL = 'https://nativeos.oss-cn-beijing.aliyuncs.com/videos/official-video-transfer.json';

function normalizeProviderInfo(raw: unknown): OfficialVideoTransferProviderInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as {
    provider?: unknown;
    label?: unknown;
    shareUrl?: unknown;
    accessCode?: unknown;
    description?: unknown;
    saveHint?: unknown;
    steps?: unknown;
    copyText?: unknown;
  };

  // 只接受 baidu_pan；其他 provider 一律丢弃。
  if (item.provider !== 'baidu_pan') {
    return null;
  }

  if (typeof item.shareUrl !== 'string' || !item.shareUrl.trim()) {
    return null;
  }

  return {
    provider: item.provider,
    label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined,
    shareUrl: item.shareUrl.trim(),
    accessCode: typeof item.accessCode === 'string' && item.accessCode.trim() ? item.accessCode.trim() : undefined,
    description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined,
    saveHint: typeof item.saveHint === 'string' && item.saveHint.trim() ? item.saveHint.trim() : undefined,
    steps: Array.isArray(item.steps) ? item.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0) : undefined,
    copyText: typeof item.copyText === 'string' && item.copyText.trim() ? item.copyText.trim() : undefined,
  };
}

export function buildOfficialVideoTransferCopyText(item: OfficialVideoTransferProviderInfo) {
  if (item.copyText?.trim()) {
    return item.copyText.trim();
  }

  const lines = [
    `${item.label || '百度网盘'} 推荐视频转存链接`,
    item.shareUrl,
  ];

  if (item.accessCode) {
    lines.push(`提取码：${item.accessCode}`);
  }

  if (item.saveHint) {
    lines.push(`说明：${item.saveHint}`);
  }

  return lines.join('\n');
}

export async function fetchOfficialVideoTransferConfig(url: string = OFFICIAL_VIDEO_TRANSFER_CONFIG_URL): Promise<OfficialVideoTransferConfig> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`推荐视频转存配置加载失败 (${response.status})`);
  }

  const json = await response.json() as {
    version?: unknown;
    title?: unknown;
    intro?: unknown;
    updatedAt?: unknown;
    providers?: unknown;
    notes?: unknown;
  };

  const providers = Array.isArray(json.providers)
    ? json.providers
      .map((item) => normalizeProviderInfo(item))
      .filter((item): item is OfficialVideoTransferProviderInfo => Boolean(item))
    : [];

  if (providers.length === 0) {
    throw new Error('推荐视频转存配置中没有可用的网盘信息');
  }

  return {
    version: typeof json.version === 'number' && Number.isFinite(json.version) ? json.version : 1,
    title: typeof json.title === 'string' && json.title.trim() ? json.title.trim() : undefined,
    intro: typeof json.intro === 'string' && json.intro.trim() ? json.intro.trim() : undefined,
    updatedAt: typeof json.updatedAt === 'string' && json.updatedAt.trim() ? json.updatedAt.trim() : undefined,
    providers,
    notes: Array.isArray(json.notes) ? json.notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0) : undefined,
  };
}
