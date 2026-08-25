import { View, Text, StyleSheet, ScrollView, Pressable, Platform, Modal, ActivityIndicator, Alert, Image } from 'react-native';
import { useEffect, useState, useCallback } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { BrainCircuit, Flag, ChevronRight, X, Check, Volume2, Trash2, Cloud, Link2, MessageCircleMore, Settings as SettingsIcon, Crown, Sparkles, KeyRound, BarChart3 } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import { AndroidAppUpdateModal } from '../../components/android-app-update-modal';
import {
  checkForAndroidAppUpdate,
  downloadAndroidUpdateApk,
  installAndroidUpdateApk,
  type AndroidUpdateInfo,
} from '../../lib/app-update';
import { updateUserProfile } from '../../lib/user-profile';
import { speakTextWithQuota, stopCurrentTTS } from '../../lib/volcengine/tts';
import { clearVideoCache, getVideoCacheStats } from '../../lib/video-cache';
import type { CEFRLevel } from '../../types';
import { getConfiguredCloudProviders, getDefaultCloudProvider, type CloudVideoProvider } from '../../lib/content/cloud-drive-bindings';
import { listUserVideos } from '../../lib/content/user-videos';
import { getProState, type ProState } from '../../lib/quota';
import { getByokConfig, type ByokConfig } from '../../lib/byok';

const LEVELS = [
  { id: 'A1', badge: 'A1', stage: '🟢', title: '入门级 · 零基础',     vocab: '~500 词',           anchor: '小学三年级至六年级' },
  { id: 'A2', badge: 'A2', stage: '🟢', title: '初级 · 日常基础',     vocab: '~1,000-1,500 词',   anchor: '初中毕业水平' },
  { id: 'B1', badge: 'B1', stage: '🟡', title: '中级 · 中阶瓶颈期',   vocab: '~2,000-3,000 词',   anchor: '高考及格 / 雅思 4.0-5.0' },
  { id: 'B2', badge: 'B2', stage: '🟡', title: '中高级 · 职场黄金线', vocab: '~4,000-6,000 词',   anchor: 'CET-4/6 良好 / 雅思 5.5-6.5' },
  { id: 'C1', badge: 'C1', stage: '🔴', title: '高级 · 学术商务自如', vocab: '~8,000-10,000 词',  anchor: '专业八级 / 雅思 7.0-8.0' },
  { id: 'C2', badge: 'C2', stage: '🔴', title: '精通级 · 近母语',     vocab: '15,000+ 词',        anchor: '雅思 8.5-9.0' },
];

interface Domain { id: string; label: string; }

const DOMAINS_BY_LEVEL: Record<string, Domain[]> = {
  A1: [
    { id: 'greet',      label: '👋 打招呼' },
    { id: 'selfintro',  label: '🙋 自我介绍' },
    { id: 'numbers',    label: '🔢 数字金额' },
    { id: 'ask_dir',    label: '🗺️ 问路指路' },
    { id: 'order_food', label: '🍜 点餐外卖' },
    { id: 'shopping',   label: '🛒 基础购物' },
    { id: 'time_date',  label: '🕐 时间日期' },
    { id: 'weather',    label: '⛅ 天气闲聊' },
    { id: 'family',     label: '👨‍👩‍👧 家庭成员' },
    { id: 'transport',  label: '🚌 乘车出行' },
    { id: 'hotel',      label: '🏨 酒店入住' },
    { id: 'pharmacy',   label: '💊 药店购药' },
  ],
  A2: [
    { id: 'daily',      label: '💬 日常闲聊' },
    { id: 'shopping2',  label: '🏬 逛街砍价' },
    { id: 'restaurant', label: '🍽️ 餐厅点餐' },
    { id: 'social',     label: '☕ 社交搭话' },
    { id: 'phone',      label: '📱 打电话' },
    { id: 'hobby',      label: '🎨 兴趣爱好' },
    { id: 'weekend',    label: '🏖️ 周末计划' },
    { id: 'neighbors',  label: '🏘️ 邻居邻居' },
    { id: 'kids',       label: '👨‍👧 教孩子英语' },
    { id: 'pet',        label: '🐾 宠物话题' },
    { id: 'gym',        label: '🏋️ 健身运动' },
    { id: 'cinema',     label: '🎬 看电影' },
    { id: 'post',       label: '📮 邮局快递' },
    { id: 'bank_basic', label: '🏦 银行取款' },
  ],
  B1: [
    { id: 'work',       label: '💼 职场沟通' },
    { id: 'meeting',    label: '📋 会议讨论' },
    { id: 'travel',     label: '✈️ 出国旅行' },
    { id: 'airport',    label: '🛫 机场问题' },
    { id: 'medical',    label: '🏥 就医问诊' },
    { id: 'complaint',  label: '😤 投诉维权' },
    { id: 'negotiate',  label: '🤝 基础谈判' },
    { id: 'gaming',     label: '🎮 游戏社交' },
    { id: 'interview1', label: '🎤 初级面试' },
    { id: 'rent',       label: '🏠 租房看房' },
    { id: 'collab',     label: '🧑‍💻 跨部门协作' },
    { id: 'email',      label: '📧 商务邮件' },
    { id: 'presentation', label: '📊 简单汇报' },
    { id: 'study_abroad1', label: '🎓 留学咨询' },
    { id: 'social_b1',  label: '🥂 社交活动' },
  ],
  B2: [
    { id: 'interview2', label: '🎯 高级面试' },
    { id: 'negotiation',label: '💡 商务谈判' },
    { id: 'it',         label: '💻 IT与编程' },
    { id: 'finance',    label: '📈 金融理财' },
    { id: 'hr',         label: '🧑‍💼 人事管理' },
    { id: 'study2',     label: '🎓 留学申请' },
    { id: 'academic',   label: '📚 学术讨论' },
    { id: 'media',      label: '📰 新闻媒体' },
    { id: 'startup',    label: '🚀 创业融资' },
    { id: 'legal',      label: '⚖️ 法律合同' },
    { id: 'marketing',  label: '📣 市场营销' },
    { id: 'remote',     label: '🌍 远程办公' },
    { id: 'conflict',   label: '🔥 职场冲突' },
    { id: 'design',     label: '🎨 创意设计' },
    { id: 'science',    label: '🔬 科技话题' },
    { id: 'ethics',     label: '🤔 职业伦理' },
  ],
  C1: [
    { id: 'leadership', label: '👑 领导力' },
    { id: 'crisis',     label: '🚨 危机公关' },
    { id: 'boardroom',  label: '🏛️ 董事会汇报' },
    { id: 'academia',   label: '🔭 学术演讲' },
    { id: 'policy',     label: '🗳️ 政策讨论' },
    { id: 'crosscult',  label: '🌐 跨文化沟通' },
    { id: 'phd',        label: '📜 博士申请' },
    { id: 'pitch',      label: '💼 投资路演' },
    { id: 'debate',     label: '🎭 辩论说服' },
    { id: 'mentoring',  label: '🧑‍🏫 导师对话' },
    { id: 'satire',     label: '😏 幽默反讽' },
    { id: 'media_c1',   label: '📡 媒体采访' },
    { id: 'philosophy', label: '💭 哲学思辨' },
    { id: 'law',        label: '⚖️ 法庭陈述' },
    { id: 'diplomacy',  label: '🤝 外交谈判' },
    { id: 'literature', label: '📖 文学评析' },
    { id: 'startup_c1', label: '🦄 创业融资' },
    { id: 'complex_neg',label: '🔑 复杂谈判' },
  ],
  C2: [
    { id: 'native_humor',label: '😂 母语幽默' },
    { id: 'idiom',      label: '🎯 俚语习语' },
    { id: 'subtle_neg', label: '🎲 弦外之音' },
    { id: 'exec_comm',  label: '🌟 高管沟通' },
    { id: 'storytell',  label: '📖 叙事演讲' },
    { id: 'improv',     label: '🎭 即兴应变' },
    { id: 'cultural',   label: '🎪 文化典故' },
    { id: 'poetry',     label: '✍️ 诗歌创作' },
    { id: 'think_tank', label: '🧠 智库研讨' },
    { id: 'global_biz', label: '🌍 全球商务' },
    { id: 'crisis_c2',  label: '🚨 极限危机' },
    { id: 'memoir',     label: '💫 个人陈述' },
    { id: 'ceo',        label: '👔 CEO发言' },
    { id: 'nuance',     label: '🔮 语义细微差别' },
  ],
};

const MAX_INTERESTS = 3;

// 2.0 大模型音色 (doc 6561/1257544),全部 _uranus_bigtts 后缀,
// 跟 X-Api-Resource-Id=seed-tts-2.0 匹配。原生 1.0 的 _moon/_mars 音色
// (emily/onez/hades/wennuanahu/shuangkuaisisi/cancan) 跟 seed-tts-2.0 不匹配
// 会报 55000000。2.0 真正英式只有 Charlotte 一个。
const TTS_VOICES = [
  { id: 'en_female_authoritative-british_uranus_bigtts', label: '活力女声', desc: 'Charlotte · 英式' },
  { id: 'en_female_allison_uranus_bigtts',  label: '亲切女声', desc: 'Allison · 美式' },
  { id: 'en_male_hades_uranus_bigtts',      label: '磁性男声', desc: 'Hades · 美式' },
  { id: 'en_male_marcus_uranus_bigtts',     label: '情感男声', desc: 'Marcus · 美式' },
  { id: 'en_female_joanne_uranus_bigtts',   label: '情感女声', desc: 'Joanne · 美式' },
  { id: 'en_female_brittney_uranus_bigtts', label: '温柔女声', desc: 'Brittney · 美式' },
  { id: '__system_default__', label: '系统默认', desc: '手机系统语音 · 离线' },
] as const;

type TtsConfig = { voice: string; speed: number };

const DEFAULT_TTS_CONFIG: TtsConfig = { voice: TTS_VOICES[0].id, speed: 1.0 };

function normalizeTtsConfig(value: unknown): TtsConfig {
  if (!value || typeof value !== 'object') return DEFAULT_TTS_CONFIG;
  const candidate = value as { voice?: unknown; speed?: unknown };
  const voice = typeof candidate.voice === 'string' && TTS_VOICES.some(v => v.id === candidate.voice)
    ? candidate.voice
    : DEFAULT_TTS_CONFIG.voice;
  const speed = typeof candidate.speed === 'number' && Number.isFinite(candidate.speed)
    ? candidate.speed
    : DEFAULT_TTS_CONFIG.speed;
  return { voice, speed };
}

const TTS_SPEEDS = [0.7, 0.85, 1.0, 1.2, 1.5] as const;
const PREVIEW_TEXT = "Welcome to NativeOS. Let's practice English together!";

function formatCacheSize(bytes: number) {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatProExpiry(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const BYOK_PROVIDER_SHORT: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  doubao: '豆包',
  zhipu: '智谱',
  moonshot: 'Kimi',
  custom: '自定义',
};

function byokProviderShortName(id: string): string {
  return BYOK_PROVIDER_SHORT[id] ?? id;
}

const BYOK_PROVIDER_FULL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  doubao: '火山豆包',
  zhipu: '智谱 GLM',
  moonshot: 'Moonshot Kimi',
  custom: '自定义 OpenAI 兼容',
};

function byokProviderLabel(id: string): string {
  return BYOK_PROVIDER_FULL[id] ?? id;
}

/**
 * Days elapsed since `firstTs` (ms epoch). 首次学习当天算第 1 天,以后每
 * 跨过 UTC+0 0 点 +1。本地只用 date-floor,跨时区也够用 — 用户最长感
 * 觉到 1 天误差,不必为 profile 屏多带一个时区库。
 */
function daysSince(firstTs: number): number {
  const ms = Date.now() - firstTs;
  if (ms < 0) return 1;
  return Math.floor(ms / 86_400_000) + 1;
}

type CloudDriveSummary = {
  connectedProviders: CloudVideoProvider[];
  defaultProvider: CloudVideoProvider | null;
  importedCloudVideoCount: number;
};

const ProfileScreen = () => {
  const router = useRouter();
  const { user, profile: cloudProfile } = useAuth();
  const [level, setLevel] = useState('B1');
  const [interests, setInterests] = useState<string[]>([]);
  const [cardCount, setCardCount] = useState(0);
  const [dayCount, setDayCount] = useState(0);
  const [showLevelModal, setShowLevelModal] = useState(false);
  const [showInterestsModal, setShowInterestsModal] = useState(false);
  const [showTtsModal, setShowTtsModal] = useState(false);
  // Unified level+interests modal
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [profileStep, setProfileStep] = useState<'level' | 'interests'>('level');
  const [draftLevel, setDraftLevel] = useState('B1');
  const [draftInterests, setDraftInterests] = useState<string[]>([]);
  const [ttsConfig, setTtsConfig] = useState<TtsConfig>(DEFAULT_TTS_CONFIG);
  const [draftTtsConfig, setDraftTtsConfig] = useState<TtsConfig>(DEFAULT_TTS_CONFIG);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [videoCacheStats, setVideoCacheStats] = useState({ fileCount: 0, totalSize: 0 });
  const [isClearingVideoCache, setIsClearingVideoCache] = useState(false);
  const [manualUpdate, setManualUpdate] = useState<AndroidUpdateInfo | null>(null);
  const [isManualUpdateVisible, setIsManualUpdateVisible] = useState(false);
  const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);
  const [isDownloadingManualUpdate, setIsDownloadingManualUpdate] = useState(false);
  const [manualUpdateProgress, setManualUpdateProgress] = useState(0);
  const [manualUpdateError, setManualUpdateError] = useState<string | null>(null);
  const [cloudDriveSummary, setCloudDriveSummary] = useState<CloudDriveSummary>({
    connectedProviders: [],
    defaultProvider: null,
    importedCloudVideoCount: 0,
  });
  const [proState, setProState] = useState<ProState>({ tier: 'free', expiresAt: null, updatedAt: 0 });
  const [byokCfg, setByokCfg] = useState<ByokConfig | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const [lv, interestsRaw, ttsRaw] = await Promise.all([
        AsyncStorage.getItem('user_level'),
        AsyncStorage.getItem('user_interests'),
        AsyncStorage.getItem('tts_config'),
      ]);
      if (lv) setLevel(lv);
      if (interestsRaw) setInterests(JSON.parse(interestsRaw));
      if (ttsRaw) {
        try {
          const cfg = normalizeTtsConfig(JSON.parse(ttsRaw));
          setTtsConfig(cfg);
          setDraftTtsConfig(cfg);
        } catch {
          setTtsConfig(DEFAULT_TTS_CONFIG);
          setDraftTtsConfig(DEFAULT_TTS_CONFIG);
        }
      } else {
        setTtsConfig(DEFAULT_TTS_CONFIG);
        setDraftTtsConfig(DEFAULT_TTS_CONFIG);
      }
      // Always default to immersive mode
      await AsyncStorage.setItem('practice_mode', 'immersive');
    } catch (e) {
      console.warn('Failed to load profile:', e);
    }
    try {
      const { getCardCount, getFirstLearningAt } = await import('../../lib/database');
      const [count, firstAt] = await Promise.all([getCardCount(), getFirstLearningAt()]);
      setCardCount(count);
      setDayCount(firstAt == null ? 0 : daysSince(firstAt));
    } catch (e) {
      console.warn('Failed to count cards:', e);
    }
  }, []);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  const loadVideoCacheStats = useCallback(async () => {
    if (Platform.OS === 'web') {
      setVideoCacheStats({ fileCount: 0, totalSize: 0 });
      return;
    }
    setVideoCacheStats(await getVideoCacheStats());
  }, []);

  const loadCloudDriveSummary = useCallback(async () => {
    try {
      const [connectedProviders, defaultProvider, userVideos] = await Promise.all([
        getConfiguredCloudProviders(),
        getDefaultCloudProvider(),
        listUserVideos(),
      ]);
      const importedCloudVideoCount = userVideos.filter((item) => item.sourceType === 'cloud_reference').length;
      setCloudDriveSummary({ connectedProviders, defaultProvider, importedCloudVideoCount });
    } catch (e) {
      console.warn('Failed to load cloud drive summary:', e);
    }
  }, []);

  const loadProState = useCallback(async () => {
    try {
      const next = await getProState();
      setProState(next);
    } catch (e) {
      console.warn('Failed to load pro state:', e);
    }
  }, []);

  const loadByokConfig = useCallback(async () => {
    try {
      const next = await getByokConfig();
      setByokCfg(next);
    } catch (e) {
      console.warn('Failed to load byok config:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadProfile();
      void loadVideoCacheStats();
      void loadCloudDriveSummary();
      void loadProState();
      void loadByokConfig();
    }, [loadByokConfig, loadCloudDriveSummary, loadProfile, loadProState, loadVideoCacheStats])
  );

  const syncLevelToCloud = useCallback(async (newLevel: string) => {
    if (!user) return;
    const { error } = await supabase
      .from('profiles')
      .update({ level: newLevel, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    if (error) console.warn('[profile] level cloud sync failed', error.message);
  }, [user]);

  const syncInterestsToCloud = useCallback(async (newInterests: string[]) => {
    if (!user) return;
    const { error } = await supabase
      .from('profiles')
      .update({ interests: newInterests, updated_at: new Date().toISOString() })
      .eq('id', user.id);
    if (error) console.warn('[profile] interests cloud sync failed', error.message);
  }, [user]);

  const saveLevel = async (newLevel: string) => {
    setLevel(newLevel);
    setShowLevelModal(false);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('user_level', newLevel);
      if (Platform.OS !== 'web') {
        await updateUserProfile({ level: newLevel as CEFRLevel });
      }
      await syncLevelToCloud(newLevel);
    } catch (e) {
      console.warn('Failed to save level:', e);
    }
  };

  const saveInterests = async (newIds: string[]) => {
    const currentDomains = DOMAINS_BY_LEVEL[level] ?? DOMAINS_BY_LEVEL['B1'];
    const newLabels = newIds.map(id => currentDomains.find((d: Domain) => d.id === id)?.label ?? id);
    setInterests(newLabels);
    setShowInterestsModal(false);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('user_interests', JSON.stringify(newLabels));
      if (Platform.OS !== 'web') {
        await updateUserProfile({ interests: newLabels });
      }
      await syncInterestsToCloud(newLabels);
    } catch (e) {
      console.warn('Failed to save interests:', e);
    }
  };

  const openProfileModal = () => {
    setDraftLevel(level);
    const currentDomains = DOMAINS_BY_LEVEL[level] ?? DOMAINS_BY_LEVEL['B1'];
    const ids = interests.map(label => currentDomains.find((d: Domain) => d.label === label)?.id ?? '');
    setDraftInterests(ids.filter(Boolean));
    setProfileStep('level');
    setShowProfileModal(true);
  };

  const saveProfileModal = async () => {
    const currentDomains = DOMAINS_BY_LEVEL[draftLevel] ?? DOMAINS_BY_LEVEL['B1'];
    const newLabels = draftInterests.map(id => currentDomains.find((d: Domain) => d.id === id)?.label ?? id);
    setLevel(draftLevel);
    setInterests(newLabels);
    setShowProfileModal(false);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('user_level', draftLevel);
      await AsyncStorage.setItem('user_interests', JSON.stringify(newLabels));
      if (Platform.OS !== 'web') {
        await updateUserProfile({ level: draftLevel as CEFRLevel, interests: newLabels });
      }
      if (user) {
        const { error } = await supabase
          .from('profiles')
          .update({
            level: draftLevel,
            interests: newLabels,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);
        if (error) console.warn('[profile] modal cloud sync failed', error.message);
      }
    } catch (e) {
      console.warn('Failed to save profile:', e);
    }
  };

  const toggleDraftInterest = (id: string) => {
    setDraftInterests(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length >= MAX_INTERESTS ? prev : [...prev, id]
    );
  };

  const saveTtsConfig = async (cfg: TtsConfig) => {
    const normalizedCfg = normalizeTtsConfig(cfg);
    setTtsConfig(normalizedCfg);
    setDraftTtsConfig(normalizedCfg);
    setShowTtsModal(false);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('tts_config', JSON.stringify(normalizedCfg));
    } catch { /* ignore */ }
  };

  const handlePreview = async () => {
    if (isPreviewPlaying) { stopCurrentTTS(); setIsPreviewPlaying(false); return; }
    setIsPreviewPlaying(true);
    try {
      // 配额包装器: 系统 TTS 免费, 第三方先扣 tts 再 speak
      await speakTextWithQuota(PREVIEW_TEXT, draftTtsConfig.voice, draftTtsConfig.speed);
    } catch { /* ignore */ } finally {
      setIsPreviewPlaying(false);
    }
  };

  const handleClearVideoCache = useCallback(() => {
    Alert.alert(
      '清除本地视频缓存',
      '会删除已经缓存到本地的视频文件，下次播放时会重新边播边缓存。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: async () => {
            setIsClearingVideoCache(true);
            try {
              await clearVideoCache();
              await loadVideoCacheStats();
              Alert.alert('已清除', '本地视频缓存已清空。');
            } catch {
              Alert.alert('清除失败', '本地视频缓存清除失败，请稍后再试。');
            } finally {
              setIsClearingVideoCache(false);
            }
          },
        },
      ]
    );
  }, [loadVideoCacheStats]);

  const handleCheckAppUpdate = useCallback(async () => {
    if (isCheckingAppUpdate || isDownloadingManualUpdate) {
      return;
    }

    setIsCheckingAppUpdate(true);
    setManualUpdateError(null);

    try {
      const result = await checkForAndroidAppUpdate({ ignoreSkippedVersion: true });
      if (result.status === 'available') {
        setManualUpdate(result.update);
        setIsManualUpdateVisible(true);
        return;
      }

      if (result.status === 'upToDate') {
        Alert.alert('当前已是最新版本', '你当前安装的已经是最新版本。');
        return;
      }

      if (result.status === 'unsupported') {
        Alert.alert('当前环境不支持', '请在 Android 安装包环境中使用应用内更新。');
        return;
      }

      Alert.alert('未启用更新', '当前未配置远程更新清单地址。');
    } catch (error) {
      Alert.alert('检查更新失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsCheckingAppUpdate(false);
    }
  }, [isCheckingAppUpdate, isDownloadingManualUpdate]);

  const handleManualUpdateNow = useCallback(async () => {
    if (!manualUpdate || isDownloadingManualUpdate) {
      return;
    }

    setManualUpdateError(null);
    setIsDownloadingManualUpdate(true);
    setManualUpdateProgress(0);

    try {
      const fileUri = await downloadAndroidUpdateApk(manualUpdate, setManualUpdateProgress);
      await installAndroidUpdateApk(fileUri);
    } catch (error) {
      setManualUpdateError(error instanceof Error ? error.message : '更新失败，请稍后重试');
    } finally {
      setIsDownloadingManualUpdate(false);
    }
  }, [isDownloadingManualUpdate, manualUpdate]);

  const handleManualUpdateLater = useCallback(() => {
    if (isDownloadingManualUpdate) {
      return;
    }

    setIsManualUpdateVisible(false);
    setManualUpdate(null);
    setManualUpdateError(null);
    setManualUpdateProgress(0);
  }, [isDownloadingManualUpdate]);

  const levelObj = LEVELS.find(l => l.id === level) ?? LEVELS[2];
  const interestsDesc = interests.length > 0
    ? interests.map(i => i.replace(/^[^\s]+ /, '')).join('、')
    : '未设置';
  const ttsVoiceLabel = TTS_VOICES.find(v => v.id === ttsConfig.voice)?.label ?? '活力女声';
  const currentVersionName = Constants.expoConfig?.version ?? '未知版本';
  const currentVersionCode = Constants.expoConfig?.android?.versionCode;
  const versionDesc = currentVersionCode ? `当前版本 ${currentVersionName} (${currentVersionCode})` : `当前版本 ${currentVersionName}`;
  const videoCacheDesc = Platform.OS === 'web'
    ? 'Web 端不使用本地视频缓存'
    : videoCacheStats.fileCount > 0
      ? `已缓存 ${videoCacheStats.fileCount} 个视频 · ${formatCacheSize(videoCacheStats.totalSize)}`
      : '当前没有本地视频缓存';
  const connectedProviderLabels = cloudDriveSummary.connectedProviders.map((provider) => provider === 'baidu_pan' ? '百度' : '云盘');
  const cloudDriveDesc = cloudDriveSummary.connectedProviders.length === 0
    ? '连接百度网盘，设置同步目录并管理来源'
    : `已连接 ${connectedProviderLabels.join('、')} · 默认 ${cloudDriveSummary.defaultProvider === 'baidu_pan' ? '百度' : '未设置'} · ${cloudDriveSummary.importedCloudVideoCount} 个云端视频`;

  return (
    <View style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Page header — matches videos.tsx / AiPracticeHome.tsx / review.tsx. */}
        <View style={sectionStyles.pageHeader}>
          <View style={sectionStyles.pageHeaderInfo}>
            <Text style={sectionStyles.pageTitle}>我的</Text>
          </View>
        </View>

        {/* ─── User Card — switches by auth state ─── */}
        {user ? (
          <Pressable style={styles.userCard} onPress={() => router.push('/settings')}>
            {cloudProfile?.avatarUrl ? (
              <Image
                source={{ uri: cloudProfile.avatarUrl }}
                style={styles.avatarImage}
                resizeMode="cover"
              />
            ) : (
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(cloudProfile?.displayName || user.email || '?').slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.userTextCol}>
              <Text style={styles.userName} numberOfLines={1}>
                {cloudProfile?.displayName || user.email?.split('@')[0] || 'NativeOS 学员'}
              </Text>
              <Text style={styles.userMeta} numberOfLines={1}>
                {user.email}{dayCount > 0 ? ` · 第 ${dayCount} 天` : ''}
              </Text>
              {/* Pro / 普通用户 标识 — 点击打开会员详情 (兑换/购买入口) */}
              <Pressable
                onPress={() => router.push('/membership')}
                style={({ pressed }) => [
                  styles.tierChipWrap,
                  pressed && styles.tierChipPressed,
                ]}
                hitSlop={6}
              >
                {(() => {
                  const isProActive =
                    proState.tier === 'pro' &&
                    (!proState.expiresAt ||
                      new Date(proState.expiresAt).getTime() > Date.now());
                  if (isProActive) {
                    return (
                      <View style={styles.tierChipPro}>
                        <Crown size={11} color="#B45309" />
                        <Text style={styles.tierChipTextPro} numberOfLines={1}>
                          {proState.expiresAt
                            ? `Pro · ${formatProExpiry(proState.expiresAt)} 到期`
                            : 'Pro 已激活'}
                        </Text>
                      </View>
                    );
                  }
                  return (
                    <View style={styles.tierChipFree}>
                      <Sparkles size={11} color="#5A5A5A" />
                      <Text style={styles.tierChipTextFree} numberOfLines={1}>
                        免费用户
                      </Text>
                    </View>
                  );
                })()}
              </Pressable>
              {/* BYOK 标识 — 独立 chip,仅在启用时显示,点击打开配置 */}
              {byokCfg?.enabled && byokCfg.apiKeyB64 && (
                <Pressable
                  onPress={() => router.push('/byok')}
                  style={({ pressed }) => [
                    styles.tierChipWrap,
                    { marginTop: 4 },
                    pressed && styles.tierChipPressed,
                  ]}
                  hitSlop={6}
                >
                  <View style={styles.tierChipByok}>
                    <KeyRound size={11} color="#5B21B6" />
                    <Text style={styles.tierChipTextByok} numberOfLines={1}>
                      BYOK · {byokProviderShortName(byokCfg.provider)}
                    </Text>
                  </View>
                </Pressable>
              )}
            </View>
            <View style={styles.userCardActions}>
              <Pressable
                style={styles.cardActionBtn}
                onPress={() => router.push('/profile-edit')}
              >
                <Text style={styles.cardActionText}>编辑</Text>
              </Pressable>
            </View>
          </Pressable>
        ) : (
          <Pressable style={styles.userCard} onPress={() => router.push('/login')}>
            <View style={[styles.avatar, styles.avatarMuted]}>
              <Text style={[styles.avatarText, styles.avatarTextMuted]}>N</Text>
            </View>
            <View style={styles.userTextCol}>
              <Text style={styles.userName} numberOfLines={1}>未登录</Text>
              <Text style={styles.userMeta} numberOfLines={2}>登录后可同步资料到云端</Text>
            </View>
            <View style={[styles.cardActionBtn, styles.cardActionBtnPrimary, styles.loginBtn]}>
              <Text style={[styles.cardActionText, styles.cardActionTextInverse]}>登录</Text>
            </View>
          </Pressable>
        )}

        {/* ─── Stats Row ─── */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{cardCount}</Text>
            <Text style={styles.statLabel}>词块</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{dayCount}</Text>
            <Text style={styles.statLabel}>天</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{level}</Text>
            <Text style={styles.statLabel}>等级</Text>
          </View>
        </View>

        {/* ─── Settings List ─── */}
        <View style={styles.settingsList}>
          {/* ⭐ Stats 统计入口 — 第一个,跟"设置"同款样式 */}
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/stats')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: 'rgba(47,111,94,0.10)' }]}>
              <BarChart3 size={20} color="#2f6f5e" />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>统计</Text>
              <Text style={styles.settingsDesc}>你最近看了多少、听了多少、跟读了多少</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/settings')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: colors.surfaceSecondary }]}>
              <SettingsIcon size={20} color={colors.text.primary} />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>设置</Text>
              <Text style={styles.settingsDesc}>编辑资料、退出登录、关于</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/byok')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#F5F3FF' }]}>
              <KeyRound size={20} color="#7C3AED" />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>我的 API 密钥 (BYOK)</Text>
              <Text style={styles.settingsDesc} numberOfLines={1}>
                {byokCfg?.enabled && byokCfg.apiKeyB64
                  ? `已启用 · ${byokProviderLabel(byokCfg.provider)}`
                  : '使用你自己的 OpenAI / Anthropic / DeepSeek / 豆包 等 key'}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/membership')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#FFF7ED' }]}>
              {proState.tier === 'pro' ? (
                <Crown size={20} color="#D97706" />
              ) : (
                <Sparkles size={20} color="#D97706" />
              )}
            </View>
            <View style={styles.settingsText}>
              <View style={styles.proRow}>
                <Text style={styles.settingsTitle}>Pro 会员</Text>
                {proState.tier === 'pro' && (
                  <View style={styles.proChip}>
                    <Text style={styles.proChipText}>PRO</Text>
                  </View>
                )}
              </View>
              <Text style={styles.settingsDesc} numberOfLines={1}>
                {proState.tier === 'pro' && proState.expiresAt
                  ? `已激活 · ${formatProExpiry(proState.expiresAt)} 到期`
                  : '兑换码激活，解锁更大 AI / 语音额度'}
              </Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={openProfileModal}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#EFF6FF' }]}>
              <BrainCircuit size={20} color={colors.primary} />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>等级 &amp; 兴趣设置</Text>
              <Text style={styles.settingsDesc}>{levelObj.stage} {levelObj.badge} · {interestsDesc}</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>
          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/cloud-drives')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#EFF6FF' }]}> 
              <Cloud size={20} color={colors.primary} />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>我的网盘</Text>
              <Text style={styles.settingsDesc}>{cloudDriveDesc}</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => router.push('/official-video-transfer')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#F5F3FF' }]}> 
              <Link2 size={20} color="#7C3AED" />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>推荐视频转存</Text>
              <Text style={styles.settingsDesc}>查看百度网盘分享链接，复制后自行转存</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={() => { setDraftTtsConfig(ttsConfig); setShowTtsModal(true); }}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#F0FDF4' }]}>
              <Volume2 size={20} color="#10B981" />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>TTS 音色配置</Text>
              <Text style={styles.settingsDesc}>{ttsVoiceLabel}</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

          <Pressable
            style={[styles.settingsItem, styles.settingsItemBorder]}
            onPress={handleCheckAppUpdate}
            disabled={isCheckingAppUpdate || isDownloadingManualUpdate}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#FFF7ED' }]}>
              {isCheckingAppUpdate ? <ActivityIndicator size="small" color="#F97316" /> : <Flag size={20} color="#F97316" />}
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>检查版本更新</Text>
              <Text style={styles.settingsDesc}>{isCheckingAppUpdate ? '正在检查更新…' : versionDesc}</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

          <Pressable
            style={styles.settingsItem}
            onPress={handleClearVideoCache}
            disabled={isClearingVideoCache || Platform.OS === 'web'}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#FEF2F2' }]}>
              {isClearingVideoCache ? <ActivityIndicator size="small" color="#EF4444" /> : <Trash2 size={20} color="#EF4444" />}
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>清除本地视频缓存</Text>
              <Text style={styles.settingsDesc}>{isClearingVideoCache ? '正在清除缓存…' : videoCacheDesc}</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

          <Pressable
            style={styles.settingsItem}
            onPress={() => router.push('/contact-author')}
          >
            <View style={[styles.settingsIconBox, { backgroundColor: '#F5F3FF' }]}>
              <MessageCircleMore size={20} color="#7C3AED" />
            </View>
            <View style={styles.settingsText}>
              <Text style={styles.settingsTitle}>联系作者</Text>
              <Text style={styles.settingsDesc}>有问题或者有建议都可以联系作者</Text>
            </View>
            <ChevronRight size={18} color={colors.text.tertiary} />
          </Pressable>

        </View>
      </ScrollView>

      <AndroidAppUpdateModal
        visible={isManualUpdateVisible}
        update={manualUpdate}
        isDownloading={isDownloadingManualUpdate}
        progress={manualUpdateProgress}
        errorMessage={manualUpdateError}
        onUpdateNow={handleManualUpdateNow}
        onLater={handleManualUpdateLater}
      />

      {/* ─── Unified Level + Interests Modal ─── */}
      <Modal visible={showProfileModal} transparent animationType="slide" onRequestClose={() => setShowProfileModal(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowProfileModal(false)} />
          <View style={[styles.modalSheet, { maxHeight: '90%' }]}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {profileStep === 'interests' && (
                  <Pressable onPress={() => setProfileStep('level')} hitSlop={8}>
                    <Text style={{ fontSize: 13, color: colors.primary, fontWeight: fontWeight.medium }}>&lt; 返回</Text>
                  </Pressable>
                )}
                <Text style={styles.modalTitle}>
                  {profileStep === 'level' ? '选择英语等级' : '选择兴趣场景'}
                </Text>
              </View>
              <Pressable onPress={() => setShowProfileModal(false)}>
                <X size={22} color={colors.text.secondary} />
              </Pressable>
            </View>

            {/* Step indicators */}
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
              <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.primary }} />
              <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: profileStep === 'interests' ? colors.primary : colors.border.light }} />
            </View>

            {profileStep === 'level' ? (
              <>
                <Text style={styles.modalSubtitle}>选好等级后，下一步会展示专属主题</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {LEVELS.map(lv => (
                    <Pressable
                      key={lv.id}
                      style={[styles.levelRow, draftLevel === lv.id && styles.levelRowSelected]}
                      onPress={() => {
                        setDraftLevel(lv.id);
                        setDraftInterests([]);
                      }}
                    >
                      <View style={[styles.levelBadge, draftLevel === lv.id && styles.levelBadgeSelected]}>
                        <Text style={styles.levelStage}>{lv.stage}</Text>
                        <Text style={[styles.levelBadgeText, draftLevel === lv.id && styles.levelBadgeTextSelected]}>{lv.badge}</Text>
                      </View>
                      <View style={styles.levelTextCol}>
                        <Text style={[styles.levelTitle, draftLevel === lv.id && styles.levelTitleSelected]}>{lv.title}</Text>
                        <Text style={styles.levelAnchor}>{lv.vocab} · {lv.anchor}</Text>
                      </View>
                      {draftLevel === lv.id && <Check size={18} color={colors.primary} />}
                    </Pressable>
                  ))}
                </ScrollView>
                <Pressable style={styles.modalConfirmBtn} onPress={() => setProfileStep('interests')}>
                  <Text style={styles.modalConfirmText}>下一步：选兴趣场景 →</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.modalSubtitle}>为 {draftLevel} 等级选择最多 {MAX_INTERESTS} 个场景，已选 {draftInterests.length} / {MAX_INTERESTS}</Text>
                <ScrollView showsVerticalScrollIndicator={false} style={styles.domainScrollArea}>
                  <View style={styles.domainGrid}>
                    {(DOMAINS_BY_LEVEL[draftLevel] ?? DOMAINS_BY_LEVEL['B1']).map((d: Domain) => {
                      const sel = draftInterests.includes(d.id);
                      return (
                        <Pressable
                          key={d.id}
                          style={[styles.domainCard, sel && styles.domainCardSelected]}
                          onPress={() => {
                            setDraftInterests(prev =>
                              prev.includes(d.id)
                                ? prev.filter(x => x !== d.id)
                                : prev.length >= MAX_INTERESTS ? prev : [...prev, d.id]
                            );
                          }}
                        >
                          <Text style={[styles.domainLabel, sel && styles.domainLabelSelected]}>{d.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
                <Pressable
                  style={[styles.modalConfirmBtn, draftInterests.length === 0 && styles.modalConfirmBtnDisabled]}
                  onPress={saveProfileModal}
                  disabled={draftInterests.length === 0}
                >
                  <Text style={[styles.modalConfirmText, draftInterests.length === 0 && styles.modalConfirmTextDisabled]}>保存设置</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ─── TTS Config Modal ─── */}
      <Modal visible={showTtsModal} transparent animationType="slide" onRequestClose={() => setShowTtsModal(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowTtsModal(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>TTS 音色配置</Text>
              <Pressable onPress={() => setShowTtsModal(false)}>
                <X size={22} color={colors.text.secondary} />
              </Pressable>
            </View>

            <Text style={styles.ttsLabel}>NPC 音色 (Voice)</Text>
            <View style={styles.ttsVoiceGrid}>
              {TTS_VOICES.map(v => (
                <Pressable
                  key={v.id}
                  style={[styles.ttsVoiceBtn, draftTtsConfig.voice === v.id && styles.ttsVoiceBtnActive]}
                  onPress={() => {
                    setDraftTtsConfig(c => ({ ...c, voice: v.id }));
                    stopCurrentTTS();
                    setIsPreviewPlaying(true);
                    // 音色预览: 走配额包装器
                    speakTextWithQuota(PREVIEW_TEXT, v.id, 1.0)
                      .catch(() => {})
                      .finally(() => setIsPreviewPlaying(false));
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {draftTtsConfig.voice === v.id && isPreviewPlaying
                      ? <ActivityIndicator size="small" color="#10B981" style={{ width: 12, height: 12 }} />
                      : null}
                    <Text style={[styles.ttsVoiceName, draftTtsConfig.voice === v.id && styles.ttsVoiceNameActive]}>{v.label}</Text>
                  </View>
                  <Text style={[styles.ttsVoiceDesc, draftTtsConfig.voice === v.id && styles.ttsVoiceDescActive]}>{v.desc}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable style={styles.modalConfirmBtn} onPress={() => saveTtsConfig(draftTtsConfig)}>
              <Text style={styles.modalConfirmText}>保存配置</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Interests modal kept for legacy but hidden — unified modal handles it */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: {
    paddingTop: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: 120,
    gap: spacing.lg,
  },

  /* User Card */
  userCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xxl,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.light,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  avatarImage: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.full,
    flexShrink: 0,
    backgroundColor: colors.surfaceSecondary,
  },
  avatarText: {
    color: colors.text.inverse,
    fontSize: 24,
    fontWeight: fontWeight.bold,
  },
  userName: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 4,
  },
  userTextCol: {
    flex: 1,
    minWidth: 0,
  },
  userMeta: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  /* Logged-out avatar is dimmed to signal "tap to log in" */
  avatarMuted: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  avatarTextMuted: {
    color: colors.text.tertiary,
  },
  /* Right-side action chips inside the user card */
  userCardActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  cardActionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
  },
  cardActionBtnPrimary: {
    backgroundColor: colors.text.primary,
    borderColor: colors.text.primary,
  },
  cardActionBtnSecondary: {
    backgroundColor: 'transparent',
  },
  cardActionText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  cardActionTextInverse: {
    color: colors.text.inverse,
  },
  cardActionTextSecondary: {
    color: colors.text.tertiary,
  },
  /* Logged-out compact login button — fixed-size pill on the right */
  loginBtn: {
    flexShrink: 0,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },

  /* Stats */
  statsRow: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  statItem: { flex: 1, alignItems: 'center' },
  statValue: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 2,
  },
  statLabel: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border.light,
  },

  /* Settings list */
  settingsList: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
  settingsItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.md,
  },
  settingsItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.light,
  },
  settingsIconBox: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsText: { flex: 1 },
  settingsTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 2,
  },
  settingsDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },

  /* Modals */
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.lg,
    paddingBottom: 48,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  modalSubtitle: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  modalConfirmBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    paddingVertical: 15,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
  },
  modalConfirmBtnDisabled: {
    backgroundColor: '#E5E7EB',
  },
  modalConfirmText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: colors.text.inverse,
  },
  modalConfirmTextDisabled: {
    color: '#9CA3AF',
  },

  /* Level rows in modal */
  levelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.lg,
    marginBottom: 4,
  },
  levelRowSelected: {
    backgroundColor: '#EFF6FF',
  },
  levelBadge: {
    width: 50,
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#F3F4F6',
    borderRadius: borderRadius.md,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  levelBadgeSelected: {
    backgroundColor: '#DBEAFE',
  },
  levelStage: { fontSize: 14 },
  levelBadgeText: {
    fontSize: 12,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
  },
  levelBadgeTextSelected: {
    color: '#1D4ED8',
  },
  levelTextCol: { flex: 1 },
  levelTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 1,
  },
  levelTitleSelected: { color: '#1D4ED8' },
  levelAnchor: {
    fontSize: 10,
    color: colors.text.tertiary,
  },

  domainScrollArea: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 120,
    maxHeight: 320,
    marginBottom: 0,
  },

  /* Domain grid in modal */
  domainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  domainCard: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: '#F3F4F6',
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  domainCardSelected: {
    backgroundColor: '#EFF6FF',
    borderColor: colors.primary,
  },
  domainLabel: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  domainLabelSelected: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },

  /* TTS config modal */
  ttsLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  ttsVoiceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: 4,
  },
  ttsVoiceBtn: {
    width: '30%',
    flexGrow: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: '#F3F4F6',
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  ttsVoiceBtnActive: {
    backgroundColor: '#EFF6FF',
    borderColor: colors.primary,
  },
  ttsVoiceName: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
  },
  ttsVoiceNameActive: { color: colors.primary },
  ttsVoiceDesc: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 1,
  },
  ttsVoiceDescActive: { color: '#60A5FA' },
  ttsSpeedRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: 4,
  },
  ttsSpeedBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: '#F3F4F6',
    borderWidth: 1.5,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  ttsSpeedBtnActive: {
    backgroundColor: '#EFF6FF',
    borderColor: colors.primary,
  },
  ttsSpeedText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
  },
  ttsSpeedTextActive: { color: colors.primary },
  ttsPreviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    marginTop: spacing.md,
    marginBottom: 4,
    alignSelf: 'flex-start',
  },
  ttsPreviewText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: '#10B981',
  },

  // ── Pro chip on the "Pro 会员" settings item ─────────────────────
  proRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  proChip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  proChipText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#B45309',
    letterSpacing: 0.5,
  },

  // ── Tier chip on userCard (Pro / 免费用户) ──────────────────────
  tierChipWrap: {
    alignSelf: 'flex-start',
    marginTop: 6,
  },
  tierChipPressed: {
    opacity: 0.6,
  },
  tierChipPro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  tierChipTextPro: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B45309',
    letterSpacing: 0.2,
  },
  tierChipFree: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#F3F3F3',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  tierChipTextFree: {
    fontSize: 11,
    fontWeight: '500',
    color: '#5A5A5A',
    letterSpacing: 0.2,
  },
  tierChipByok: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#F5F3FF',
    borderWidth: 1,
    borderColor: '#DDD6FE',
  },
  tierChipTextByok: {
    fontSize: 11,
    fontWeight: '500',
    color: '#5B21B6',
    letterSpacing: 0.2,
  },

});

export default ProfileScreen;
