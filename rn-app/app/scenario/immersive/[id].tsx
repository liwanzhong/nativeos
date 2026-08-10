import {
  View, Text, StyleSheet, Pressable, ScrollView,
  Modal, ActivityIndicator, Animated, Platform,
  Easing, StatusBar,
} from 'react-native';
import Live2DAvatar from '../../../components/Live2DAvatar';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import * as Haptics from 'expo-haptics';
import {
  ChevronLeft, Settings, Mic, Lightbulb,
  Volume2, X, CheckCircle2, SlidersHorizontal,
  Zap, Activity, RotateCcw, Star,
} from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../../constants/theme';
import { createCard, deleteCard, findWordCardByTopic, findSentenceCardByTopic, getCardsBySource } from '../../../lib/database';
import { enterSandbox, recordTurn, exitSandbox } from '../../../lib/session/session-manager';
import { getSelectedScenario, type ScenarioSourceType } from '../../../lib/ai/scenario-generator';
import { getNPCReply, generateHints, translateText } from '../../../lib/ai/npc-chat';
import type { ChatTurn, HintSuggestion, NPCReplyResult } from '../../../lib/ai/npc-chat';
import { DictionaryLookupSheet, type SaveWordToHistoryPayload } from '../../../components/dictionary/DictionaryLookupSheet';
import { startVolcASR, type ASRHandle, type ASRResult } from '../../../lib/volcengine/asr';
import { speakWithVolcTTS, speakTextWithQuota, stopCurrentTTS, isSystemTTSVoice } from '../../../lib/volcengine/tts';
import { assessShadowingReply, assessSpokenReply, mapAssessmentToLegacyEvaluation, type EvaluationResult, type SpeechAssessment } from '../../../lib/ai/speech-evaluator';
import { getSpeechAssessmentIcon, getSpeechAssessmentLabel, getSpeechAssessmentTitle, resolveTeachingAction, shouldPersistSpeechAssessment, shouldShowSpeechAssessmentEntry, shouldShowSpeechAssessmentModal } from '../../../lib/speech/teaching-policy';
import { consumeAndNotify, isByokEnabled } from '../../../lib/quota';
import { quotaDialog } from '../../../components/quota/QuotaBlockedDialog';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createInitialConversationRuntime,
  deriveTaskContract,
  normalizeConversationRuntime,
  type ConversationRuntimeState,
  type ScenarioTaskContract,
} from '../../../lib/ai/conversation-runtime';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScenarioData {
  sourceType?: ScenarioSourceType;
  icon: string;
  category: string;
  title: string;
  npcName: string;
  npcRole: string;
  npcEmoji: string;
  modelUrl?: string;
  task: string;
  desc?: string;           // English task description for display
  descZh?: string;         // Chinese translation of desc (pre-generated)
  initMessages: Message[];
  npcSystemPrompt?: string;
  taskContract?: ScenarioTaskContract;
  userInitiates?: boolean;
  environmentalCue?: string;    // Chinese environmental narration
  environmentalCueEn?: string;  // English environmental narration (default display)
  npcStatus?: string;
}

interface Message {
  id: number;
  role: 'npc' | 'user' | 'system';
  text: string;
  showTranslation?: boolean;
  translation?: string;
  audioUrl?: string | null;
  highlightWord?: string;
  evaluation?: EvaluationResult;
  speechAssessment?: SpeechAssessment;
  evaluating?: boolean;
}

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

// ─── Helper ────────────────────────────────────────────────────────────────────

function ensureScenarioData(scenario: ScenarioData): ScenarioData {
  const taskContract = scenario.taskContract ?? deriveTaskContract({
    title: scenario.title,
    desc: scenario.desc || scenario.task,
    category: scenario.category,
    npcName: scenario.npcName,
    npcStatus: scenario.npcStatus,
    npcSystemPrompt: scenario.npcSystemPrompt,
    openingLine: scenario.initMessages.find((msg) => msg.role === 'npc')?.text,
    environmentalCue: scenario.environmentalCue,
    environmentalCueEn: scenario.environmentalCueEn,
  });

  return {
    ...scenario,
    taskContract,
  };
}

// ─── Static DB ────────────────────────────────────────────────────────────────

const SCENARIO_DB: Record<string, ScenarioData> = {
  '1': {
    icon: '🏕️', category: '户外生存', title: '周末露营计划',
    npcName: 'Alex', npcRole: 'Camping Buddy', npcEmoji: '🧑‍🤝‍🧑',
    task: '确认本周末的露营细节',
    initMessages: [{ id: 1, role: 'npc', text: "Hey! Are we doing the camping trip this weekend or what?", showTranslation: false }],
  },
  '2': {
    icon: '💻', category: '职场与代码', title: '汇报服务器宕机',
    npcName: 'Sarah', npcRole: 'Tech Lead', npcEmoji: '👨‍💼',
    task: '安抚上司并汇报处理进展',
    initMessages: [{ id: 1, role: 'npc', text: "What happened to the production server? It's been down for 20 minutes!", showTranslation: false }],
  },
  '3': {
    icon: '✈️', category: '机场求生', title: '航班因天气取消',
    npcName: 'Officer Kim', npcRole: 'Gate Agent', npcEmoji: '👨‍✈️',
    task: '争取转机或补偿方案',
    initMessages: [{ id: 1, role: 'npc', text: "I'm sorry, but flight UA102 has been cancelled due to severe weather conditions.", showTranslation: false }],
  },
  '4': {
    icon: '☕', category: '日常点单', title: '星巴克高级定制',
    npcName: 'Senko', npcRole: 'Barista', npcEmoji: '🧑‍🍳',
    modelUrl: 'models/senko/senko.model3.json',
    task: '将牛奶换成燕麦奶',
    initMessages: [{ id: 1, role: 'npc', text: "Hi! Welcome to Starbucks. What can I get for you today?", showTranslation: false }],
  },
  '5': {
    icon: '📧', category: '商务沟通', title: '高情商催尾款',
    npcName: 'Mr. Chen', npcRole: 'Finance Manager', npcEmoji: '💼',
    task: '礼貌但坚定地催收尾款',
    initMessages: [{ id: 1, role: 'npc', text: "We haven't processed the payment yet. Let me check with finance.", showTranslation: false }],
  },
};

Object.keys(SCENARIO_DB).forEach((key) => {
  SCENARIO_DB[key] = ensureScenarioData(SCENARIO_DB[key]!);
});

const DEFAULT_SCENARIO = ensureScenarioData(SCENARIO_DB['3']);

// ─── Animated waveform bars ───────────────────────────────────────────────────

const WAVE_HEIGHTS = [1, 3, 2, 4, 2, 3, 1, 2, 3, 1];

const AnimatedWaveform = memo(({ isPlaying, color }: { isPlaying: boolean; color: string }) => {
  const anims = useRef(WAVE_HEIGHTS.map(() => new Animated.Value(1))).current;

  useEffect(() => {
    if (isPlaying) {
      const loops = anims.map((anim, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 60),
            Animated.timing(anim, { toValue: 1.8, duration: 300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(anim, { toValue: 0.5, duration: 300, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(anim, { toValue: 1,   duration: 200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ])
        )
      );
      loops.forEach(l => l.start());
      return () => loops.forEach(l => l.stop());
    } else {
      anims.forEach(a => {
        a.stopAnimation();
        Animated.spring(a, { toValue: 1, useNativeDriver: true }).start();
      });
    }
  }, [isPlaying]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 16 }}>
      {WAVE_HEIGHTS.map((h, i) => (
        <Animated.View
          key={i}
          style={{
            width: 2.5,
            height: h * 3,
            borderRadius: 2,
            backgroundColor: color,
            transform: [{ scaleY: anims[i] }],
          }}
        />
      ))}
    </View>
  );
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ImmersiveScenarioScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const initialScenario = ensureScenarioData(SCENARIO_DB[id as string] || DEFAULT_SCENARIO);
  const isStaticId = !!(id && SCENARIO_DB[id as string]);
  const [scenarioSourceType, setScenarioSourceType] = useState<ScenarioSourceType>(isStaticId ? 'static_scenario' : 'ai_scenario');
  const [scenario, setScenario] = useState<ScenarioData>(initialScenario);
  const [scenarioReady, setScenarioReady] = useState(isStaticId);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntimeState>(() => createInitialConversationRuntime(initialScenario.taskContract!));

  const initialMessages = isStaticId ? SCENARIO_DB[id as string]!.initMessages : [];
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const messagesRef = useRef<Message[]>(initialMessages);

  const [isRecording, setIsRecording] = useState(false);
  const [isAsrProcessing, setIsAsrProcessing] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [isTtsSpeaking, setIsTtsSpeaking] = useState(false);
  const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
  // Tracks which auxiliary TTS button is playing: 'word' | 'example' | 'desc' | 'eval-corrected' | 'shadow' | `env-${msgId}`
  const [playingTtsKey, setPlayingTtsKey] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);

  // Hint sheet
  const [hintOptions, setHintOptions] = useState<HintSuggestion[]>([]);
  const [isHintLoading, setIsHintLoading] = useState(false);
  const [showHintSheet, setShowHintSheet] = useState(false);

  // Shadowing teleprompter
  const [shadowingText, setShadowingText] = useState<string | null>(null);
  const [shadowingTranscript, setShadowingTranscript] = useState('');
  const [shadowingRecording, setShadowingRecording] = useState(false);
  const [shadowingState, setShadowingState] = useState<'idle' | 'recording'>('idle');
  const [isShadowingProcessing, setIsShadowingProcessing] = useState(false);
  const [shadowingError, setShadowingError] = useState('');
  const shadowingAsrRef = useRef<ASRHandle | null>(null);

  // Word lookup (本地 ECDICT — DictionaryLookupSheet 自己 query)
  const [lookupState, setLookupState] = useState<{ word: string; contextSentence: string; msgId: number } | null>(null);

  // Sentence card map (content → card) for the current topic. Used to:
  //   1. Show a filled star on messages that are already in FSRS
  //   2. Compute isSentenceSaved / isWordSaved for DictionaryLookupSheet
  //   3. Drive handleToggleMessageCard dedup
  const [messageCardByContent, setMessageCardByContent] = useState<Map<string, { id: string }>>(() => new Map());
  const [wordSaved, setWordSaved] = useState(false);
  const [sentenceSaved, setSentenceSaved] = useState(false);

  const loadTopicSentenceCards = useCallback(async (topicId: string) => {
    if (!topicId) {
      setMessageCardByContent(new Map());
      return;
    }
    // Load all ai_practice sentence cards for this topic, build a content→id map.
    const all = await getCardsBySource('ai_practice');
    const map = new Map<string, { id: string }>();
    for (const card of all) {
      if (card.type !== 'sentence') continue;
      if (card.practiceContext?.topicId !== topicId) continue;
      const content = (card.content ?? '').trim();
      if (content) map.set(content.toLowerCase(), { id: card.id });
    }
    setMessageCardByContent(map);
  }, []);

  useEffect(() => {
    if (id) void loadTopicSentenceCards(id);
  }, [id, loadTopicSentenceCards]);

  // Sync wordSaved / sentenceSaved from messageCardByContent + current lookup.
  useEffect(() => {
    if (!lookupState) {
      setWordSaved(false);
      setSentenceSaved(false);
      return;
    }
    const wordKey = lookupState.word.toLowerCase();
    const sentenceKey = (lookupState.contextSentence || '').toLowerCase();
    // Word: do a direct find so the lookup is independent of the message-card map
    // (word cards can exist even when the sentence isn't in FSRS).
    (async () => {
      const wordCard = await findWordCardByTopic(id ?? '', wordKey);
      setWordSaved(!!wordCard);
    })();
    if (sentenceKey && sentenceKey !== wordKey) {
      setSentenceSaved(messageCardByContent.has(sentenceKey));
    } else {
      setSentenceSaved(false);
    }
  }, [lookupState, messageCardByContent, id]);

  // Desc translation toggle
  const [descZhVisible, setDescZhVisible] = useState(false);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [sandboxConfig, setSandboxConfig] = useState({ difficulty: 'B2' });
  const [ttsConfig, setTtsConfig] = useState<TtsConfig>(DEFAULT_TTS_CONFIG);
  const ttsConfigRef = useRef<TtsConfig>(DEFAULT_TTS_CONFIG);

  // Toast
  const [toast, setToast] = useState('');

  // Eval modal
  const [evalModal, setEvalModal] = useState<SpeechAssessment | null>(null);

  // Avatar visibility
  const [showAvatar, setShowAvatar] = useState(true);

  const [userLevel, setUserLevel] = useState('B1');
  const sessionIdRef = useRef<string | null>(null);
  const asrHandleRef = useRef<ASRHandle | null>(null);
  const sessionStartedRef = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgCountRef = useRef(0);
  const msgHistoryKey = `npc_immersive_messages_v2__${scenarioSourceType}__${id}`;
  const runtimeStateKey = `${msgHistoryKey}__runtime`;

  // ── Pulse animation ──────────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    pulseLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.12, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 500, useNativeDriver: true }),
      ])
    );
    pulseLoopRef.current.start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseLoopRef.current?.stop();
    Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true }).start();
  }, [pulseAnim]);

  // ── Load user level + TTS config ────────────────────────────────────────────
  const loadPersistedPreferences = useCallback(async () => {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const [lv, rawTts, rawSandbox, rawAvatar] = await Promise.all([
        AsyncStorage.getItem('user_level'),
        AsyncStorage.getItem('tts_config'),
        AsyncStorage.getItem('sandbox_config'),
        AsyncStorage.getItem('show_avatar'),
      ]);
      if (lv) setUserLevel(lv);
      const cfg = rawTts ? normalizeTtsConfig(JSON.parse(rawTts)) : DEFAULT_TTS_CONFIG;
      setTtsConfig(cfg);
      ttsConfigRef.current = cfg;
      if (rawSandbox) {
        try { setSandboxConfig(JSON.parse(rawSandbox)); } catch { /* ignore */ }
      }
      if (rawAvatar != null) setShowAvatar(rawAvatar === 'true');
    } catch {
      setTtsConfig(DEFAULT_TTS_CONFIG);
      ttsConfigRef.current = DEFAULT_TTS_CONFIG;
    }
  }, []);

  useEffect(() => {
    void loadPersistedPreferences();
  }, [loadPersistedPreferences]);

  useFocusEffect(
    useCallback(() => {
      void loadPersistedPreferences();
    }, [loadPersistedPreferences])
  );

  // ── Auto-save messages ───────────────────────────────────────────────────────
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await Promise.all([
          AsyncStorage.setItem(msgHistoryKey, JSON.stringify(messages)),
          AsyncStorage.setItem(runtimeStateKey, JSON.stringify(conversationRuntime)),
        ]);
      } catch { /* non-critical */ }
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [conversationRuntime, messages, msgHistoryKey, runtimeStateKey]);

  // ── Load scenario + history ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const fallbackTimer = setTimeout(() => { if (!cancelled) setScenarioReady(true); }, 200);

    const loadHistory = async (initMsgs: Message[]) => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const raw = await AsyncStorage.getItem(msgHistoryKey);
        if (raw) {
          const saved: Message[] = JSON.parse(raw);
          const valid = saved.filter(m => m && typeof m.text === 'string' && m.text.length > 0);
          if (valid.length > 0) return valid;
        }
      } catch { /* ignore */ }
      return initMsgs;
    };

    const loadRuntime = async (taskContract: ScenarioTaskContract) => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const raw = await AsyncStorage.getItem(runtimeStateKey);
        if (raw) {
          return normalizeConversationRuntime(taskContract, JSON.parse(raw) as Partial<ConversationRuntimeState>);
        }
      } catch { /* ignore */ }
      return createInitialConversationRuntime(taskContract);
    };

    getSelectedScenario(id as string).then(async card => {
      if (cancelled) return;
      clearTimeout(fallbackTimer);
      console.log('[Immersive] getSelectedScenario resolved', {
        routeId: id,
        hasCard: !!card,
        cardId: card?.id,
        sourceType: card?.sourceType,
        title: card?.title,
      });
      if (card && card.id === (id as string)) {
        setScenarioSourceType(card.sourceType || 'ai_scenario');
        const staged = ensureScenarioData({
          sourceType: card.sourceType || 'ai_scenario',
          icon: card.icon,
          category: card.category,
          title: card.title,
          npcName: card.npcName || card.npcEmoji || 'NPC',
          npcRole: card.category,
          npcEmoji: card.npcEmoji || '🤖',
          modelUrl: card.modelUrl || undefined,
          task: card.title,
          desc: card.desc || undefined,
          descZh: card.descZh || undefined,
          npcSystemPrompt: card.npcSystemPrompt,
          taskContract: card.taskContract,
          userInitiates: card.userInitiates,
          environmentalCue: card.environmentalCue,
          environmentalCueEn: card.environmentalCueEn,
          npcStatus: card.npcStatus,
          initMessages: card.userInitiates
            ? [{ id: 1, role: 'system' as const, text: card.environmentalCueEn || card.environmentalCue || card.openingLine || `🎬 ${card.title}`, showTranslation: false, translation: card.environmentalCue || undefined }]
            : [{ id: 1, role: 'npc' as const, text: card.openingLine || `Let's start: ${card.title}`, showTranslation: false, translation: card.openingLineZh || undefined }],
        });
        console.log('[Immersive] staged scenario built from selected card', {
          id: card.id,
          sourceType: staged.sourceType,
          title: staged.title,
          npcName: staged.npcName,
          hasPrompt: !!staged.npcSystemPrompt,
          initMessageRole: staged.initMessages[0]?.role,
          initMessagePreview: staged.initMessages[0]?.text?.slice(0, 80),
        });
        setScenario(staged);
        let restored = await loadHistory(staged.initMessages);
        // Always keep the opening message in sync with the current card (text + translation)
        if (restored.length >= 1 && (restored[0].role === 'npc' || restored[0].role === 'system')) {
          restored = [{ ...restored[0], role: staged.initMessages[0].role, text: staged.initMessages[0].text, translation: staged.initMessages[0].translation, showTranslation: false }, ...restored.slice(1)];
        }
        setMessages(restored);
        messagesRef.current = restored;
        setConversationRuntime(await loadRuntime(staged.taskContract!));
      } else {
        const staticScene = SCENARIO_DB[id as string];
        if (staticScene) {
          console.log('[Immersive] using static scenario fallback', { routeId: id, title: staticScene.title });
          setScenarioSourceType('static_scenario');
          setScenario(staticScene);
          const restored = await loadHistory(staticScene.initMessages);
          setMessages(restored);
          messagesRef.current = restored;
          setConversationRuntime(await loadRuntime(staticScene.taskContract!));
          setScenarioReady(true);
        } else {
          console.warn('[Immersive] no staged card and no static scenario found, routing back', { routeId: id });
          router.back();
          return;
        }
      }
      setScenarioReady(true);
    }).catch(async () => {
      clearTimeout(fallbackTimer);
      const staticScene = SCENARIO_DB[id as string];
      if (staticScene) {
        console.log('[Immersive] getSelectedScenario failed, static fallback used', { routeId: id, title: staticScene.title });
        setScenarioSourceType('static_scenario');
        setScenario(staticScene);
        const restored = await loadHistory(staticScene.initMessages);
        setMessages(restored);
        messagesRef.current = restored;
        setConversationRuntime(await loadRuntime(staticScene.taskContract!));
        setScenarioReady(true);
      } else {
        console.warn('[Immersive] getSelectedScenario failed and no fallback exists, routing back', { routeId: id });
        router.back();
      }
    });

    return () => { cancelled = true; clearTimeout(fallbackTimer); };
  }, [id, msgHistoryKey, router]);

  // ── Enter sandbox session ────────────────────────────────────────────────────
  useEffect(() => {
    if (!scenarioReady || sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    console.log('[Immersive] entering sandbox session', {
      routeId: id,
      sourceType: scenarioSourceType,
      title: scenario.title,
      initMessageCount: scenario.initMessages.length,
      firstMessageRole: scenario.initMessages[0]?.role,
    });
    enterSandbox(id as string, scenario.title).then(sid => {
      console.log('[Immersive] enterSandbox success', {
        routeId: id,
        sessionId: sid,
      });
      sessionIdRef.current = sid;
      if (scenario.initMessages[0]) {
        console.log('[Immersive] recording opening turn', {
          sessionId: sid,
          role: 'npc',
          preview: scenario.initMessages[0].text.slice(0, 80),
        });
        recordTurn(sid, { role: 'npc', text: scenario.initMessages[0].text });
      }
    }).catch((error) => {
      console.warn('[Immersive] enterSandbox failed', error);
    });
  }, [id, scenario, scenarioReady, scenarioSourceType]);

  // Keep messagesRef in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Scroll to bottom only when new messages are added or typing indicator changes
  useEffect(() => {
    if (messages.length > msgCountRef.current || isTyping) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
    msgCountRef.current = messages.length;
  }, [messages, isTyping]);

  // ── Exit ─────────────────────────────────────────────────────────────────────
  const handleExit = useCallback(() => {
    if (sessionIdRef.current) exitSandbox(sessionIdRef.current);
    router.back();
  }, [router]);

  // ── Toast ─────────────────────────────────────────────────────────────────────
  const showToast = (msg: string, duration = 3000) => {
    setToast(msg);
    setTimeout(() => setToast(''), duration);
  };

  const closeEvalModal = () => {
    if (playingTtsKey === 'eval-corrected') {
      stopCurrentTTS();
      setPlayingTtsKey(null);
    }
    setEvalModal(null);
  };

  // ── Send user message ─────────────────────────────────────────────────────────
  const sendUserMessage = async (text: string, audioUrl?: string | null, asrMeta?: ASRResult['asrMeta']) => {
    if (!text.trim()) return;
    stopCurrentTTS();
    // Quota: charge 1 AI round before the LLM call. If the user is
    // already over the limit, surface a gentle dialog and bail.
    // BYOK users bypass the NativeOS daily counter — they're paying
    // for tokens directly, so we don't gate their calls.
    const byokOn = await isByokEnabled();
    if (!byokOn) {
      const aiVerdict = await consumeAndNotify('ai_rounds');
      if (!aiVerdict.allowed) {
        quotaDialog.show({ field: aiVerdict.field, tier: aiVerdict.tier, used: aiVerdict.used, hard: aiVerdict.hard });
        return;
      }
    }
    const msgId = Date.now();
    const userMsg: Message = { id: msgId, role: 'user', text, showTranslation: false, audioUrl, evaluating: true };
    setMessages(prev => [...prev, userMsg]);
    const history: ChatTurn[] = messagesRef.current.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'npc' | 'user', text: m.text }));
    const shouldBlockNpcReply = !!asrMeta?.shouldAskRetry;

    // ── 异步评分（不阻塞对话）─────────────────────────────────────────────────
    console.log('[SpeechEval] 触发评分, msgId=', msgId, 'text=', text);
    assessSpokenReply({
      scenarioTitle: scenario.title,
      scenarioCategory: scenario.category,
      scenarioDesc: scenario.desc,
      taskContract: scenario.taskContract,
      runtimeState: conversationRuntime,
      history,
      userMessage: text,
      userLevel,
      asrMeta,
    }).then((assessment) => {
      console.log('[SpeechEval] 评分结果:', JSON.stringify(assessment));
      const legacyEvaluation = mapAssessmentToLegacyEvaluation(assessment, {
        scenarioTitle: scenario.title,
        userMessage: text,
      });
      const action = resolveTeachingAction(assessment, asrMeta);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, evaluation: legacyEvaluation, speechAssessment: assessment, evaluating: false } : m
      ));
      if (action.action === 'retry_asr') {
        showToast(action.message);
      }
    }).catch((err) => {
      console.error('[SpeechEval] 评分失败:', err);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, evaluating: false } : m
      ));
    });
    // ─────────────────────────────────────────────────────────────────────────

    if (shouldBlockNpcReply) {
      return;
    }

    if (sessionIdRef.current) recordTurn(sessionIdRef.current, { role: 'user', text });

    setIsTyping(true);
    getNPCReply({
      scenarioTitle: scenario.title,
      scenarioCategory: scenario.category,
      scenarioDesc: scenario.desc,
      npcName: scenario.npcName,
      npcStatus: scenario.npcStatus,
      environmentalCue: scenario.environmentalCueEn || scenario.environmentalCue,
      taskContract: scenario.taskContract!,
      runtimeState: conversationRuntime,
      npcSystemPrompt: scenario.npcSystemPrompt,
      history,
      userMessage: text,
      userLevel,
      npcDifficulty: sandboxConfig.difficulty as 'B1' | 'B2' | 'C1',
    }).then(async (result: NPCReplyResult) => {
      setIsTyping(false);
      setConversationRuntime(result.runtimeState);
      const npcMsg: Message = { id: Date.now() + 1, role: 'npc', text: result.text, showTranslation: false, translation: result.translation || undefined };
      setMessages(cur => [...cur, npcMsg]);
      if (sessionIdRef.current) recordTurn(sessionIdRef.current, { role: 'npc', text: result.text });
      // Quota: charge 1 TTS unit per NPC reply. If blocked, still show
      // the text (the user already paid for the AI round) — just don't
      // read it aloud. This matches the "用完只是不能听" graceful UX.
      // System TTS is free (device built-in engine), so we skip the quota
      // check entirely for it.
      let shouldSpeak = true;
      if (!isSystemTTSVoice(ttsConfigRef.current.voice)) {
        const ttsVerdict = await consumeAndNotify('tts');
        shouldSpeak = ttsVerdict.allowed;
      }
      if (shouldSpeak) {
        setIsTtsSpeaking(true);
        speakWithVolcTTS(result.text, ttsConfigRef.current.voice, ttsConfigRef.current.speed).catch(() => {}).finally(() => setIsTtsSpeaking(false));
      }
    }).catch(() => { setIsTyping(false); });
  };

  // ── Mic recording — hold to record, release to transcribe ──────────────────────
  const handleMicPressIn = async () => {
    if (isRecording) return;
    // Quota: charge 1 ASR unit before opening the mic. Soft = silent
    // indicator fires once; hard = gentle dialog, no hard-sell.
    const verdict = await consumeAndNotify('asr');
    if (!verdict.allowed) {
      quotaDialog.show({ field: verdict.field, tier: verdict.tier, used: verdict.used, hard: verdict.hard });
      return;
    }
    console.log('[NPC-Mic] PressIn — starting ASR, platform:', require('react-native').Platform.OS);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsRecording(true);
    startPulse();
    setLiveTranscript('');
    // Set audio session to recording mode so iOS mic gain is not suppressed
    import('expo-av').then(({ Audio }) => {
      Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      }).catch(() => {});
    }).catch(() => {});
    asrHandleRef.current = startVolcASR(
      (partial) => {
        console.log('[NPC-Mic] partial transcript:', partial);
        setLiveTranscript(partial);
      },
      (err) => {
        stopPulse();
        setIsRecording(false);
        asrHandleRef.current = null;
        const name = (err as any)?.name ?? '';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          showToast('未检测到麦克风设备，请插入或启用麦克风');
        } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          showToast('麦克风权限被拒绝，请在浏览器设置中授权');
        } else {
          showToast('无法访问麦克风，请检查设备和权限');
        }
      },
    );
    console.log('[NPC-Mic] startVolcASR called, handle:', asrHandleRef.current);
  };

  const handleMicPressOut = async () => {
    if (!isRecording) return;
    console.log('[NPC-Mic] PressOut — stopping ASR, handle exists:', !!asrHandleRef.current);
    stopPulse();
    setIsRecording(false);
    const handle = asrHandleRef.current;
    asrHandleRef.current = null;
    if (!handle) {
      console.warn('[NPC-Mic] no ASR handle on PressOut');
      return;
    }
    console.log('[NPC-Mic] calling handle.stop()');
    setIsAsrProcessing(true);
    setLiveTranscript('识别中…');
    const result = await handle.stop();
    const { text, audioUrl, asrMeta } = result;
    console.log('[NPC-Mic] ASR result:', text, 'audioUrl:', audioUrl, 'asrMeta:', asrMeta);
    if (text.trim()) {
      setLiveTranscript(text.trim());
      // Brief display of result before sending
      await new Promise(r => setTimeout(r, 600));
    }
    setIsAsrProcessing(false);
    setLiveTranscript('');
    if (text.trim()) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      sendUserMessage(text.trim(), audioUrl, asrMeta);
    } else {
      showToast('未识别到英语内容，请重新录制');
    }
  };

  // ── Hint sheet ────────────────────────────────────────────────────────────────
  const handleHint = async () => {
    setShowHintSheet(true);
    setIsHintLoading(true);
    const history: ChatTurn[] = messagesRef.current.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'npc' | 'user', text: m.text }));
    try {
      const hints = await generateHints({ scenarioTitle: scenario.title, scenarioCategory: scenario.category, scenarioDesc: scenario.desc, history, taskContract: scenario.taskContract, runtimeState: conversationRuntime, userLevel, environmentalCue: scenario.environmentalCueEn || scenario.environmentalCue });
      setHintOptions(hints);
    } catch { setHintOptions([]); }
    finally { setIsHintLoading(false); }
  };

  // ── Enter shadowing from hint ─────────────────────────────────────────────────
  const handleOptionSelect = (text: string) => {
    setShowHintSheet(false);
    setShadowingText(text);
    setShadowingState('idle');
    setShadowingTranscript('');
  };

  // ── Shadowing mic actions — hold to record, release to send ─────────────────
  const handleShadowingPressIn = async () => {
    if (shadowingState === 'recording') return;
    // Quota: same ASR unit charge as the main mic. Shadowing is just
    // ASR with a different post-flow (read-the-text exercise).
    const verdict = await consumeAndNotify('asr');
    if (!verdict.allowed) {
      quotaDialog.show({ field: verdict.field, tier: verdict.tier, used: verdict.used, hard: verdict.hard });
      return;
    }
    console.log('[Shadowing] PressIn — starting ASR, platform:', require('react-native').Platform.OS);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startPulse();
    setShadowingState('recording');
    setShadowingTranscript('');
    setShadowingError('');
    // Set audio session to recording mode so iOS mic gain is not suppressed
    import('expo-av').then(({ Audio }) => {
      Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      }).catch(() => {});
    }).catch(() => {});
    shadowingAsrRef.current = startVolcASR(
      (partial) => {
        console.log('[Shadowing] partial transcript:', partial);
        setShadowingTranscript(partial);
      },
      (err) => {
        console.warn('[Shadowing] ASR error:', err);
        setShadowingState('idle');
        const name = (err as any)?.name ?? '';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setShadowingError('未检测到麦克风，请插入设备');
        } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setShadowingError('麦克风权限被拒，请在浏览器/系统设置中开启');
        } else {
          setShadowingError(`无法访问麦克风: ${err.message || '未知错误'}`);
        }
      },
    );
    console.log('[Shadowing] startVolcASR called, handle:', shadowingAsrRef.current);
  };

  const handleShadowingPressOut = async () => {
    if (shadowingState !== 'recording') return;
    console.log('[Shadowing] PressOut — stopping ASR');
    stopPulse();
    setShadowingState('idle');
    const handle = shadowingAsrRef.current;
    shadowingAsrRef.current = null;
    let result: ASRResult = { text: '', audioUrl: null };
    if (handle) {
      console.log('[Shadowing] calling handle.stop()');
      setIsShadowingProcessing(true);
      setShadowingTranscript('识别中…');
      result = await handle.stop();
      console.log('[Shadowing] ASR result:', result.text, 'audioUrl:', result.audioUrl);
      if (result.text.trim()) {
        setShadowingTranscript(result.text.trim());
        await new Promise(r => setTimeout(r, 600));
      }
      setIsShadowingProcessing(false);
    } else {
      console.warn('[Shadowing] no ASR handle found on PressOut');
    }
    setShadowingTranscript('');
    const textToSend = result.text.trim();
    console.log('[Shadowing] textToSend:', textToSend);
    if (!textToSend) {
      showToast('未识别到语音内容，请重新录制');
      return;
    }
    const msgId = Date.now();
    setMessages(prev => [...prev, { id: msgId, role: 'user', text: textToSend, showTranslation: false, audioUrl: result.audioUrl, evaluating: true }]);
    const shadowingTargetText = shadowingText;
    setShadowingText(null);
    const history: ChatTurn[] = messagesRef.current.filter(m => m.role === 'user' || m.role === 'npc').map(m => ({ role: m.role as 'user' | 'npc', text: m.text }));
    const shouldBlockNpcReply = !!result.asrMeta?.shouldAskRetry;

    // ── 异步评分 ──
    console.log('[SpeechEval] 触发评分(Shadowing), msgId=', msgId, 'text=', textToSend);
    try {
      const assessment = await assessShadowingReply({
      scenarioTitle: scenario.title,
      scenarioCategory: scenario.category,
      scenarioDesc: scenario.desc,
      taskContract: scenario.taskContract,
      runtimeState: conversationRuntime,
      history,
      userMessage: textToSend,
      userLevel,
      asrMeta: result.asrMeta,
      targetText: shadowingTargetText || textToSend,
      });
      console.log('[SpeechEval] 评分结果:', JSON.stringify(assessment));
      const legacyEvaluation = mapAssessmentToLegacyEvaluation(assessment, {
        scenarioTitle: scenario.title,
        userMessage: textToSend,
      });
      const action = resolveTeachingAction(assessment, result.asrMeta);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, evaluation: legacyEvaluation, speechAssessment: assessment, evaluating: false } : m
      ));
      if (action.action === 'retry_asr') {
        showToast(action.message);
      }
      const shouldAdvanceShadowing = assessment.kind === 'pass' || assessment.kind === 'suggestion';
      if (shouldBlockNpcReply || !shouldAdvanceShadowing) {
        return;
      }
    } catch (err) {
      console.error('[SpeechEval] 评分失败:', err);
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, evaluating: false } : m
      ));
      return;
    }

    setIsTyping(true);
    getNPCReply({
      scenarioTitle: scenario.title,
      scenarioCategory: scenario.category,
      scenarioDesc: scenario.desc,
      npcName: scenario.npcName,
      npcStatus: scenario.npcStatus,
      environmentalCue: scenario.environmentalCueEn || scenario.environmentalCue,
      taskContract: scenario.taskContract!,
      runtimeState: conversationRuntime,
      npcSystemPrompt: scenario.npcSystemPrompt,
      history,
      userMessage: textToSend,
      userLevel,
      npcDifficulty: sandboxConfig.difficulty as 'B1' | 'B2' | 'C1',
    }).then(async (npcResult: NPCReplyResult) => {
      setIsTyping(false);
      setConversationRuntime(npcResult.runtimeState);
      const npcMsg: Message = { id: Date.now() + 1, role: 'npc', text: npcResult.text, showTranslation: false, translation: npcResult.translation || undefined };
      setMessages(cur => [...cur, npcMsg]);
      if (sessionIdRef.current) recordTurn(sessionIdRef.current, { role: 'npc', text: npcResult.text });
      // TTS quota: same "show text even if blocked" policy as the main flow.
      // System TTS is free (device built-in engine), so we skip the quota
      // check entirely for it.
      let shouldSpeak = true;
      if (!isSystemTTSVoice(ttsConfigRef.current.voice)) {
        const ttsVerdict = await consumeAndNotify('tts');
        shouldSpeak = ttsVerdict.allowed;
      }
      if (shouldSpeak) {
        setIsTtsSpeaking(true);
        speakWithVolcTTS(npcResult.text, ttsConfigRef.current.voice, ttsConfigRef.current.speed).catch(() => {}).finally(() => setIsTtsSpeaking(false));
      }
    }).catch(() => setIsTyping(false));
  };

  const handleShadowingClose = async () => {
    const handle = shadowingAsrRef.current;
    shadowingAsrRef.current = null;
    if (handle) await handle.stop().catch(() => {});
    setShadowingText(null);
    setShadowingState('idle');
    setShadowingTranscript('');
  };

  // ── Toggle translation (fetch on first show) ───────────────────────────────
  const toggleTranslation = async (msgId: number) => {
    const msg = messagesRef.current.find(m => m.id === msgId);
    if (!msg) return;
    if (msg.translation) {
      // Translation already cached — just toggle visibility, no API call needed
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, showTranslation: !m.showTranslation } : m));
    } else {
      // No cached translation — fetch it once then show
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, showTranslation: true, translation: '翻译中…' } : m));
      try {
        const zh = await translateText(msg.text);
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, translation: zh } : m));
      } catch {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, translation: '翻译失败' } : m));
      }
    }
  };

  // ── Word tap / lookup (本地 ECDICT) ──────────────────────────────────────────
  const handleWordTap = useCallback((raw: string, msgId: number) => {
    const clean = raw.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
    if (!clean) return;
    const sentence = messagesRef.current.find(m => m.id === msgId)?.text || clean;
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, highlightWord: clean } : { ...m, highlightWord: undefined }
    ));
    // DictionaryLookupSheet 自己调本地 lookup；这里只把 word + contextSentence 传给它
    setLookupState({ word: clean, contextSentence: sentence, msgId });
  }, []);

  const handleCloseLookup = useCallback(() => {
    setLookupState(null);
    setMessages(prev => prev.map(m => ({ ...m, highlightWord: undefined })));
  }, []);

  // ── Toggle a chat message in FSRS (whole sentence from current topic) ─────────
  const handleToggleMessageCard = useCallback(async (message: Message) => {
    if (!id) return;
    const content = (message.text || '').trim();
    if (!content) return;
    const contentKey = content.toLowerCase();
    const existing = messageCardByContent.get(contentKey);
    if (existing) {
      await deleteCard(existing.id);
      showToast(`已从知识库移除整句`);
    } else {
      await createCard({
        type: 'sentence',
        source: 'ai_practice',
        content,
        translation: '',
        practiceContext: {
          topicId: id,
          userSaid: content,
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const preview = content.length > 16 ? content.slice(0, 16) + '…' : content;
      showToast(`已加入知识库：${preview}`);
    }
    await loadTopicSentenceCards(id);
  }, [id, messageCardByContent, loadTopicSentenceCards]);

  // ── Toggle FSRS card (for DictionaryLookupSheet's onToggleSave / onToggleSentenceSave) ─
  const handleToggleSaveWord = useCallback(async (
    payload: SaveWordToHistoryPayload,
    nextSaved: boolean,
  ) => {
    if (!payload.normalized || !id) return;
    const existing = await findWordCardByTopic(id, payload.normalized);
    if (!nextSaved) {
      if (existing) {
        await deleteCard(existing.id);
        showToast(`已从知识库移除：${payload.displayWord || payload.queryWord}`);
      }
      setWordSaved(false);
      return;
    }
    if (existing) {
      showToast('已在单词列表');
      setWordSaved(true);
      return;
    }
    await createCard({
      type: 'word',
      source: 'ai_practice',
      content: payload.displayWord || payload.queryWord,
      translation: payload.translation ?? '',
      practiceContext: {
        topicId: id,
        userSaid: undefined,
      },
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast(`已加入知识库：${payload.displayWord || payload.queryWord}`);
    setWordSaved(true);
  }, [id]);

  const handleToggleSaveSentence = useCallback(async () => {
    if (!lookupState || !id) return;
    const sentence = lookupState.contextSentence;
    if (!sentence || sentence === lookupState.word) {
      showToast('当前没有完整句子可收藏');
      return;
    }
    const existing = await findSentenceCardByTopic(id, sentence);
    if (existing) {
      await deleteCard(existing.id);
      showToast('已从知识库移除整句');
    } else {
      await createCard({
        type: 'sentence',
        source: 'ai_practice',
        content: sentence,
        translation: '',
        practiceContext: {
          topicId: id,
          userSaid: sentence,
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const preview = sentence.length > 16 ? sentence.slice(0, 16) + '…' : sentence;
      showToast(`已加入知识库：${preview}`);
    }
    setSentenceSaved(!existing);
    await loadTopicSentenceCards(id);
  }, [lookupState, id, loadTopicSentenceCards]);

  // ── Clear history ─────────────────────────────────────────────────────────────
  const handleClearHistory = async () => {
    const initMsgs = scenario.initMessages.length > 0
      ? scenario.initMessages
      : [{ id: 1, role: 'npc' as const, text: `Let's start over. Ready?`, showTranslation: false }];
    setMessages(initMsgs);
    messagesRef.current = initMsgs;
    setConversationRuntime(createInitialConversationRuntime(scenario.taskContract!));
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await Promise.all([
        AsyncStorage.removeItem(msgHistoryKey),
        AsyncStorage.removeItem(runtimeStateKey),
      ]);
    } catch { /* ignore */ }
    showToast('对话已重置');
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  if (!scenarioReady && !isStaticId) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator size="large" color="rgba(255,255,255,0.6)" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* ── Immersive top header (absolute overlay) ── */}
      <View style={styles.header} pointerEvents="box-none">
        <View style={styles.headerLeft} pointerEvents="auto">
          <Pressable style={styles.glassBtn} onPress={handleExit}>
            <ChevronLeft size={22} color="rgba(255,255,255,0.85)" />
          </Pressable>
          <View style={{ flex: 1 }}>
            <View style={styles.activeRow}>
              <View style={styles.activeDot} />
              <Text style={styles.activeLabel}>Active Simulation</Text>
            </View>
            <Text style={styles.headerTitle}>{scenario.title}</Text>
            {scenario.desc ? (
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.headerTask} numberOfLines={2}>{scenario.desc}</Text>
                  <Pressable
                    onPress={() => {
                      if (!scenario.desc) return;
                      stopCurrentTTS();
                      if (playingTtsKey === 'desc') { setPlayingTtsKey(null); return; }
                      setPlayingTtsKey('desc');
                      // 手播: 走配额包装器, 系统 TTS 免费, 第三方先扣 tts 再 speak
                      speakTextWithQuota(scenario.desc, ttsConfigRef.current.voice, ttsConfigRef.current.speed)
                        .catch(() => {})
                        .finally(() => setPlayingTtsKey(prev => prev === 'desc' ? null : prev));
                    }}
                    hitSlop={8}
                  >
                    {playingTtsKey === 'desc'
                      ? <AnimatedWaveform isPlaying color="rgba(255,255,255,0.7)" />
                      : <Volume2 size={13} color="rgba(255,255,255,0.6)" />}
                  </Pressable>
                  {scenario.descZh ? (
                    <Pressable onPress={() => setDescZhVisible(v => !v)} hitSlop={8}>
                      <Text style={{ fontSize: 11, color: descZhVisible ? '#34D399' : 'rgba(255,255,255,0.45)' }}>中</Text>
                    </Pressable>
                  ) : null}
                </View>
                {descZhVisible && scenario.descZh ? (
                  <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{scenario.descZh}</Text>
                ) : null}
              </View>
            ) : (
              <Text style={styles.headerTask}>任务: {scenario.task}</Text>
            )}
          </View>
        </View>
        <View style={styles.headerRight} pointerEvents="auto">
          <Pressable style={styles.glassBtn} onPress={handleClearHistory}>
            <RotateCcw size={18} color="rgba(255,255,255,0.7)" />
          </Pressable>
          <Pressable style={styles.glassBtn} onPress={() => setShowSettings(true)}>
            <Settings size={18} color="rgba(255,255,255,0.7)" />
          </Pressable>
        </View>
      </View>

      {/* ── NPC avatar zone (top 40%) ── */}
      {showAvatar && (
        <View style={styles.avatarZone} pointerEvents="none">
          <View style={styles.live2dContainer} pointerEvents="none">
            <Live2DAvatar
              modelUrl={scenario.modelUrl}
              npcEmoji={scenario.npcEmoji}
              isSpeaking={isTtsSpeaking}
            />
          </View>
          <View style={styles.avatarFade} pointerEvents="none" />
        </View>
      )}

      {/* ── Chat area ── */}
      <View style={styles.chatWrapper}>
        <ScrollView
          ref={scrollRef}
          style={styles.chatArea}
          contentContainerStyle={[styles.chatContent, !showAvatar && { paddingTop: 140 }]}
          showsVerticalScrollIndicator={false}
        >
          {messages.map((msg) => {
            // ── Environmental Cue (system message) ───────────────────────
            if (msg.role === 'system') {
              return (
                <View key={msg.id} style={styles.envCueCard}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Text style={styles.envCueLabel}>🎬 环境旁白</Text>
                    <Pressable
                      onPress={() => {
                        stopCurrentTTS();
                        const key = `env-${msg.id}`;
                        if (playingTtsKey === key) { setPlayingTtsKey(null); return; }
                        setPlayingTtsKey(key);
                        // 手播环境旁白: 走配额包装器
                        speakTextWithQuota(msg.text, ttsConfigRef.current.voice, ttsConfigRef.current.speed)
                          .catch(() => {})
                          .finally(() => setPlayingTtsKey(prev => prev === key ? null : prev));
                      }}
                      hitSlop={8}
                    >
                      {playingTtsKey === `env-${msg.id}`
                        ? <AnimatedWaveform isPlaying color="rgba(255,255,255,0.7)" />
                        : <Volume2 size={13} color="rgba(255,255,255,0.5)" />}
                    </Pressable>
                    {msg.translation ? (
                      <Pressable onPress={() => toggleTranslation(msg.id)} hitSlop={8}>
                        <Text style={{ fontSize: 11, color: msg.showTranslation ? '#34D399' : 'rgba(255,255,255,0.4)' }}>中</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={styles.envCueText}>{msg.text}</Text>
                  {msg.showTranslation && msg.translation ? (
                    <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 6, fontStyle: 'italic' }}>{msg.translation}</Text>
                  ) : null}
                  {scenario.npcStatus ? (
                    <Text style={styles.envCueStatus}>{scenario.npcEmoji} {scenario.npcName || 'NPC'} · {scenario.npcStatus}</Text>
                  ) : null}
                </View>
              );
            }

            // ── Regular NPC / User bubble ─────────────────────────────────
            return (
            <View
              key={msg.id}
              style={[styles.msgRow, msg.role === 'user' ? styles.msgRowUser : styles.msgRowNpc]}
            >
              {msg.role === 'npc' && (
                <Text style={styles.msgNpcLabel}>{scenario.npcName} ({scenario.npcRole})</Text>
              )}

              <View style={[styles.bubble, msg.role === 'user' ? styles.bubbleUser : styles.bubbleNpc]}>
                <Text style={[styles.bubbleText, msg.role === 'user' && styles.bubbleTextUser]}>
                  {String(msg.text || '').split(' ').map((word, i) => {
                    const clean = word.replace(/[^a-zA-Z']/g, '').toLowerCase();
                    const isHighlighted = !!clean && clean === msg.highlightWord;
                    return (
                      <Text
                        key={i}
                        onPress={() => handleWordTap(word, msg.id)}
                        style={[
                          styles.tappableWord,
                          isHighlighted && styles.tappableWordHighlighted,
                        ]}
                      >
                        {word}{' '}
                      </Text>
                    );
                  })}
                </Text>

                {(msg.role === 'npc' || msg.role === 'user') && (
                  <View style={styles.translationRow}>
                    {msg.showTranslation && msg.translation ? (
                      <Pressable onPress={() => toggleTranslation(msg.id)}>
                        <Text style={[styles.translationText, msg.role === 'user' && styles.translationTextUser]}>{msg.translation}</Text>
                        <Text style={[styles.translationHide, msg.role === 'user' && styles.translationHideUser]}>点击隐藏</Text>
                      </Pressable>
                    ) : (
                      <Pressable onPress={() => toggleTranslation(msg.id)} style={styles.translationToggleBtn}>
                        <Text style={[styles.translationToggleText, msg.role === 'user' && styles.translationToggleTextUser]}>👁 显示中文翻译</Text>
                      </Pressable>
                    )}
                  </View>
                )}

                {msg.role === 'user' && (msg.evaluating || shouldShowSpeechAssessmentEntry(msg.speechAssessment)) && (
                  <View style={{ position: 'absolute', top: -8, right: -8, zIndex: 10 }}>
                    {msg.evaluating
                      ? <ActivityIndicator size="small" color="#9CA3AF" />
                      : <Pressable onPress={() => shouldShowSpeechAssessmentModal(msg.speechAssessment) && setEvalModal(msg.speechAssessment!)} hitSlop={8}>
                          <Text style={{ fontSize: 16 }}>{getSpeechAssessmentIcon(msg.speechAssessment)}</Text>
                        </Pressable>
                    }
                  </View>
                )}

                {/* Star button — top-right of NPC bubble, top-left of user bubble. Toggles the whole message in FSRS. */}
                <Pressable
                  style={({ pressed }) => [
                    styles.bubbleStarBtn,
                    msg.role === 'user' ? styles.bubbleStarBtnUser : styles.bubbleStarBtnNpc,
                    pressed && { transform: [{ scale: 0.85 }] },
                  ]}
                  onPress={() => handleToggleMessageCard(msg)}
                  hitSlop={8}
                  accessibilityLabel={
                    messageCardByContent.has((msg.text || '').trim().toLowerCase())
                      ? '取消整句收藏'
                      : '收藏整句到知识库'
                  }
                >
                  <Star
                    size={14}
                    color={messageCardByContent.has((msg.text || '').trim().toLowerCase()) ? '#F59E0B' : 'rgba(255,255,255,0.55)'}
                    fill={messageCardByContent.has((msg.text || '').trim().toLowerCase()) ? '#FBBF24' : 'transparent'}
                    strokeWidth={1.8}
                  />
                </Pressable>

                <Pressable
                  style={[styles.audioBtn, msg.role === 'user' ? styles.audioBtnUser : styles.audioBtnNpc]}
                  onPress={() => {
                    stopCurrentTTS();
                    if (playingMsgId === msg.id) { setPlayingMsgId(null); return; }
                    setPlayingMsgId(msg.id);
                    if (msg.role === 'user') {
                      if (msg.audioUrl) {
                        if (Platform.OS === 'web') {
                          const audio = new (window as any).Audio(msg.audioUrl);
                          audio.onended = () => setPlayingMsgId(prev => prev === msg.id ? null : prev);
                          audio.play().catch(() => setPlayingMsgId(null));
                        } else {
                          import('expo-av').then(async ({ Audio }) => {
                            try {
                              console.log('[AudioPlay] audioUrl:', msg.audioUrl);
                              await Audio.setAudioModeAsync({
                                allowsRecordingIOS: false,
                                playsInSilentModeIOS: true,
                                staysActiveInBackground: false,
                              });
                              console.log('[AudioPlay] setAudioModeAsync done');
                              const { sound } = await Audio.Sound.createAsync(
                                { uri: msg.audioUrl! },
                                { volume: 1.0 }
                              );
                              const status = await sound.getStatusAsync();
                              console.log('[AudioPlay] initial status:', JSON.stringify(status));
                              sound.setOnPlaybackStatusUpdate(s => {
                                const st = s as any;
                                if (st.isLoaded) {
                                  console.log('[AudioPlay] playing status — volume:', st.volume, 'isPlaying:', st.isPlaying, 'posMs:', st.positionMillis);
                                }
                                if (st.didJustFinish) {
                                  setPlayingMsgId(prev => prev === msg.id ? null : prev);
                                  sound.unloadAsync();
                                }
                              });
                              await sound.playAsync();
                              console.log('[AudioPlay] playAsync called');
                            } catch (err) {
                              console.error('[AudioPlay] error:', err);
                              setPlayingMsgId(null);
                            }
                          }).catch(err => { console.error('[AudioPlay] import error:', err); setPlayingMsgId(null); });
                        }
                      } else {
                        // 用户消息重听: 走配额包装器
                        speakTextWithQuota(msg.text, ttsConfigRef.current.voice, ttsConfigRef.current.speed)
                          .catch(() => {})
                          .finally(() => {
                            setPlayingMsgId(prev => prev === msg.id ? null : prev);
                          });
                      }
                    } else if (msg.role === 'npc') {
                      // NPC 消息重听: 系统 TTS 走免费, 第三方先扣 tts 再 speak.
                      // 这里手播需要管理 isTtsSpeaking (Live2D 嘴型), 不直接用包装器.
                      const replayVoice = ttsConfigRef.current.voice;
                      const replaySpeed = ttsConfigRef.current.speed;
                      const startSpeak = () => {
                        setIsTtsSpeaking(true);
                        speakWithVolcTTS(msg.text, replayVoice, replaySpeed).catch(() => {}).finally(() => {
                          setIsTtsSpeaking(false);
                          setPlayingMsgId(prev => prev === msg.id ? null : prev);
                        });
                      };
                      if (isSystemTTSVoice(replayVoice)) {
                        startSpeak();
                      } else {
                        consumeAndNotify('tts').then(verdict => {
                          if (!verdict.allowed) {
                            // 静默 bail: 文字已经在屏, 喇叭只是不能读
                            setPlayingMsgId(prev => prev === msg.id ? null : prev);
                            return;
                          }
                          startSpeak();
                        });
                      }
                    } else {
                      setPlayingMsgId(null);
                    }
                  }}
                >
                  {playingMsgId === msg.id
                    ? <AnimatedWaveform isPlaying color={msg.role === 'user' ? 'rgba(255,255,255,0.9)' : '#34D399'} />
                    : <Volume2 size={13} color={msg.role === 'user' ? 'rgba(255,255,255,0.7)' : '#6B7280'} />
                  }
                </Pressable>
              </View>
            </View>
            );
          })}

          {isTyping && (
            <View style={[styles.msgRow, styles.msgRowNpc]}>
              <View style={[styles.bubble, styles.bubbleNpc, { paddingVertical: 16 }]}>
                <View style={styles.typingDots}>
                  <View style={[styles.dot, { opacity: 0.4 }]} />
                  <View style={[styles.dot, { opacity: 0.65 }]} />
                  <View style={[styles.dot, { opacity: 0.9 }]} />
                </View>
              </View>
            </View>
          )}
        </ScrollView>

        {/* ── Bottom control area ── */}
        <View style={styles.inputArea}>
          {/* ── ASR Frosted-glass overlay — shown while recording or processing ── */}
          {(isRecording || isAsrProcessing) && (
            <View style={styles.asrOverlay}>
              <View style={styles.asrOverlayInner}>
                <View style={styles.asrOverlayTopRow}>
                  <View style={[styles.asrListeningDot, isAsrProcessing && { backgroundColor: '#F59E0B' }]} />
                  <Text style={[styles.asrListeningLabel, isAsrProcessing && { color: 'rgba(245,158,11,0.85)' }]}>
                    {isAsrProcessing ? 'PROCESSING' : 'LISTENING'}
                  </Text>
                </View>
                <Text style={styles.asrTranscriptText} numberOfLines={4}>
                  {liveTranscript || '聆听中…'}
                </Text>
                <Text style={styles.asrHintText}>
                  {isAsrProcessing ? 'AI 正在识别语音…' : '松开发送 · 继续按住录音'}
                </Text>
              </View>
            </View>
          )}

          <View style={styles.controlRow}>
              <View style={{ width: 52, height: 52 }} />

              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <Pressable
                  style={isRecording ? styles.teleMicRecording : styles.teleMicIdle}
                  onPressIn={handleMicPressIn}
                  onPressOut={handleMicPressOut}
                >
                  {isRecording
                    ? <AnimatedWaveform isPlaying color="#fff" />
                    : <Mic size={30} color="#fff" />
                  }
                </Pressable>
              </Animated.View>

              <Pressable style={styles.sideBtn} onPress={handleHint}>
                <Lightbulb size={24} color="#F59E0B" />
              </Pressable>
            </View>
          <Text style={styles.inputLabel}>
            {isRecording
              ? ''
              : (isTtsSpeaking ? '🔊 NPC 正在说话…' : (scenario.userInitiates ? '你先开口' : '按住说话，松开发送'))}
          </Text>
        </View>
      </View>

      {/* ── Toast ── */}
      {!!toast && (
        <View style={styles.toast}>
          <CheckCircle2 size={14} color="#34D399" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      {/* Modal 1: Hint Bottom Sheet */}
      <Modal visible={showHintSheet} transparent animationType="slide" onRequestClose={() => setShowHintSheet(false)}>
        <View style={styles.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowHintSheet(false)} />
          <View style={styles.hintSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.hintSheetHeader}>
              <Lightbulb size={18} color="#F59E0B" />
              <Text style={styles.hintSheetTitle}>高情商回复锦囊</Text>
            </View>
            {isHintLoading ? (
              <View style={styles.hintLoading}>
                <ActivityIndicator size="small" color="#60A5FA" />
                <Text style={styles.hintLoadingText}>AI 正在生成场景专属回复...</Text>
              </View>
            ) : (
              <ScrollView
                style={styles.hintList}
                contentContainerStyle={styles.hintListContent}
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                {hintOptions.map(opt => (
                  <Pressable
                    key={opt.id}
                    style={styles.hintOption}
                    onPress={() => handleOptionSelect(opt.text)}
                  >
                    <View style={styles.hintOptionMeta}>
                      <Text style={styles.hintOptionTag}>{opt.style}</Text>
                    </View>
                    <Text style={styles.hintOptionText}>{opt.text}</Text>
                    {opt.translation ? <Text style={styles.hintOptionTranslation}>{opt.translation}</Text> : null}
                    <View style={styles.shadowingBadge}>
                      <Mic size={11} color="#60A5FA" />
                      <Text style={styles.shadowingBadgeText}>点击进入全屏跟读</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal 2: Shadowing Teleprompter */}
      <Modal visible={!!shadowingText} transparent animationType="fade" onRequestClose={handleShadowingClose}>
        <View style={styles.teleprompter}>
          <Pressable style={styles.teleCloseBtn} onPress={handleShadowingClose}>
            <X size={22} color="rgba(255,255,255,0.7)" />
          </Pressable>
          <View style={styles.teleCenter}>
            <Text style={styles.teleMode}>Shadowing Mode</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, width: '100%' }}>
              <Text
                style={[styles.teleText, shadowingState === 'recording' && styles.teleTextRecording, { flex: 1, textAlign: 'center' }]}
                numberOfLines={4}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                allowFontScaling={false}
              >
                {shadowingText}
              </Text>
              <Pressable
                onPress={() => {
                  if (!shadowingText) return;
                  stopCurrentTTS();
                  if (playingTtsKey === 'shadow') { setPlayingTtsKey(null); return; }
                  setPlayingTtsKey('shadow');
                  // 跟读文本播放: 走配额包装器
                  speakTextWithQuota(shadowingText, ttsConfigRef.current.voice, ttsConfigRef.current.speed)
                    .catch(() => {})
                    .finally(() => setPlayingTtsKey(prev => prev === 'shadow' ? null : prev));
                }}
                hitSlop={10}
                style={{ flexShrink: 0 }}
              >
                {playingTtsKey === 'shadow'
                  ? <AnimatedWaveform isPlaying color="rgba(255,255,255,0.8)" />
                  : <Volume2 size={20} color="rgba(255,255,255,0.45)" />}
              </Pressable>
            </View>
          </View>
          <View style={styles.teleBottom}>
            {/* ASR frosted-glass overlay for shadowing */}
            {(shadowingState === 'recording' || isShadowingProcessing) && (
              <View style={styles.shadowingAsrOverlay}>
                <View style={styles.asrOverlayTopRow}>
                  <View style={[styles.asrListeningDot, isShadowingProcessing && { backgroundColor: '#F59E0B' }]} />
                  <Text style={[styles.asrListeningLabel, isShadowingProcessing && { color: 'rgba(245,158,11,0.85)' }]}>
                    {isShadowingProcessing ? 'PROCESSING' : 'LISTENING'}
                  </Text>
                </View>
                <Text style={styles.shadowingAsrText} numberOfLines={3}>
                  {shadowingTranscript || '聆听中…'}
                </Text>
                <Text style={styles.asrHintText}>
                  {isShadowingProcessing ? 'AI 正在识别语音…' : '松开发送 · 继续按住录音'}
                </Text>
              </View>
            )}
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <Pressable
                style={shadowingState === 'recording' ? styles.teleMicRecording : styles.teleMicIdle}
                onPressIn={handleShadowingPressIn}
                onPressOut={handleShadowingPressOut}
              >
                {shadowingState === 'recording'
                  ? <AnimatedWaveform isPlaying color="#fff" />
                  : <Mic size={30} color="#fff" />}
              </Pressable>
            </Animated.View>
            {shadowingError ? (
              <Text style={styles.teleError}>{shadowingError}</Text>
            ) : (
              <Text style={styles.teleHint}>
                {shadowingState === 'idle' ? '按住录音，松开发送' : ''}
              </Text>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal 3: Word Lookup Sheet (本地 ECDICT) */}
      {lookupState ? (
        <DictionaryLookupSheet
          word={lookupState.word}
          contextSentence={lookupState.contextSentence}
          // msgId reused as a DictionaryLookupSheet identifier so the
          // "当前字幕" star shows up. The callback doesn't read it.
          segmentId={String(lookupState.msgId)}
          isWordSaved={wordSaved}
          isSentenceSaved={sentenceSaved}
          onClose={handleCloseLookup}
          onToggleSave={handleToggleSaveWord}
          onToggleSentenceSave={handleToggleSaveSentence}
        />
      ) : null}

      {/* Modal 4: Settings / Sandbox Config */}
      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <View style={styles.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setShowSettings(false)} />
          <View style={styles.settingsSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.settingsHeader}>
              <SlidersHorizontal size={18} color="#60A5FA" />
              <Text style={styles.settingsTitle}>配置</Text>
              <Pressable style={styles.wordSheetClose} onPress={() => setShowSettings(false)}>
                <X size={16} color="rgba(255,255,255,0.5)" />
              </Pressable>
            </View>
            <Text style={styles.configLabel}>
              <Activity size={12} color="rgba(255,255,255,0.4)" /> {'  '}难度
            </Text>
            <View style={styles.configRow}>
              {(['B1', 'B2', 'C1'] as const).map((d) => (
                <Pressable
                  key={d}
                  style={[styles.configBtn, sandboxConfig.difficulty === d && styles.configBtnActive]}
                  onPress={() => setSandboxConfig(c => ({ ...c, difficulty: d }))}
                >
                  <Text style={[styles.configBtnText, sandboxConfig.difficulty === d && styles.configBtnTextActive]}>
                    {d === 'B1' ? '宽容' : d === 'B2' ? '标准' : '地狱'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.configLabel}>
              <Volume2 size={12} color="rgba(255,255,255,0.4)" /> {'  '}NPC 音色
            </Text>
            <View style={styles.configGrid}>
              {TTS_VOICES.map(v => (
                <Pressable
                  key={v.id}
                  style={[styles.configBtn, styles.configBtnHalf, ttsConfig.voice === v.id && styles.configBtnActive]}
                  onPress={() => {
                    setTtsConfig(c => ({ ...c, voice: v.id }));
                    ttsConfigRef.current = { ...ttsConfigRef.current, voice: v.id };
                    stopCurrentTTS();
                    // 音色预览: 走配额包装器, 系统 TTS 免费
                    speakTextWithQuota('Welcome to NativeOS!', v.id, 1.0).catch(() => {});
                  }}
                >
                  <Text style={[styles.configBtnText, ttsConfig.voice === v.id && styles.configBtnTextActive]}>
                    {v.label}
                  </Text>
                  <Text style={{ fontSize: 9, color: ttsConfig.voice === v.id ? 'rgba(96,165,250,0.8)' : 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                    {v.desc}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: '500' as any }}>显示角色形象</Text>
              <Pressable
                style={[
                  { width: 44, height: 26, borderRadius: 13, justifyContent: 'center', paddingHorizontal: 2, borderWidth: 1 },
                  showAvatar
                    ? { backgroundColor: 'rgba(37,99,235,0.6)', borderColor: '#60A5FA' }
                    : { backgroundColor: 'rgba(255,255,255,0.15)', borderColor: GLASS_BORDER },
                ]}
                onPress={() => setShowAvatar(v => !v)}
              >
                <View style={[
                  { width: 20, height: 20, borderRadius: 10 },
                  showAvatar
                    ? { backgroundColor: '#fff', alignSelf: 'flex-end' }
                    : { backgroundColor: 'rgba(255,255,255,0.5)', alignSelf: 'flex-start' },
                ]} />
              </Pressable>
            </View>
            <Pressable
              style={styles.settingsApplyBtn}
              onPress={async () => {
                const normalizedCfg = normalizeTtsConfig(ttsConfig);
                setTtsConfig(normalizedCfg);
                ttsConfigRef.current = normalizedCfg;
                try {
                  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
                  await AsyncStorage.setItem('tts_config', JSON.stringify(normalizedCfg));
                  await AsyncStorage.setItem('sandbox_config', JSON.stringify(sandboxConfig));
                  await AsyncStorage.setItem('show_avatar', showAvatar ? 'true' : 'false');
                } catch { /* ignore */ }
                showToast('配置已保存');
                setShowSettings(false);
              }}
            >
              <Zap size={16} color="#fff" />
              <Text style={styles.settingsApplyText}>保存配置</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Modal 5: Speech Eval Feedback */}
      <Modal visible={!!evalModal} transparent animationType="fade" onRequestClose={closeEvalModal}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 }} onPress={closeEvalModal}>
          <Pressable style={{ backgroundColor: '#1F2937', borderRadius: 16, padding: 20, width: '100%', maxWidth: 360 }} onPress={() => {}}>
            <Text style={{ color: '#F9FAFB', fontSize: 16, fontWeight: '700', marginBottom: 12 }}>{getSpeechAssessmentTitle(evalModal)}</Text>
            {evalModal && evalModal.kind === 'possible_asr_noise' && (
              <View style={{ marginBottom: 12, backgroundColor: '#7C2D12', borderRadius: 10, padding: 12 }}>
                <Text style={{ color: '#FCA5A5', fontSize: 13, fontWeight: '600', marginBottom: 4 }}>{getSpeechAssessmentLabel(evalModal)}</Text>
                <Text style={{ color: '#FECACA', fontSize: 13 }}>{evalModal.shortFeedbackZh}</Text>
                {evalModal.detailCode === 'missing_head' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 6 }}>更像后半句录进来了，但前半句没有完整跟上。</Text> : null}
                {evalModal.detailCode === 'missing_tail' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 6 }}>更像录到了前半句，但后半句没有完整进来。</Text> : null}
                {evalModal.detailCode === 'possible_asr_cutoff' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 6 }}>更像识别或录音中途被截断，不急着按语言错误处理。</Text> : null}
                {evalModal.explanationZh ? <Text style={{ color: '#D1D5DB', fontSize: 12, marginTop: 6 }}>{evalModal.explanationZh}</Text> : null}
              </View>
            )}
            {evalModal && (evalModal.kind === 'issue' || evalModal.kind === 'suggestion') && evalModal.corrected && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: '#D1D5DB', fontSize: 13, fontWeight: '600', marginBottom: 6 }}>{getSpeechAssessmentLabel(evalModal)}</Text>
                <View style={{ backgroundColor: '#374151', borderRadius: 8, padding: 10, marginBottom: 6 }}>
                  {evalModal.original ? <Text style={{ color: '#FCA5A5', fontSize: 13 }}>❌ {evalModal.original}</Text> : null}
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <Text style={{ color: '#86EFAC', fontSize: 13, flex: 1 }}>✅ {evalModal.corrected}</Text>
                    <Pressable
                      onPress={() => {
                        if (!evalModal.corrected) return;
                        stopCurrentTTS();
                        if (playingTtsKey === 'eval-corrected') {
                          setPlayingTtsKey(null);
                          return;
                        }
                        setPlayingTtsKey('eval-corrected');
                        // 评估弹窗"正确说法"播放: 走配额包装器
                        speakTextWithQuota(evalModal.corrected, ttsConfigRef.current.voice, ttsConfigRef.current.speed)
                          .catch(() => {})
                          .finally(() => setPlayingTtsKey(prev => prev === 'eval-corrected' ? null : prev));
                      }}
                      hitSlop={8}
                      style={{ marginTop: 1 }}
                    >
                      {playingTtsKey === 'eval-corrected'
                        ? <AnimatedWaveform isPlaying color="rgba(134,239,172,0.9)" />
                        : <Volume2 size={14} color="rgba(134,239,172,0.8)" />}
                    </Pressable>
                  </View>
                  {evalModal.detailCode === 'missing_head' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 4 }}>更像漏掉了目标句前半部分，而不是单纯识别抖动。</Text> : null}
                  {evalModal.detailCode === 'missing_tail' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 4 }}>更像漏掉了目标句后半部分，而不是只差一点点。</Text> : null}
                  {evalModal.detailCode === 'word_replacement' ? <Text style={{ color: '#FDE68A', fontSize: 12, marginTop: 4 }}>更像目标词或短语被替换了，不只是表达风格差异。</Text> : null}
                  {evalModal.explanationZh ? <Text style={{ color: '#9CA3AF', fontSize: 12, marginTop: 4 }}>{evalModal.explanationZh}</Text> : null}
                </View>
              </View>
            )}
            {evalModal && evalModal.kind === 'pass' && (
              <Text style={{ color: '#D1D5DB', fontSize: 13, marginBottom: 10 }}>{evalModal.shortFeedbackZh}</Text>
            )}
            {evalModal && shouldPersistSpeechAssessment(evalModal) && (
              <Text style={{ color: '#34D399', fontSize: 12, textAlign: 'center', marginBottom: 10 }}>📚 已自动加入复习队列</Text>
            )}
            <Pressable onPress={closeEvalModal} style={{ backgroundColor: '#4B5563', borderRadius: 8, paddingVertical: 10, alignItems: 'center' }}>
              <Text style={{ color: '#F9FAFB', fontSize: 14, fontWeight: '600' }}>关闭</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const DARK_BG = '#0a0a0f';
const GLASS = 'rgba(255,255,255,0.08)';
const GLASS_BORDER = 'rgba(255,255,255,0.12)';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: DARK_BG },

  header: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingTop: 52, paddingBottom: 16, paddingHorizontal: 20,
    zIndex: 20, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glassBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: GLASS, borderWidth: 1, borderColor: GLASS_BORDER,
    justifyContent: 'center', alignItems: 'center',
  },
  activeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  activeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#34D399' },
  activeLabel: { fontSize: 10, fontWeight: '800' as any, color: '#34D399', textTransform: 'uppercase', letterSpacing: 1.5 },
  headerTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: '#fff', lineHeight: 22 },
  headerTask: { fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 },

  avatarZone: {
    height: '38%' as any, justifyContent: 'flex-end', alignItems: 'center',
    paddingTop: 100, paddingBottom: 16, position: 'relative',
  },
  live2dContainer: { flex: 1, width: '100%' as any, alignItems: 'center', justifyContent: 'center' },
  npcNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  npcName: { fontSize: 17, fontWeight: fontWeight.bold, color: '#fff' },
  npcRoleSep: { fontSize: 13, color: 'rgba(255,255,255,0.3)' },
  npcRole: { fontSize: 12, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase' as any, letterSpacing: 1 },
  avatarFade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 48, backgroundColor: 'transparent' },

  chatWrapper: { flex: 1, backgroundColor: DARK_BG },
  chatArea: { flex: 1 },
  chatContent: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 180, gap: 20 },
  msgRow: { width: '100%', flexDirection: 'column' },
  msgRowNpc: { alignItems: 'flex-start' },
  msgRowUser: { alignItems: 'flex-end' },
  msgNpcLabel: {
    fontSize: 10, fontWeight: '700' as any, color: 'rgba(255,255,255,0.35)',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6, marginLeft: 16,
  },
  bubble: { maxWidth: '85%', borderRadius: 24, paddingHorizontal: 20, paddingVertical: 16, borderWidth: 1, position: 'relative' },
  bubbleNpc: { backgroundColor: GLASS, borderColor: GLASS_BORDER, borderTopLeftRadius: 4 },
  bubbleUser: { backgroundColor: '#2563EB', borderColor: 'rgba(96,165,250,0.3)', borderTopRightRadius: 4, alignSelf: 'flex-end', paddingBottom: 22 },
  bubbleText: { fontSize: 16, fontWeight: '500' as any, color: 'rgba(255,255,255,0.9)', lineHeight: 26 },
  envCueCard: { alignSelf: 'center', width: '100%', backgroundColor: 'rgba(251,191,36,0.07)', borderWidth: 1, borderColor: 'rgba(251,191,36,0.2)', borderRadius: 16, padding: 16, marginBottom: 20 },
  envCueLabel: { fontSize: 10, fontWeight: '700' as any, color: 'rgba(251,191,36,0.6)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 8 },
  envCueText: { fontSize: 14, color: 'rgba(255,255,255,0.75)', lineHeight: 22, fontStyle: 'italic' as any },
  envCueStatus: { marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: '600' as any },
  bubbleTextUser: { color: '#fff' },
  tappableWord: { textDecorationLine: 'underline', textDecorationColor: 'rgba(255,255,255,0.2)' },
  tappableWordHighlighted: { backgroundColor: 'rgba(251,191,36,0.3)', color: '#FDE68A', borderRadius: 3, textDecorationLine: 'none' },

  translationRow: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' },
  translationText: { fontSize: 13, color: 'rgba(255,255,255,0.55)', lineHeight: 20 },
  translationHide: { fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  translationToggleBtn: {},
  translationToggleText: { fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: '700' as any, letterSpacing: 0.5 },
  translationTextUser: { color: 'rgba(255,255,255,0.85)' },
  translationHideUser: { color: 'rgba(255,255,255,0.45)', marginTop: 4, textTransform: 'uppercase' as any, letterSpacing: 0.5, fontSize: 10 },
  translationToggleTextUser: { color: 'rgba(191,219,254,0.75)', fontWeight: '600' as any },

  audioBtn: { position: 'absolute', bottom: -10, width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', borderWidth: 1 },
  audioBtnNpc: { right: -10, backgroundColor: '#1F2937', borderColor: '#374151' },
  audioBtnUser: { left: -10, backgroundColor: '#1E40AF', borderColor: '#3B82F6' },
  bubbleStarBtn: { position: 'absolute', top: -10, width: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(15,23,42,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', zIndex: 10 },
  bubbleStarBtnNpc: { right: -10 },
  bubbleStarBtnUser: { left: -10 },

  typingDots: { flexDirection: 'row', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.5)' },

  inputArea: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 40, paddingTop: 48, paddingHorizontal: 24, alignItems: 'center' },

  asrOverlay: {
    position: 'absolute', bottom: 160, left: 20, right: 20,
    borderRadius: 24, overflow: 'hidden',
    backgroundColor: 'rgba(10, 10, 20, 0.82)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)',
    shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 24, elevation: 16,
  },
  asrOverlayInner: { padding: 20, gap: 10 },
  asrOverlayTopRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  asrListeningDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  asrListeningLabel: { fontSize: 10, fontWeight: '800' as any, color: 'rgba(239,68,68,0.85)', textTransform: 'uppercase', letterSpacing: 2 },
  asrTranscriptText: { fontSize: 18, fontWeight: '700' as any, color: '#F1F5F9', lineHeight: 28, minHeight: 56 },
  asrHintText: { fontSize: 10, color: 'rgba(255,255,255,0.3)', fontWeight: '600' as any, letterSpacing: 0.5 },
  shadowingAsrOverlay: {
    width: '100%', borderRadius: 20, marginBottom: 16,
    backgroundColor: 'rgba(10, 10, 20, 0.88)',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)',
    padding: 18, gap: 10,
    shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4, shadowRadius: 20, elevation: 14,
  },
  shadowingAsrText: { fontSize: 16, fontWeight: '700' as any, color: '#F1F5F9', lineHeight: 24, minHeight: 48 },
  controlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 28, width: '100%', maxWidth: 280 },
  sideBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: GLASS, borderWidth: 1, borderColor: GLASS_BORDER, justifyContent: 'center', alignItems: 'center' },
  inputLabel: { marginTop: 14, fontSize: 10, color: 'rgba(255,255,255,0.35)', fontWeight: '700' as any, textTransform: 'uppercase', letterSpacing: 2, textAlign: 'center' },

  toast: {
    position: 'absolute', top: 112, alignSelf: 'center',
    backgroundColor: '#065F46', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, zIndex: 100,
    borderWidth: 1, borderColor: '#10B981',
    shadowColor: '#10B981', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 10,
  },
  toastText: { fontSize: 12, color: '#A7F3D0', fontWeight: '700' as any },

  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheetHandle: { width: 40, height: 5, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 3, alignSelf: 'center', marginBottom: 16 },

  hintSheet: { backgroundColor: '#111827', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24, borderTopWidth: 1, borderColor: GLASS_BORDER, maxHeight: '82%' },
  hintSheetHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  hintSheetTitle: { fontSize: 18, fontWeight: '800' as any, color: '#fff' },
  hintLoading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 32 },
  hintLoadingText: { fontSize: 14, color: 'rgba(255,255,255,0.5)' },
  hintList: { flexGrow: 0 },
  hintListContent: { gap: 12, paddingBottom: 32 },
  hintOption: { backgroundColor: GLASS, borderRadius: 20, borderWidth: 1, borderColor: GLASS_BORDER, padding: 16, gap: 8 },
  hintOptionMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hintOptionTag: { fontSize: 10, fontWeight: '800' as any, color: 'rgba(255,255,255,0.4)', backgroundColor: 'rgba(0,0,0,0.3)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  hintOptionText: { fontSize: 16, fontWeight: '700' as any, color: 'rgba(255,255,255,0.9)', lineHeight: 24 },
  hintOptionTranslation: { fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 18 },
  shadowingBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(37,99,235,0.2)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, alignSelf: 'flex-start', marginTop: 4, borderWidth: 1, borderColor: 'rgba(96,165,250,0.3)' },
  shadowingBadgeText: { fontSize: 11, fontWeight: '700' as any, color: '#60A5FA' },

  teleprompter: { flex: 1, backgroundColor: 'rgba(15,23,42,0.99)', justifyContent: 'space-between' },
  teleCloseBtn: { marginTop: 52, marginLeft: 20, width: 40, height: 40, borderRadius: 20, backgroundColor: GLASS, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: GLASS_BORDER },
  teleCenter: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28, gap: 16 },
  scoreBox: { alignItems: 'center', marginBottom: 16 },
  scoreValue: { fontSize: 56, fontWeight: '900' as any, color: '#34D399' },
  scoreLabel: { fontSize: 11, fontWeight: '800' as any, color: 'rgba(52,211,153,0.7)', textTransform: 'uppercase', letterSpacing: 2 },
  scorePill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(16,185,129,0.15)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)', marginTop: 8 },
  scorePillText: { fontSize: 12, color: '#34D399', fontWeight: '600' as any },
  teleMode: { fontSize: 11, fontWeight: '800' as any, color: 'rgba(96,165,250,0.7)', textTransform: 'uppercase', letterSpacing: 2 },
  teleText: { fontSize: 22, fontWeight: '800' as any, color: '#F1F5F9', textAlign: 'center', lineHeight: 32 },
  teleTextRecording: { color: '#93C5FD' },
  teleTranscript: { fontSize: 15, color: '#A5F3FC', fontWeight: '600' as any, textAlign: 'center', maxWidth: 300, lineHeight: 24 },
  teleBottom: { paddingBottom: 40, paddingHorizontal: 24, alignItems: 'center', gap: 14 },
  teleMicIdle: { width: 76, height: 76, borderRadius: 24, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', shadowColor: '#2563EB', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 10 },
  teleMicRecording: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#EF4444', justifyContent: 'center', alignItems: 'center', borderWidth: 4, borderColor: 'rgba(239,68,68,0.4)', shadowColor: '#EF4444', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 24, elevation: 10 },
  teleMicScoring: { width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(16,185,129,0.1)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' },
  teleMicDone: { width: 76, height: 76, borderRadius: 24, backgroundColor: '#10B981', justifyContent: 'center', alignItems: 'center', shadowColor: '#10B981', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 20, elevation: 10 },
  teleHint: { fontSize: 10, color: 'rgba(255,255,255,0.3)', fontWeight: '700' as any, textTransform: 'uppercase', letterSpacing: 2 },
  teleError: { fontSize: 12, color: '#FCA5A5', fontWeight: '600' as any, textAlign: 'center', paddingHorizontal: 16 },

  wordSheetClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: GLASS, justifyContent: 'center', alignItems: 'center' },

  settingsSheet: { backgroundColor: '#111827', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 56, gap: 16, borderTopWidth: 1, borderColor: GLASS_BORDER },
  settingsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  settingsTitle: { flex: 1, fontSize: 20, fontWeight: '800' as any, color: '#fff' },
  configLabel: { fontSize: 11, fontWeight: '700' as any, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 4 },
  configRow: { flexDirection: 'row', gap: 8 },
  configGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  configBtn: { flex: 1, paddingVertical: 12, borderRadius: 14, backgroundColor: GLASS, borderWidth: 1, borderColor: GLASS_BORDER, alignItems: 'center' },
  configBtnHalf: { flex: undefined, width: '47%' as any },
  configBtnActive: { backgroundColor: 'rgba(37,99,235,0.3)', borderColor: '#60A5FA' },
  configBtnText: { fontSize: 13, fontWeight: '600' as any, color: 'rgba(255,255,255,0.5)' },
  configBtnTextActive: { color: '#fff', fontWeight: '700' as any },
  settingsApplyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#2563EB', paddingVertical: 16, borderRadius: 20, marginTop: 8 },
  settingsApplyText: { fontSize: 15, fontWeight: '800' as any, color: '#fff' },
});
