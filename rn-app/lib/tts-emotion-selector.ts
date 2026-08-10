/**
 * TTS Emotion Intelligent Selection
 * Automatically selects appropriate emotion based on context
 */

import { EmotionType, RegisterType } from './tts';
import { CardType } from '../types';

interface ContextAnalysis {
  emotion: EmotionType;
  register: RegisterType;
  speed: number;
  confidence: number;
}

/**
 * Analyze text content and select appropriate TTS emotion
 */
export function selectEmotionFromContext(
  text: string,
  cardType?: CardType,
  userContext?: string
): ContextAnalysis {
  const lowerText = text.toLowerCase();
  
  // Keyword-based emotion detection
  const emotionKeywords = {
    excited: ['amazing', 'awesome', 'fantastic', 'wow', 'incredible', 'breakthrough', 'victory', 'success'],
    urgent: ['urgent', 'immediately', 'asap', 'critical', 'emergency', 'warning', 'alert', 'deadline'],
    professional: ['therefore', 'consequently', 'furthermore', 'moreover', 'analysis', 'research', 'study'],
    casual: ['hey', 'yeah', 'cool', 'nice', 'gonna', 'wanna', 'kinda', 'sorta'],
  };

  // Register detection
  const registerKeywords = {
    formal: ['shall', 'ought', 'hereby', 'pursuant', 'aforementioned', 'notwithstanding'],
    technical: ['algorithm', 'function', 'parameter', 'implementation', 'optimization', 'architecture'],
    casual: ['hey', 'yeah', 'cool', 'stuff', 'thing', 'guy'],
  };

  // Card type-based defaults
  const cardTypeDefaults: Record<CardType, Partial<ContextAnalysis>> = {
    'deep-understanding': { emotion: 'professional', register: 'formal', speed: 0.9 },
    'context-fill': { emotion: 'neutral', register: 'casual', speed: 1.0 },
    'collocation': { emotion: 'casual', register: 'casual', speed: 1.0 },
    'contrast': { emotion: 'professional', register: 'formal', speed: 0.9 },
    'visual': { emotion: 'excited', register: 'casual', speed: 1.1 },
    'slang-idioms': { emotion: 'casual', register: 'casual', speed: 1.0 },
    'grammar-skeleton': { emotion: 'professional', register: 'formal', speed: 0.9 },
    'cross-domain': { emotion: 'professional', register: 'technical', speed: 0.9 },
    'pronunciation': { emotion: 'neutral', register: 'formal', speed: 0.8 },
    'register-shift': { emotion: 'neutral', register: 'casual', speed: 1.0 },
    'reverse-mapping': { emotion: 'neutral', register: 'casual', speed: 1.0 },
  };

  // Start with card type defaults
  let emotion: EmotionType = 'neutral';
  let register: RegisterType = 'casual';
  let speed = 1.0;
  let confidence = 0.5;

  if (cardType && cardTypeDefaults[cardType]) {
    const defaults = cardTypeDefaults[cardType];
    emotion = defaults.emotion || emotion;
    register = defaults.register || register;
    speed = defaults.speed || speed;
    confidence = 0.7;
  }

  // Override with keyword-based detection
  let maxEmotionScore = 0;
  for (const [emotionKey, keywords] of Object.entries(emotionKeywords)) {
    const score = keywords.filter(kw => lowerText.includes(kw)).length;
    if (score > maxEmotionScore) {
      maxEmotionScore = score;
      emotion = emotionKey as EmotionType;
      confidence = Math.min(0.9, 0.7 + score * 0.1);
    }
  }

  let maxRegisterScore = 0;
  for (const [registerKey, keywords] of Object.entries(registerKeywords)) {
    const score = keywords.filter(kw => lowerText.includes(kw)).length;
    if (score > maxRegisterScore) {
      maxRegisterScore = score;
      register = registerKey as RegisterType;
    }
  }

  // Punctuation-based adjustments
  if (text.includes('!')) {
    if (emotion === 'neutral') emotion = 'excited';
    speed = Math.min(1.2, speed + 0.1);
    confidence = Math.max(confidence, 0.8);
  }

  if (text.includes('?')) {
    speed = Math.max(0.9, speed - 0.05);
  }

  // Sentence length adjustments
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 30) {
    speed = Math.max(0.85, speed - 0.1);
  } else if (wordCount < 10) {
    speed = Math.min(1.15, speed + 0.05);
  }

  return {
    emotion,
    register,
    speed,
    confidence,
  };
}

/**
 * Get emotion description for logging
 */
export function getEmotionDescription(analysis: ContextAnalysis): string {
  return `${analysis.emotion} (${analysis.register}, ${analysis.speed}x, ${Math.round(analysis.confidence * 100)}% confident)`;
}

/**
 * Analyze user context for personalized TTS
 */
export function analyzeUserContext(userContext?: string): Partial<ContextAnalysis> {
  if (!userContext) return {};

  const lowerContext = userContext.toLowerCase();

  // Detect user's current scenario
  if (lowerContext.includes('work') || lowerContext.includes('office')) {
    return { emotion: 'professional', register: 'formal', speed: 0.95 };
  }

  if (lowerContext.includes('study') || lowerContext.includes('learn')) {
    return { emotion: 'neutral', register: 'formal', speed: 0.9 };
  }

  if (lowerContext.includes('casual') || lowerContext.includes('chat')) {
    return { emotion: 'casual', register: 'casual', speed: 1.05 };
  }

  return {};
}
