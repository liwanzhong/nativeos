/**
 * Supabase Edge Function: Volcengine TTS Proxy
 *
 * Proxies requests to https://openspeech.bytedance.com/api/v1/tts so that
 * the browser never needs to supply Volcengine auth headers directly.
 *
 * Request body (JSON):
 *   { text: string, speaker?: string }
 *
 * Response:
 *   audio/mpeg binary stream on success
 *   { error: string } JSON on failure
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const VOLC_APP_ID      = Deno.env.get('VOLC_APP_ID')      ?? ''
const VOLC_ACCESS_TOKEN = Deno.env.get('VOLC_ACCESS_TOKEN') ?? ''
const VOLC_TTS_URL     = 'https://openspeech.bytedance.com/api/v1/tts'
const DEFAULT_SPEAKER  = 'en_female_emily_mars_bigtts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { text, speaker = DEFAULT_SPEAKER } = await req.json()

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'text is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const reqId = crypto.randomUUID()

    const body = {
      app: {
        appid: VOLC_APP_ID,
        token: VOLC_ACCESS_TOKEN,
        cluster: 'volcano_tts',
      },
      user: { uid: reqId },
      audio: {
        voice_type: speaker,
        encoding: 'mp3',
        speed_ratio: 1.0,
        volume_ratio: 1.0,
        pitch_ratio: 1.0,
      },
      request: {
        reqid: reqId,
        text,
        text_type: 'plain',
        operation: 'query',
        silence_duration: '125',
        with_frontend: 1,
        frontend_type: 'unitTson',
      },
    }

    const volcResp = await fetch(VOLC_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer;${VOLC_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    })

    if (!volcResp.ok) {
      const errText = await volcResp.text()
      throw new Error(`Volcengine TTS error ${volcResp.status}: ${errText}`)
    }

    const json = await volcResp.json()

    if (json.code !== 3000) {
      throw new Error(`Volcengine TTS failed: code=${json.code} msg=${json.message}`)
    }

    // Return base64 audio as JSON so the client can handle it uniformly
    return new Response(JSON.stringify({ audio: json.data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[volc-tts-proxy]', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
