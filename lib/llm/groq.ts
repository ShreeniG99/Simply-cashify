/**
 * Groq implementation of `LLMClient`, targeting `openai/gpt-oss-120b`.
 *
 * NOT `llama-3.3-70b-versatile`: Groq's own docs list it for migration to
 * `gpt-oss-120b` / `gpt-oss-20b` / `qwen3.6-27b` (confirmed during planning).
 * Building tier 4 on a model already flagged for deprecation two weeks before
 * a deadline is a bad trade. `gpt-oss-120b` is Groq's stated migration target,
 * supports native tool calling, and free-tier limits (~30 RPM / 200K TPD at
 * last check) comfortably cover a batch where the agent only touches the
 * genuinely ambiguous residual — re-verify before the demo, free-tier limits
 * change often.
 *
 * `api.groq.com` is confirmed egress-blocked from this build environment (same
 * proxy denial as the step-3 hosts), and no `GROQ_API_KEY` is set here either.
 * This implementation is exercised in tests via a mocked `fetch`, not against
 * the real API — see `tests/adjudicate.test.ts`.
 */

import type { LLMClient, LLMCompletion, LLMMessage, LLMToolDef } from './client'

export const GROQ_MODEL = 'openai/gpt-oss-120b'

/**
 * $0.15 input / $0.60 output per million tokens, on-demand rate — verified by
 * web search against multiple independent pricing trackers during this build
 * session (not carried over from memory unchecked). Groq's Batch API and
 * prompt caching can roughly halve this further; not modeled here since tier 4
 * calls are synchronous, not batched. Free-tier limits change often —
 * re-verify before quoting either number publicly.
 */
export const GROQ_PRICING = { inputPer1k: 0.00015, outputPer1k: 0.0006 }

type GroqToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type GroqMessage = {
  role: string
  content: string | null
  tool_call_id?: string
  tool_calls?: GroqToolCall[]
}
type GroqResponse = {
  choices: { message: { content: string | null; tool_calls?: GroqToolCall[] } }[]
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function toGroqMessage(m: LLMMessage): GroqMessage {
  switch (m.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls?.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        })),
      }
    default:
      return { role: m.role, content: m.content }
  }
}

function toGroqTool(t: LLMToolDef) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
}

export function createGroqClient(apiKey: string, model: string = GROQ_MODEL): LLMClient {
  return {
    model,
    async complete(messages: LLMMessage[], tools: LLMToolDef[]): Promise<LLMCompletion> {
      const started = Date.now()
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(toGroqMessage),
          tools: tools.length > 0 ? tools.map(toGroqTool) : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
        }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`)
      }

      const data = (await res.json()) as GroqResponse
      const choice = data.choices[0]
      const latencyMs = Date.now() - started

      return {
        content: choice.message.content,
        toolCalls: (choice.message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          argumentsJson: tc.function.arguments,
        })),
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        latencyMs,
      }
    },
  }
}

/** Reads `GROQ_API_KEY` and returns a client, or `null` if unconfigured. Never fabricates a client that would silently fail. */
export function createGroqClientFromEnv(): LLMClient | null {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  return createGroqClient(key)
}
