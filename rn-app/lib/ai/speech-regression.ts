import { assessSpokenReply, evaluateSpeech, getShadowingDeterministicAssessment, type EvaluateInput } from './speech-evaluator';
import { resolveTeachingAction } from '../speech/teaching-policy';
import { analyzeShadowingDiff, cleanShadowingTargetText, diffShadowing } from '../shadowing/diff';

export interface SpeechRegressionResult {
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ name: string; details: string }>;
}

type RegressionAssertion = {
  ok: boolean;
  details?: string;
};

type RegressionCase = {
  name: string;
  run: () => RegressionAssertion | Promise<RegressionAssertion>;
};

function makeShadowingInput(targetText: string, transcript: string, overrides?: Partial<EvaluateInput>): EvaluateInput {
  return {
    scenarioTitle: 'Regression Shadowing',
    scenarioCategory: 'shadowing',
    history: [],
    userMessage: transcript,
    targetText,
    asrMeta: overrides?.asrMeta,
    scenarioDesc: overrides?.scenarioDesc,
    taskContract: overrides?.taskContract,
    runtimeState: overrides?.runtimeState,
    userLevel: overrides?.userLevel,
  };
}

function assert(condition: boolean, details: string): RegressionAssertion {
  return condition ? { ok: true } : { ok: false, details };
}

function makeFreeSpeechInput(transcript: string, overrides?: Partial<EvaluateInput>): EvaluateInput {
  return {
    scenarioTitle: 'Regression Free Speech',
    scenarioCategory: 'conversation',
    history: [],
    userMessage: transcript,
    asrMeta: overrides?.asrMeta,
    scenarioDesc: overrides?.scenarioDesc,
    taskContract: overrides?.taskContract,
    runtimeState: overrides?.runtimeState,
    userLevel: overrides?.userLevel,
  };
}

const regressionCases: RegressionCase[] = [
  {
    name: 'cleanShadowingTargetText strips stage directions',
    run: () => {
      const cleaned = cleanShadowingTargetText('Is this the shoulder press machine? (points to machine) *smiles*');
      return assert(cleaned === 'Is this the shoulder press machine?', `cleaned=${cleaned}`);
    },
  },
  {
    name: 'diff detects missing head when only later chunk is spoken',
    run: () => {
      const diff = diffShadowing("I'm feeling happy today — the sun is shining!", 'The sun is shining.');
      const signals = analyzeShadowingDiff(diff);
      return assert(signals.dominantPattern === 'missing_head' && signals.leadingMissingCount >= 2, JSON.stringify(signals));
    },
  },
  {
    name: 'deterministic assessment returns missing_head issue',
    run: () => {
      const input = makeShadowingInput("I'm feeling happy today — the sun is shining!", 'The sun is shining.');
      const assessment = getShadowingDeterministicAssessment(input, input.userMessage);
      return assert(
        !!assessment && assessment.kind === 'issue' && assessment.detailCode === 'missing_head' && assessment.shouldInterrupt,
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'deterministic assessment returns missing_tail issue for stable partial shadowing',
    run: () => {
      const input = makeShadowingInput('I would like a coffee, but I am in a hurry today.', 'I would like a coffee.');
      const assessment = getShadowingDeterministicAssessment(input, input.userMessage);
      return assert(
        !!assessment && assessment.kind === 'issue' && assessment.detailCode === 'missing_tail',
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'deterministic assessment returns retry action when ASR cutoff is likely',
    run: () => {
      const input = makeShadowingInput('I would like a coffee, but I am in a hurry today.', 'I would like a coffee.', {
        asrMeta: {
          rawText: 'I would like a coffee.',
          normalizedText: 'I would like a coffee',
          riskLevel: 'medium',
          riskFlags: ['looks_incomplete'],
          shouldAskRetry: true,
          looksIncomplete: true,
          looksNoisy: false,
        },
      });
      const assessment = getShadowingDeterministicAssessment(input, input.userMessage);
      const action = assessment ? resolveTeachingAction(assessment, input.asrMeta) : { action: 'none' as const };
      return assert(
        !!assessment && assessment.kind === 'possible_asr_noise' && assessment.detailCode === 'possible_asr_cutoff' && action.action === 'retry_asr',
        JSON.stringify({ assessment, action }),
      );
    },
  },
  {
    name: 'deterministic assessment returns word_replacement for small substitution',
    run: () => {
      const input = makeShadowingInput('Is this the shoulder press machine?', 'Is this the leg press machine?');
      const assessment = getShadowingDeterministicAssessment(input, input.userMessage);
      return assert(
        !!assessment && assessment.kind === 'issue' && assessment.detailCode === 'word_replacement',
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'deterministic assessment passes near-exact shadowing',
    run: () => {
      const input = makeShadowingInput('I would like a coffee please.', 'I would like a coffee please.');
      const assessment = getShadowingDeterministicAssessment(input, input.userMessage);
      return assert(
        !!assessment && assessment.kind === 'pass',
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'free speech single-token medium-risk short-circuits to ASR noise',
    run: async () => {
      const input = makeFreeSpeechInput('coffee', {
        asrMeta: {
          rawText: 'coffee',
          normalizedText: 'coffee',
          riskLevel: 'medium',
          riskFlags: ['single_token_transcript'],
          shouldAskRetry: false,
          looksIncomplete: false,
          looksNoisy: false,
        },
      });
      const assessment = await assessSpokenReply(input);
      return assert(
        assessment.kind === 'possible_asr_noise' && assessment.shouldPersist === false,
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'free speech without API key stays unknown instead of default pass',
    run: async () => {
      const input = makeFreeSpeechInput('I would like to pay by card.');
      const assessment = await assessSpokenReply(input);
      return assert(
        assessment.kind === 'unknown' && assessment.shortFeedbackZh.length > 0,
        JSON.stringify(assessment),
      );
    },
  },
  {
    name: 'legacy evaluateSpeech keeps conservative unknown fallback',
    run: async () => {
      const input = makeFreeSpeechInput('I would like to pay by card.');
      const legacy = await evaluateSpeech(input);
      return assert(
        legacy.shouldSave === false && legacy.coarseOk === true && !!legacy.coarseIssue,
        JSON.stringify(legacy),
      );
    },
  },
];

export async function runSpeechRegressionSuite(): Promise<SpeechRegressionResult> {
  const failures: Array<{ name: string; details: string }> = [];
  let passed = 0;

  for (const testCase of regressionCases) {
    const result = await testCase.run();
    if (result.ok) {
      passed += 1;
      continue;
    }
    failures.push({
      name: testCase.name,
      details: result.details || 'Unknown failure',
    });
  }

  return {
    total: regressionCases.length,
    passed,
    failed: failures.length,
    failures,
  };
}
