/**
 * Voice Input (STT) Wrapper
 *
 * PRD §3.3 & §5: Voice-first sandbox input.
 * - Uses Web Speech API on web platform
 * - 3-second timeout → automatically falls back to keyboard input
 * - Returns a promise that resolves with the transcribed text or null (fallback signal)
 *
 * Native: expo-speech covers TTS only; for STT we use the Web Speech API polyfill
 * on web and signal keyboard fallback on native until a dedicated STT SDK is added.
 */

import { Platform } from 'react-native';

const STT_TIMEOUT_MS = 3000;

export interface STTResult {
  text: string | null;       // null = recognition failed, trigger keyboard fallback
  fallbackReason?: string;   // human-readable reason for fallback
}

/**
 * Start a single speech recognition session.
 * Resolves with the transcript text, or null if failed/timed out.
 */
export async function recognizeSpeech(): Promise<STTResult> {
  if (Platform.OS === 'web') {
    return recognizeWeb();
  }
  // Native: STT SDK not yet integrated — signal keyboard fallback
  return { text: null, fallbackReason: 'native_stt_pending' };
}

/**
 * Web implementation using the browser's SpeechRecognition API.
 */
function recognizeWeb(): Promise<STTResult> {
  return new Promise((resolve) => {
    const SpeechRecognition =
      (globalThis as any).SpeechRecognition ||
      (globalThis as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      resolve({ text: null, fallbackReason: 'api_not_supported' });
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let settled = false;

    const done = (result: STTResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { recognition.stop(); } catch { /* ignore */ }
      resolve(result);
    };

    // Hard timeout: 3 seconds of silence = fallback
    const timer = setTimeout(() => {
      done({ text: null, fallbackReason: 'timeout' });
    }, STT_TIMEOUT_MS);

    recognition.onresult = (event: any) => {
      const transcript: string = event.results[0][0].transcript;
      done({ text: transcript.trim() || null });
    };

    recognition.onerror = (event: any) => {
      done({ text: null, fallbackReason: event.error || 'recognition_error' });
    };

    recognition.onend = () => {
      done({ text: null, fallbackReason: 'ended_without_result' });
    };

    try {
      recognition.start();
    } catch (err) {
      done({ text: null, fallbackReason: 'start_failed' });
    }
  });
}

/**
 * Check if STT is supported in the current environment.
 */
export function isSpeechRecognitionSupported(): boolean {
  if (Platform.OS !== 'web') return false;
  return !!(
    (globalThis as any).SpeechRecognition ||
    (globalThis as any).webkitSpeechRecognition
  );
}
