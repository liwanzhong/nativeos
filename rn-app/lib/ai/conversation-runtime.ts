export interface ConversationSlotDefinition {
  key: string;
  label: string;
  description: string;
  required: boolean;
}

export interface ScenarioTaskContract {
  objective: string;
  learnerGoal: string;
  npcRole: string;
  sceneFrame: string;
  initialStage: string;
  requiredSlots: ConversationSlotDefinition[];
  allowedTopicExtensions: string[];
  outOfScopeTopics: string[];
  completionCriteria: string[];
}

export type ConversationTopicStatus = 'on_track' | 'adjacent_shift' | 'task_switch' | 'off_track';

export interface ConversationRuntimeState {
  currentStage: string;
  topicStatus: ConversationTopicStatus;
  activeObjective: string;
  lastUserIntent: string;
  filledSlots: Record<string, string>;
  pendingSlots: string[];
  suggestedNpcAction: string;
  shouldConfirmTaskSwitch: boolean;
  summary: string;
}

export interface ScenarioContractSeed {
  title: string;
  desc?: string;
  category?: string;
  npcName?: string;
  npcStatus?: string;
  npcSystemPrompt?: string;
  openingLine?: string;
  environmentalCue?: string;
  environmentalCueEn?: string;
}

const TRAVEL_KEYWORDS = ['ticket', 'station', 'train', 'airport', 'flight', 'subway', 'metro', 'platform', 'rail', 'gate', '旅行', '交通', '地铁', '高铁', '机场', '车站', '火车'];
const ORDER_KEYWORDS = ['order', 'drink', 'coffee', 'milk', 'size', 'menu', '点单', '咖啡', '奶', '饮料', '餐'];
const SUPPORT_KEYWORDS = ['doctor', 'symptom', 'outage', 'invoice', 'payment', 'server', 'finance', 'doctor', '医生', '付款', '账单', '故障', '宕机'];

function uniqueNonEmpty(items: Array<string | undefined | null>) {
  return Array.from(new Set(items.map((item) => item?.trim()).filter((item): item is string => Boolean(item))));
}

function toSearchText(seed: ScenarioContractSeed) {
  return [
    seed.title,
    seed.desc,
    seed.category,
    seed.npcSystemPrompt,
    seed.openingLine,
    seed.environmentalCue,
    seed.environmentalCueEn,
  ].filter(Boolean).join(' ').toLowerCase();
}

function inferRequiredSlots(seed: ScenarioContractSeed): ConversationSlotDefinition[] {
  const text = toSearchText(seed);
  if (TRAVEL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return [
      { key: 'destination', label: 'Destination', description: 'Where the learner wants to go or which station/service they need.', required: true },
      { key: 'ticketType', label: 'Ticket Type', description: 'Whether they need a single, return, one-way, or other ticket type.', required: true },
      { key: 'followUpNeed', label: 'Follow-up Need', description: 'Any adjacent need such as platform, exit, transfer, or signage help.', required: false },
    ];
  }
  if (ORDER_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return [
      { key: 'item', label: 'Item', description: 'The main thing the learner wants to order or request.', required: true },
      { key: 'customization', label: 'Customization', description: 'Any substitution, quantity, size, or preference.', required: false },
      { key: 'paymentOrPickup', label: 'Payment or Pickup', description: 'Any follow-up need related to paying, pickup, or timing.', required: false },
    ];
  }
  if (SUPPORT_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return [
      { key: 'coreIssue', label: 'Core Issue', description: 'The main problem the learner is trying to explain or solve.', required: true },
      { key: 'constraint', label: 'Constraint', description: 'Relevant urgency, limitation, or business/medical detail.', required: false },
      { key: 'desiredOutcome', label: 'Desired Outcome', description: 'What concrete help or resolution the learner wants.', required: true },
    ];
  }
  return [
    { key: 'request', label: 'Request', description: 'The learner’s main request in this scenario.', required: true },
    { key: 'constraint', label: 'Constraint', description: 'Any important preference, limit, or extra detail.', required: false },
  ];
}

function inferAllowedTopicExtensions(seed: ScenarioContractSeed): string[] {
  const text = toSearchText(seed);
  if (TRAVEL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return uniqueNonEmpty([
      'clarifying destination or route',
      'single vs return ticket decisions',
      'payment or machine usage questions',
      'adjacent wayfinding such as exits, transfers, or platform signs after confirming the shift',
    ]);
  }
  if (ORDER_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return uniqueNonEmpty([
      'size or quantity adjustments',
      'ingredient substitutions',
      'price or payment follow-up',
      'pickup timing or order confirmation',
    ]);
  }
  if (SUPPORT_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return uniqueNonEmpty([
      'clarifying the issue',
      'explaining constraints or urgency',
      'asking about next steps or options',
      'confirming the requested resolution',
    ]);
  }
  return uniqueNonEmpty([
    'clarifying the learner request',
    'negotiating realistic alternatives',
    'asking for the next missing detail',
  ]);
}

function inferOutOfScopeTopics(seed: ScenarioContractSeed): string[] {
  const text = toSearchText(seed);
  if (TRAVEL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return uniqueNonEmpty([
      'unrelated social chat that abandons the transport task',
      'switching to a completely different service without confirming the change',
    ]);
  }
  if (ORDER_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return uniqueNonEmpty([
      'unrelated travel or workplace problem-solving',
      'switching to a different business entirely without confirmation',
    ]);
  }
  return uniqueNonEmpty([
    'topics unrelated to the current real-world task',
    'abandoning the current request without confirming a new one',
  ]);
}

export function deriveTaskContract(seed: ScenarioContractSeed, partial?: Partial<ScenarioTaskContract> | null): ScenarioTaskContract {
  const requiredSlots = partial?.requiredSlots?.filter((slot) => slot && slot.key) ?? inferRequiredSlots(seed);
  const objective = partial?.objective?.trim() || seed.desc?.trim() || `Handle the scenario "${seed.title}" naturally and help the learner complete the real-world task.`;
  const learnerGoal = partial?.learnerGoal?.trim() || seed.desc?.trim() || `The learner wants to complete the task in the scenario "${seed.title}".`;
  const npcRole = partial?.npcRole?.trim() || seed.npcSystemPrompt?.trim() || `${seed.npcName || 'The NPC'} should stay in role and guide the interaction within the scenario.`;
  const sceneFrame = partial?.sceneFrame?.trim() || uniqueNonEmpty([
    seed.openingLine,
    seed.environmentalCueEn,
    seed.environmentalCue,
    seed.npcStatus,
    seed.category ? `${seed.category} scenario` : undefined,
  ]).join(' ');
  const initialStage = partial?.initialStage?.trim() || (requiredSlots.length > 0 ? `collect_${requiredSlots[0].key}` : 'clarify_request');
  const completionCriteria = partial?.completionCriteria?.length
    ? uniqueNonEmpty(partial.completionCriteria)
    : uniqueNonEmpty([
        requiredSlots.filter((slot) => slot.required).map((slot) => `Confirm ${slot.label.toLowerCase()} before wrapping up.`).join(' '),
        'The learner should leave with a clear next step or concrete answer.',
      ]);

  return {
    objective,
    learnerGoal,
    npcRole,
    sceneFrame,
    initialStage,
    requiredSlots,
    allowedTopicExtensions: partial?.allowedTopicExtensions?.length ? uniqueNonEmpty(partial.allowedTopicExtensions) : inferAllowedTopicExtensions(seed),
    outOfScopeTopics: partial?.outOfScopeTopics?.length ? uniqueNonEmpty(partial.outOfScopeTopics) : inferOutOfScopeTopics(seed),
    completionCriteria,
  };
}

export function createInitialConversationRuntime(contract: ScenarioTaskContract): ConversationRuntimeState {
  return {
    currentStage: contract.initialStage,
    topicStatus: 'on_track',
    activeObjective: contract.objective,
    lastUserIntent: 'start_conversation',
    filledSlots: {},
    pendingSlots: contract.requiredSlots.filter((slot) => slot.required).map((slot) => slot.key),
    suggestedNpcAction: 'greet_or_clarify_next_missing_slot',
    shouldConfirmTaskSwitch: false,
    summary: `Stay focused on: ${contract.objective}`,
  };
}

export function normalizeConversationRuntime(
  contract: ScenarioTaskContract,
  runtime?: Partial<ConversationRuntimeState> | null,
): ConversationRuntimeState {
  const initial = createInitialConversationRuntime(contract);
  const filledSlots = runtime?.filledSlots && typeof runtime.filledSlots === 'object' ? runtime.filledSlots : initial.filledSlots;
  const pendingSlots = Array.isArray(runtime?.pendingSlots) && runtime!.pendingSlots.length > 0
    ? runtime!.pendingSlots.filter((slot): slot is string => typeof slot === 'string' && slot.length > 0)
    : contract.requiredSlots.filter((slot) => slot.required && !filledSlots[slot.key]).map((slot) => slot.key);

  return {
    currentStage: runtime?.currentStage?.trim() || initial.currentStage,
    topicStatus: runtime?.topicStatus || initial.topicStatus,
    activeObjective: runtime?.activeObjective?.trim() || contract.objective,
    lastUserIntent: runtime?.lastUserIntent?.trim() || initial.lastUserIntent,
    filledSlots,
    pendingSlots,
    suggestedNpcAction: runtime?.suggestedNpcAction?.trim() || initial.suggestedNpcAction,
    shouldConfirmTaskSwitch: runtime?.shouldConfirmTaskSwitch === true,
    summary: runtime?.summary?.trim() || initial.summary,
  };
}

export function runtimeToPromptBlock(runtime: ConversationRuntimeState): string {
  const filledSlots = Object.entries(runtime.filledSlots);
  return [
    `Current stage: ${runtime.currentStage}`,
    `Topic status: ${runtime.topicStatus}`,
    `Active objective: ${runtime.activeObjective}`,
    `Last user intent: ${runtime.lastUserIntent}`,
    `Filled slots: ${filledSlots.length > 0 ? filledSlots.map(([key, value]) => `${key}=${value}`).join('; ') : 'none'}`,
    `Pending slots: ${runtime.pendingSlots.length > 0 ? runtime.pendingSlots.join(', ') : 'none'}`,
    `Suggested NPC action: ${runtime.suggestedNpcAction}`,
    `Should confirm task switch: ${runtime.shouldConfirmTaskSwitch ? 'yes' : 'no'}`,
    `Runtime summary: ${runtime.summary}`,
  ].join('\n');
}

export function contractToPromptBlock(contract: ScenarioTaskContract): string {
  return [
    `Objective: ${contract.objective}`,
    `Learner goal: ${contract.learnerGoal}`,
    `NPC role boundary: ${contract.npcRole}`,
    `Scene frame: ${contract.sceneFrame || 'not specified'}`,
    `Initial stage: ${contract.initialStage}`,
    `Required slots: ${contract.requiredSlots.length > 0 ? contract.requiredSlots.map((slot) => `${slot.key} (${slot.required ? 'required' : 'optional'}): ${slot.description}`).join(' | ') : 'none'}`,
    `Allowed topic extensions: ${contract.allowedTopicExtensions.length > 0 ? contract.allowedTopicExtensions.join(' | ') : 'none'}`,
    `Out of scope topics: ${contract.outOfScopeTopics.length > 0 ? contract.outOfScopeTopics.join(' | ') : 'none'}`,
    `Completion criteria: ${contract.completionCriteria.length > 0 ? contract.completionCriteria.join(' | ') : 'none'}`,
  ].join('\n');
}
