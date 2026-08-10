// Supabase Edge Function: ElevenLabs TTS API Proxy
// Protects API keys by proxying TTS requests server-side

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TTSProxyRequest {
  text: string
  emotion?: 'neutral' | 'excited' | 'professional' | 'casual' | 'urgent'
  speed?: number
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing authorization header')
    }

    // Parse request
    const { text, emotion = 'neutral', speed = 1.0 }: TTSProxyRequest = await req.json()

    // Validate input
    if (!text || text.length > 500) {
      throw new Error('Invalid text input (max 500 characters)')
    }

    // Get ElevenLabs API key from environment
    const elevenlabsKey = Deno.env.get('ELEVENLABS_API_KEY')
    if (!elevenlabsKey) {
      throw new Error('ElevenLabs API key not configured')
    }

    // Map emotion to voice settings
    const voiceSettings = getVoiceSettings(emotion, speed)

    // Call ElevenLabs API
    const voiceId = 'EXAVITQu4vr4xnSDxMaL' // Default voice ID
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elevenlabsKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: voiceSettings,
        }),
      }
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`ElevenLabs API error: ${error}`)
    }

    // Get audio data
    const audioBlob = await response.blob()
    
    // Log usage for monitoring
    console.log('TTS Proxy Usage:', {
      textLength: text.length,
      emotion,
      speed,
      timestamp: new Date().toISOString(),
    })

    // Return audio data
    return new Response(audioBlob, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'audio/mpeg',
      },
    })

  } catch (error) {
    console.error('TTS Proxy Error:', error)
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})

function getVoiceSettings(emotion: string, speed: number) {
  const baseSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
  }

  switch (emotion) {
    case 'excited':
      return { ...baseSettings, stability: 0.3, similarity_boost: 0.85 }
    case 'professional':
      return { ...baseSettings, stability: 0.7, similarity_boost: 0.65 }
    case 'casual':
      return { ...baseSettings, stability: 0.4, similarity_boost: 0.8 }
    case 'urgent':
      return { ...baseSettings, stability: 0.2, similarity_boost: 0.9 }
    default:
      return baseSettings
  }
}
