/**
 * Provider-agnostic LLM client — the interface `lib/engine/adjudicate.ts`
 * programs against, so swapping Groq for Gemini or Anthropic later is a
 * one-file change (a new implementation of this interface), not a rewrite of
 * the adjudication logic.
 *
 * Deliberately no `fixture` mode here, unlike the step-3 connectors. FX rates
 * and bank holidays are immutable historical facts, so replaying a recorded
 * value is honest. An LLM's reasoning over a *specific* exception's specific
 * text is not reusable that way — replaying yesterday's completion against
 * today's different exception content would be actively misleading, not a
 * cache of a fact. So there are exactly two states: `live` (a key is
 * configured and the call went through) or the tier is skipped entirely,
 * reported honestly by the pipeline as `skipped_no_key`.
 */

export type LLMToolDef = {
  name: string
  description: string
  /** JSON-schema-shaped parameters, same convention as `lib/tools/registry.ts`. */
  parameters: Record<string, unknown>
}

export type LLMToolCall = {
  id: string
  name: string
  /** Raw JSON string, as the wire format returns it — caller parses. */
  argumentsJson: string
}

export type LLMMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LLMToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type LLMUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type LLMCompletion = {
  content: string | null
  toolCalls: LLMToolCall[]
  usage: LLMUsage
  latencyMs: number
}

export type LLMClient = {
  /** Model identifier, for display and cost accounting. */
  model: string
  complete(messages: LLMMessage[], tools: LLMToolDef[]): Promise<LLMCompletion>
}

/** Per-model $/1K tokens, input and output, for the unit-economics report. */
export type LLMPricing = { inputPer1k: number; outputPer1k: number }

export function estimateCostUsd(usage: LLMUsage, pricing: LLMPricing): number {
  return (
    (usage.promptTokens / 1000) * pricing.inputPer1k +
    (usage.completionTokens / 1000) * pricing.outputPer1k
  )
}
