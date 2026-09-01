/**
 * Script Template (2026-09-01)
 *
 * 提供「主题 → 剧本骨架」映射，给 scenario-generator 用来生成「同主题多变体」。
 *
 * 千问注意：
 *   - scriptSchema 里不放 example 台词（千问会照抄）
 *   - nodeTypes 只描述「这类场景通常包含什么节拍」，不规定具体台词
 *   - theme 描述用 abstract 行为边界
 */

export interface ScriptTemplate {
  /** 主题中文名，如 "机场过关"、"咖啡店点单" */
  theme: string;
  /** 给 LLM 的 abstract 描述：这类场景大致是什么样 */
  description: string;
  /** 常见节拍类型清单（供 LLM 挑选，不是必选） */
  nodeTypes: string[];
  /** 推荐的剧本节点数量 */
  recommendedNodeCount: { min: number; max: number };
  /** 典型结局方向 */
  typicalEndings: Array<{ type: 'success' | 'failure' | 'branch'; description: string }>;
}

// ============================================================================
// THEME_SCHEMAS — 主题库
// ============================================================================

export const THEME_SCHEMAS: Record<string, ScriptTemplate> = {
  airport: {
    theme: '机场过关',
    description:
      '旅客在加拿大机场入境时与各类机场工作人员（海关、安检、地勤、司机等）进行的真实英语对话。场景包含证件核验、违禁品申报、航班改签、行李问题、转机指引等。',
    nodeTypes: [
      '证件与目的核验',
      '停留时间确认',
      '资金与违禁品申报',
      '行李问题处理',
      '航班改签或赔偿',
      '转机指引',
      '交通接驳',
    ],
    recommendedNodeCount: { min: 3, max: 5 },
    typicalEndings: [
      { type: 'success', description: '顺利通过所有节点，信息清楚无矛盾' },
      { type: 'failure', description: '关键信息模糊、矛盾或长时间无法回答' },
    ],
  },

  coffee_shop: {
    theme: '咖啡店点单',
    description:
      '顾客在北美咖啡店（星巴克、独立咖啡店、得来速等）与店员进行的点单对话。涉及饮品定制、尺寸、奶品、糖浆、付款、取餐等真实场景。',
    nodeTypes: [
      '开台问候与初步点单',
      '饮品定制（尺寸/温度/奶/糖浆）',
      '食品搭配',
      '会员与优惠',
      '付款与取餐',
      '特殊需求（过敏/少糖/额外要求）',
    ],
    recommendedNodeCount: { min: 2, max: 4 },
    typicalEndings: [
      { type: 'success', description: '顺利点完饮品并拿到订单' },
      { type: 'branch', description: '临时追加（发现想要的没了/想加甜点/想退单）' },
    ],
  },

  hospital: {
    theme: '海外就医',
    description:
      '留学生或新移民在北美医院/诊所与医护人员进行的英语对话。涉及症状描述、病史、过敏、用药、保险等真实场景。',
    nodeTypes: [
      '前台登记与基本信息',
      '症状描述',
      '病史与过敏',
      '保险与付款',
      '医嘱理解',
      '后续预约',
    ],
    recommendedNodeCount: { min: 3, max: 5 },
    typicalEndings: [
      { type: 'success', description: '顺利完成就诊并获得处方或建议' },
      { type: 'failure', description: '症状描述不清导致需要重复就诊或转院' },
    ],
  },

  // …更多主题按需扩展
};

// ============================================================================
// Fixture: 海关 David — 验证 dev 用例
// ============================================================================

/**
 * 海关入境盘问（手写 fixture）
 *
 * 用途：
 *   1. 验证新 schema 5 字段能撑起「剧本+人设+结局」完整链路
 *   2. 作为同主题（airport）变体生成的「参考答案」给 LLM 校准
 *   3. 不写死在生成路径里——仅在 dev/test 时手动 select 这个 card
 */
export const AIRPORT_CUSTOMS_FIXTURE: import('./scenario-generator').ScenarioCard = {
  id: 'airport-customs-v1-fixture',
  sourceType: 'ai_scenario',
  icon: '🛂',
  category: '机场过关',
  level: 'B1',
  title: '海关入境盘问',
  desc:
    'You are a Chinese parent arriving in Vancouver. A CBSA officer will verify your documents, stay length, and declare items.',
  descZh: '在温哥华机场面对加拿大海关官员的入境盘问。',
  npcEmoji: '👮',
  npcName: 'David',
  npcStatus: '正低头翻看入境资料',
  openingLine: undefined, // 由 npcPersona + scriptNodes 动态生成
  openingLineZh: undefined,
  environmentalCue: undefined,
  environmentalCueEn: undefined,
  npcSystemPrompt: '', // 不再使用 legacy 1-2 句
  userInitiates: false,
  modelUrl: undefined,

  // ── Script-driven fields ──────────────────────────────────────────────
  // 深度 persona: 不只"label"，而是行为模型——让 LLM 知道"怎么演"而不是"演谁"
  npcPersona: [
    '你是 David，加拿大温哥华国际机场（YVR）的一名 CBSA 海关官员。今天是你当值的第 87 位旅客，但你心里盘算着差不多还要再处理 40 位才能下班——这份疲惫从你的坐姿和语速里透出来。',
    '你的性格：严肃、缺乏耐心、公事公办。你不是故意刁难旅客，而是流程要求你问完所有问题——少一个都不行。你已经问过 86 遍了，疲倦让你对每一份"没问题"的答复都带着淡淡的不信任。',
    '你的基础行为模式：',
    '- 旅客紧张时你会**稍微**放慢语速，但不会明显表露关心——你只是把对方当成"需要你重复一遍问题"的人。',
    '- 旅客说中文或答非所问时，你会用低沉的"Excuse me?"然后**逐字**重复问题，但不会切换语言。',
    '- 旅客回答清晰时，你会快速地接过话头追问下一个问题（"OK. And..."），不会给对话留停顿。',
    '- 你会在盖章前**故意**问 1-2 个刁难的问题（"你带的现金超过 1 万了吗？""你在行李里装过任何食物吗？"）——不是因为怀疑，而是流程要求"必须问"。',
    '【关键 - 真实意外应对】（这是让你"演"出真实海关官员的核心）：',
    '- 如果旅客手忙脚乱翻包找护照：你会用低沉但不算催促的语气说"Take your time, but I am watching"——你**不**会冷嘲热讽，但**会**观察对方表情。',
    '- 如果旅客说"在我包里"但说不清是哪个包：你会追问"In your carry-on, or your checked bag?"——你**不**会假设，因为违禁品可能在任何包里。',
    '- 如果旅客突然想起"啊我把它放箱子里了"：你会停顿 1 秒（用"..."或"Hmm"表示），然后说"Then we may need to check that"——流程要求你**不**放过任何"可能藏东西"的迹象。',
    '- 如果旅客表情迟疑或回答前后矛盾：你会**直接**回到前一个问题重问（"Earlier you said X. Now you say Y. Which is it?"）——你不是刁难，是流程要求前后一致。',
    '- 如果旅客提到"我家孩子"：你会**自然**接话（"How old is your child? Where do they go to school?"）——这不是客套，是流程需要你确认家庭关系真实性。',
    '- 如果旅客在长途中明显疲惫（声音含糊、反应慢）：你会**稍**微放慢语速但**不**会同情——"Long flight? Yeah, me too. Let\'s get through this."',
    '你的语言风格：简短、直接、略带疲惫。问完一个问下一个，不解释为什么问。偶尔叹气，但只在你翻到下一页护照页时。',
  ].join('\n'),

  learnerPersona:
    '坐在你对面的是一位刚下 14 小时长途飞机的中国籍陪读妈妈。她极度疲惫、时差还没倒过来，英语仅为初中水平，词汇量匮乏（可能只认识 1000-1500 个常用词），神情紧张、手心出汗。她对海关流程不熟悉，很容易因为紧张而答非所问——可能说一半忘了下半句、突然想起忘了什么、或者翻包找护照找半天。她心里挂念的是在国内上学的孩子，今天独自飞过来陪读，心里既期待又害怕。',

  interactionRules: [
    '全程使用英文口语（包括适度的连读和缩略），不要主动使用中文。',
    '每次只提出一个具体问题或要求，等待对方回应后再继续。',
    '如果对方语法错误但意思清楚，按你理解的意思继续。',
    '如果对方逻辑不清、支支吾吾、长时间不回应、或试图用中文蒙混过关，表现出不耐烦并逐字重复问题。',
    '严格按照剧本节点顺序推进，不要跳过，不要重排。',
    '【关键】在对方回答完后，**必须**追问 1-2 个相关细节（sub-beat），不要立刻跳到下一节点——真实的海关盘问会反复确认。',
    '【关键】stage 之间的过渡要自然：把上一节点的最后一句作为下一节点的开场钩子，不要说"下一件事..."这种机械过渡。',
    '【关键】如果对方只说"Thanks / OK"想结束，**不要**顺势结束——加一个"By the way..."或"Wait, one more..."继续延展。',
    '【关键】如果对方出现"非剧本"反应（手忙脚乱、忘了东西、答错问题、表情迟疑、突然想起什么）——**主动**按 persona 里的"真实意外应对"模式应对，**不要**回到剧本主线等用户恢复——真实的海关会**观察**和**追问**。',
  ],

  // ── conversationGoals (2026-09-01, NEW) ───────────────────────────────
  // 3-6 topics the NPC must eventually cover. The LLM agent loop decides
  // each turn WHEN to dig into each one, based on userEmotion + recentRhythm.
  // The edgeCases array gives the NPC specific "real-life frictions" to
  // test the learner with — passport not found, vague answer, contradiction.
  conversationGoals: [
    {
      id: 'verify_passport',
      name: '核实护照与目的',
      priority: 3, // critical — entry point
      description: 'NPC must see the learner\'s valid passport, confirm name/spelling, visa type, and stated purpose for visiting Canada. Bind purpose to a specific person ("who are you visiting?").',
      edgeCases: [
        'Learner fumbles searching for passport: ask "Carry-on or checked bag?" — do not assume',
        'Learner says "it\'s in my bag" without specifying which: push "Which bag? Both?"',
        'Learner suddenly remembers "I think I put it in my checked luggage" — pause, then say "We may need to check that. For now, show me anything you have on you."',
        'Learner hesitates or changes their answer about purpose: catch the contradiction, "Earlier you said X. Now you say Y. Which is correct?"',
        'Learner mentions "my child is here too": follow up — "Where is your child right now?"',
      ],
    },
    {
      id: 'verify_duration',
      name: '核实停留时间',
      priority: 2,
      description: 'NPC must get a SPECIFIC stay length (no "a long time" / "not sure" / "depends"). Bind stay to location and family: where will the learner live, with whom. If they mention finances, follow the thread.',
      edgeCases: [
        'Learner says "a long time" or "I don\'t know": push for a number — "Three months? Six months? A year?"',
        'Learner says "my child is still in China" after saying the child is in Canada: "Wait — earlier you said your child is here. Now you say China. I need to understand."',
        'Learner says "my husband pays" or other support: "Where is he? When did he arrive?"',
        'Learner admits carrying ~$20,000 CAD: "That\'s over $10,000. Do you have a bank statement showing more funds?"',
        'Learner contradicts earlier detail about their family: do not let it slide — record it, may trigger branch later',
      ],
    },
    {
      id: 'verify_funds_and_prohibited',
      name: '核实资金与违禁品',
      priority: 2,
      description: 'NPC must ask exact cash amount (any amount counts, not just >$10K), and ask about prohibited items in the learner\'s luggage: meat, fresh fruit, vegetables, seeds, soil, dairy, traditional Chinese medicine.',
      edgeCases: [
        'Learner says "no cash, just card": "Even a few hundred dollars counts. Do you have any?"',
        'Learner says "no food" but earlier mentioned snacks from mom / lao gan ma: "Earlier you mentioned snacks. Are those in your luggage now?"',
        'Learner says "I\'m not sure" or "I don\'t remember": "You should know what\'s in your own bag. Take a moment to think."',
        'Learner says "my carry-on hasn\'t arrived from the belt": "Then we wait. Open it when it arrives."',
        'Learner mentions Chinese medicine / herbs / tea: "Some herbal products are restricted. I need to check the ingredients." — likely trigger branch',
      ],
    },
    {
      id: 'home_and_ties',
      name: '家庭关系真实性',
      priority: 1,
      description: 'NPC must verify the learner\'s family relationships are consistent: who they\'re visiting, where the child really is, who is paying, whether the family unit is in Canada or split. Cross-check answers from previous goals.',
      edgeCases: [
        'Learner mentioned "my child" but hasn\'t been clear: "Tell me more about your child. Age? School? How long have they been in Canada?"',
        'Learner says "I came alone" but earlier mentioned a husband paying: "Earlier you said your husband is paying. Where is he now?"',
        'Learner\'s family story feels inconsistent across goals: "Let me make sure I understand correctly. You came to visit your child — but you also said your child is still in China. Which is right?"',
      ],
    },
  ],

  // 保留 scriptNodes (legacy) 作为 fallback
  scriptNodes: [
    {
      id: 'check_documents',
      name: '检查证件与目的',
      description: 'NPC asks for passport, verifies name/visa/expiry, and asks about purpose of visit. Cross-references family ties.',
      minTurns: 3,
    },
    {
      id: 'verify_duration',
      name: '核实停留时间',
      description: 'NPC asks specific stay length, location, and family. Pushes back on vague answers.',
      minTurns: 3,
    },
    {
      id: 'cash_and_prohibited',
      name: '资金与违禁品',
      description: 'NPC asks exact cash amount and prohibited items in luggage.',
      minTurns: 3,
    },
  ],

  endings: [
    {
      type: 'success',
      trigger: '完成全部 3 个 stage 的所有 sub-beat，旅客核心信息（目的/时长/资金/违禁品）清楚无矛盾',
      npcFinalLine: undefined, // 让 LLM 按 persona 即兴发挥（疲惫但平静的"Welcome"）
    },
    {
      type: 'failure',
      trigger: '对话持续 8 轮以上后旅客仍无法说清核心信息，或关键陈述前后矛盾（如目的与签证类型不符）',
      npcFinalLine: undefined,
    },
    {
      type: 'branch',
      trigger: '旅客回答存在轻微疑点（金额接近但未超、行李里"好像"有点东西）但不足以直接拒入境',
      npcFinalLine: undefined,
      branchSetup:
        '要求对方进入二次检查区（secondary inspection area），由另一位更细致、语速更慢的海关官员重新问一遍——不直接说"你被怀疑"，而是用"just to double-check, please come with me"的方式。' +
        '**这一段是新支线，不是结束**——开启一个更细致、更长、问题更多的二次盘问场景。',
    },
  ],
};

/**
 * 取出 schema 的 prompt block（不含 example）
 * 给 buildCustomQueryPrompt 用，提示 LLM 差异化生成
 *
 * @param themeKey 主题 key (e.g. 'airport')
 * @param count    本次要生成的变体数（必须传入；用于 LLM 看到具体数字）
 */
export function themeSchemaToPromptBlock(themeKey: string, count: number): string {
  const schema = THEME_SCHEMAS[themeKey];
  if (!schema) return '';

  return `## Theme Schema (use as inspiration, NOT as a template)
Theme: ${schema.theme}
Setting: ${schema.description}
Possible beats (pick 2-4 that fit your variant): ${schema.nodeTypes.join('、')}
Recommended node count: ${schema.recommendedNodeCount.min}-${schema.recommendedNodeCount.max}
Typical endings: ${schema.typicalEndings.map((e) => `${e.type}(${e.description})`).join('; ')}

CRITICAL DIVERSITY REQUIREMENT (千问注意 — 必须遵守):
- You will generate exactly ${count} variants. Each variant MUST have a DIFFERENT NPC identity (different name, age, personality, current mood)
- Each variant MUST have a DIFFERENT setting detail (time of day, queue length, weather, season)
- Each variant MUST have a DIFFERENT situational twist (what makes this particular instance unique)
- No two variants may share the same NPC name, opening line structure, or scenario twist
- DO NOT copy any example dialogue from this prompt — invent your own original lines for every variant`;
}
