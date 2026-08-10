/**
 * Context-Aware TTS Engine
 * Implements emotional and prosodic control for realistic speech
 */

import { Platform } from 'react-native';
import { callTTSProxy, isSupabaseConfigured } from './api-client';
import { getLocalAudio, saveLocalAudio, initializeAudioStorage } from './audio-storage';

export type EmotionType = 'neutral' | 'excited' | 'professional' | 'casual' | 'urgent';
export type RegisterType = 'formal' | 'casual' | 'technical';

interface TTSParams {
  text: string;
  emotion?: EmotionType;
  register?: RegisterType;
  emphasizeWords?: string[];
  speed?: number; // 0.5 - 2.0
}

interface TTSConfig {
  provider?: 'elevenlabs' | 'gemini';
  apiKey?: string;
  voiceId?: string;
}

// Audio cache map (in-memory)
const audioCache = new Map<string, string>();

// Initialize audio storage on module load
if (Platform.OS !== 'web') {
  initializeAudioStorage().catch(console.error);
}

/**
 * Generate cache key for audio
 */
function generateCacheKey(text: string, emotion: EmotionType, register: RegisterType): string {
  return `${text}_${emotion}_${register}`.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 100);
}

/**
 * Get cached audio URL
 */
async function getCachedAudio(cacheKey: string): Promise<string | null> {
  return audioCache.get(cacheKey) || null;
}

/**
 * Cache audio URL
 */
async function cacheAudio(cacheKey: string, audioUrl: string): Promise<void> {
  audioCache.set(cacheKey, audioUrl);
}

/**
 * Generate speech with context-aware prosody
 * Supports connected speech, stress patterns, and emotional rendering
 */
/**
 * Stop the currently-playing TTS audio, if any.
 *
 * NOTE: this module only returns an audio URL — playback is handled by the
 * consumer (expo-av). This noop keeps the public API stable so callers can
 * `await stopCurrentTTS()` defensively without crashing. If/when we add a
 * client-side Sound object here, this becomes its `unloadAsync()`.
 */
export async function stopCurrentTTS(): Promise<void> {
  // intentionally empty — playback lifecycle is owned by the consumer
}

export async function generateSpeech(params: TTSParams): Promise<string | null> {
  const emotion = params.emotion || 'neutral';
  const register = params.register || 'casual';
  const cacheKey = `${params.text}_${emotion}_${register}`;
  
  // Check memory cache first
  const cached = audioCache.get(cacheKey);
  if (cached) {
    console.log('TTS: Using memory cached audio');
    return cached;
  }
  
  // Check local storage (offline support)
  if (Platform.OS !== 'web') {
    const localAudio = await getLocalAudio(params.text, emotion, register);
    if (localAudio) {
      audioCache.set(cacheKey, localAudio);
      return localAudio;
    }
  }
  
  // Check if Supabase proxy is configured
  if (!isSupabaseConfigured()) {
    console.warn('Supabase not configured, TTS features disabled');
    return null;
  }
  
  try {
    console.log('TTS: Generating speech via proxy for:', params.text.substring(0, 50));
    
    // Use Supabase Edge Function proxy to generate audio
    const audioUrl = await callTTSProxy({
      text: params.text,
      emotion: params.emotion,
      speed: params.speed,
    });
    
    if (audioUrl) {
      // Cache in memory
      audioCache.set(cacheKey, audioUrl);
      
      // Save to local storage for offline access
      if (Platform.OS !== 'web') {
        saveLocalAudio(params.text, emotion, register, audioUrl)
          .catch(err => console.error('Failed to save audio locally:', err));
      }
      
      return audioUrl;
    }
    
    return null;
  } catch (error) {
    console.error('TTS generation failed:', error);
    return null;
  }
}

/**
 * Call TTS API (ElevenLabs or Gemini)
 */
async function callTTSAPI(text: string, speed: number, config?: TTSConfig): Promise<string> {
  const provider = config?.provider || 'elevenlabs';
  const apiKey = config?.apiKey || process.env.EXPO_PUBLIC_TTS_API_KEY;
  
  if (!apiKey) {
    console.warn('TTS API key not configured, skipping audio generation');
    return '';
  }
  
  try {
    if (provider === 'elevenlabs') {
      return await callElevenLabsAPI(text, speed, apiKey, config?.voiceId);
    } else if (provider === 'gemini') {
      return await callGeminiTTS(text, speed, apiKey);
    }
  } catch (error) {
    console.error('TTS API call failed:', error);
  }
  
  return '';
}

/**
 * ElevenLabs API integration
 */
async function callElevenLabsAPI(
  text: string,
  speed: number,
  apiKey: string,
  voiceId?: string
): Promise<string> {
  const defaultVoiceId = voiceId || 'EXAVITQu4vr4xnSDxMaL'; // Sarah voice
  
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${defaultVoiceId}`,
    {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: speed,
        },
      }),
    }
  );
  
  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.statusText}`);
  }
  
  const audioBlob = await response.blob();
  
  // Return blob URL (works on both web and native)
  return URL.createObjectURL(audioBlob);
}

/**
 * Gemini TTS (placeholder - implement when available)
 */
async function callGeminiTTS(text: string, speed: number, apiKey: string): Promise<string> {
  console.warn('Gemini TTS not yet implemented');
  return '';
}

/**
 * Build TTS prompt with prosody control
 */
function buildTTSPrompt(
  text: string,
  emotion: EmotionType,
  register: RegisterType,
  emphasizeWords: string[]
): string {
  let prompt = text;
  
  // Add emotion instructions
  const emotionInstructions = {
    neutral: 'Speak in a neutral, clear tone.',
    excited: 'Speak with enthusiasm and energy.',
    professional: 'Speak in a calm, professional manner.',
    casual: 'Speak casually and naturally, with connected speech.',
    urgent: 'Speak with urgency and slight impatience.',
  };
  
  // Add register instructions
  const registerInstructions = {
    formal: 'Use formal pronunciation and clear enunciation.',
    casual: 'Use casual pronunciation with natural reductions (gonna, wanna).',
    technical: 'Emphasize technical terms clearly.',
  };
  
  // Mark emphasized words
  emphasizeWords.forEach(word => {
    prompt = prompt.replace(
      new RegExp(`\\b${word}\\b`, 'gi'),
      `**${word}**`
    );
  });
  
  return `${emotionInstructions[emotion]} ${registerInstructions[register]} ${prompt}`;
}

/**
 * Simulate connected speech patterns
 * Examples: "What are you" → "Whatcha", "going to" → "gonna"
 */
export function applyConnectedSpeech(text: string): string {
  const patterns = [
    { from: /what are you/gi, to: 'whatcha' },
    { from: /going to/gi, to: 'gonna' },
    { from: /want to/gi, to: 'wanna' },
    { from: /got to/gi, to: 'gotta' },
    { from: /kind of/gi, to: 'kinda' },
    { from: /sort of/gi, to: 'sorta' },
  ];
  
  let result = text;
  patterns.forEach(({ from, to }) => {
    result = result.replace(from, to);
  });
  
  return result;
}

/**
 * Generate stress pattern markup for pronunciation cards
 */
export function generateStressPattern(word: string, stressPosition: number): string {
  const syllables = word.split('');
  return syllables
    .map((char, i) => i === stressPosition ? char.toUpperCase() : char)
    .join('');
}
