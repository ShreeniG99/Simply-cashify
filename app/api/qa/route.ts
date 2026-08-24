import { NextResponse } from 'next/server'
import { answerQuestion } from '@/lib/qa/answer'
import { createGroqClientFromEnv } from '@/lib/llm/groq'
import type { RunPayload } from '@/lib/api/run'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: { question?: string; run?: RunPayload }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.question || typeof body.question !== 'string' || !body.question.trim()) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 })
  }
  if (!body.run) {
    return NextResponse.json({ error: 'run is required — ask about a run you have already loaded' }, { status: 400 })
  }

  try {
    const result = await answerQuestion(body.question, body.run, createGroqClientFromEnv())
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Q&A failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
