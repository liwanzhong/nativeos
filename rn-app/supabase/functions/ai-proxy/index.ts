// Supabase Edge Function: OpenAI API Proxy
// Protects API keys by proxying requests server-side

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AIProxyRequest {
  type: 'generate-card' | 'intent-routing'
  prompt: string
  userLevel?: string
  context?: string
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
    const { type, prompt, userLevel, context }: AIProxyRequest = await req.json()

    // Get OpenAI API key from environment
    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiKey) {
      throw new Error('OpenAI API key not configured')
    }

    // Build OpenAI request
    const systemPrompt = buildSystemPrompt(type, userLevel)
    const userPrompt = context ? `${context}\n\n${prompt}` : prompt

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`OpenAI API error: ${error}`)
    }

    const data = await response.json()
    
    // Log usage for monitoring
    console.log('AI Proxy Usage:', {
      type,
      tokens: data.usage?.total_tokens,
      timestamp: new Date().toISOString(),
    })

    return new Response(
      JSON.stringify({
        success: true,
        data: data.choices[0].message.content,
        usage: data.usage,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )

  } catch (error) {
    console.error('AI Proxy Error:', error)
    
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

function buildSystemPrompt(type: string, userLevel?: string): string {
  const level = userLevel || 'B1'
  
  const basePrompt = `You are an English learning assistant. User level: ${level}.
Always respond with valid JSON. Be concise and educational.`

  switch (type) {
    case 'generate-card':
      return `${basePrompt}
Generate a learning card following the specified cognitive matrix format.
Focus on i+1 difficulty (slightly above current level).`
    
    case 'intent-routing':
      return `${basePrompt}
Analyze the user input and determine the best learning card type.
Prioritize context-based learning (Scene 2) when possible.`
    
    default:
      return basePrompt
  }
}
