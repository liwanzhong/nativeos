import type { AsrMeta } from './asr-postprocess';
import type { SpeechAssessment } from '../ai/speech-evaluator';

export type TeachingAction =
  | { action: 'none' }
  | { action: 'retry_asr'; message: string }
  | { action: 'hint'; message: string }
  | { action: 'feedback'; message: string }
  | { action: 'persist_candidate'; message: string };

export function resolveTeachingAction(
  assessment: SpeechAssessment,
  asrMeta?: Pick<AsrMeta, 'riskLevel' | 'shouldAskRetry'>
): TeachingAction {
  if (assessment.kind === 'pass') {
    return { action: 'none' };
  }

  if (assessment.kind === 'unknown') {
    return { action: 'none' };
  }

  if (assessment.kind === 'possible_asr_noise') {
    if (assessment.shouldInterrupt || asrMeta?.shouldAskRetry) {
      return { action: 'retry_asr', message: assessment.shortFeedbackZh };
    }
    return { action: 'hint', message: assessment.shortFeedbackZh };
  }

  if (assessment.kind === 'suggestion') {
    return { action: 'hint', message: assessment.shortFeedbackZh };
  }

  if (assessment.shouldPersist && assessment.card) {
    return { action: 'persist_candidate', message: assessment.shortFeedbackZh };
  }

  return { action: 'feedback', message: assessment.shortFeedbackZh };
}

export function getSpeechAssessmentIcon(assessment: SpeechAssessment | null | undefined): string | null {
  if (!assessment || assessment.kind === 'pass' || assessment.kind === 'unknown') return null;
  if (assessment.kind === 'issue') return '⚠️';
  if (assessment.kind === 'suggestion') return '💡';
  return '…';
}

export function getSpeechAssessmentTitle(assessment: SpeechAssessment | null | undefined): string {
  if (!assessment) return '口语反馈';
  if (assessment.kind === 'unknown') return '🫥 暂未评分';
  if ((assessment.kind === 'possible_asr_noise' || assessment.kind === 'issue') && assessment.detailCode === 'missing_head') return '🎙️ 跟读缺失提示';
  if (assessment.kind === 'possible_asr_noise' && assessment.detailCode === 'missing_tail') return '🎙️ 跟读缺失提示';
  if (assessment.kind === 'possible_asr_noise') return '🎙️ 识别提示';
  if (assessment.kind === 'suggestion') return '💡 表达建议';
  return '⚠️ 口语反馈';
}

export function getSpeechAssessmentLabel(assessment: SpeechAssessment | null | undefined): string {
  if (!assessment) return '口语反馈';
  if (assessment.kind === 'unknown') return '暂未评分';
  if ((assessment.kind === 'possible_asr_noise' || assessment.kind === 'issue') && assessment.detailCode === 'missing_head') return '前半句可能缺失';
  if (assessment.kind === 'possible_asr_noise' && assessment.detailCode === 'missing_tail') return '后半句可能缺失';
  if (assessment.kind === 'possible_asr_noise' && assessment.detailCode === 'possible_asr_cutoff') return '识别可能被截断';
  if (assessment.kind === 'issue' && assessment.detailCode === 'word_replacement') return '目标词替换';
  if (assessment.kind === 'issue' && assessment.detailCode === 'missing_tail') return '后半句没有跟上';
  if (assessment.kind === 'possible_asr_noise') return '识别可能不稳定';
  if (assessment.kind === 'suggestion') return '可优化表达';
  if (assessment.issueType === 'grammar') return '语法问题';
  return '用词问题';
}

export function shouldShowSpeechAssessmentEntry(assessment: SpeechAssessment | null | undefined): boolean {
  return !!getSpeechAssessmentIcon(assessment);
}

export function shouldShowSpeechAssessmentModal(assessment: SpeechAssessment | null | undefined): boolean {
  if (!assessment) return false;
  if (assessment.kind === 'pass' || assessment.kind === 'unknown') return false;
  return true;
}

export function shouldPersistSpeechAssessment(assessment: SpeechAssessment | null | undefined): boolean {
  return !!assessment && assessment.kind === 'issue' && assessment.shouldPersist && !!assessment.card;
}
