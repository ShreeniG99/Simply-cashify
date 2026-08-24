import { describe, expect, it, vi } from 'vitest'
import { runAdjudication, type ResidualCase } from '@/lib/engine/adjudicate'
import { reconcile } from '@/lib/engine/pipeline'
import { generate } from '@/lib/datasets/generate'
import { buildCandidates } from '@/lib/engine/match'
import { DEFAULT_CONFIG } from '@/lib/engine/config'
import type { LLMClient, LLMCompletion, LLMMessage, LLMToolCall, LLMToolDef } from '@/lib/llm/client'
import '@/lib/tools/index'

/** A minimal, well-formed record pair with no network dependency. */
function makeResidual(): ResidualCase {
  const { batch } = generate({ seed: 5 })
  const candidates = buildCandidates(batch.ledger, batch.settlements, DEFAULT_CONFIG)
  // Any ledger row with at least one candidate makes a usable fixture.
  const withCandidates = batch.ledger.find((l) => candidates.some((c) => c.ledger.id === l.id))!
  const own = candidates.filter((c) => c.ledger.id === withCandidates.id).sort((a, b) => b.confidence - a.confidence)
  return { ledger: withCandidates, candidates: own }
}

const usage = (prompt: number, completion: number) => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
})

function toolCall(id: string, name: string, args: unknown): LLMToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) }
}

/** Scripted client: returns queued responses in order, one per `complete()` call. */
function scriptedClient(responses: LLMCompletion[]): LLMClient {
  let i = 0
  return {
    model: 'test-model',
    complete: vi.fn(async (_messages: LLMMessage[], _tools: LLMToolDef[]) => {
      if (i >= responses.length) throw new Error('scriptedClient: ran out of scripted responses')
      return responses[i++]
    }),
  }
}

describe('adjudicateOne — via runAdjudication with a scripted client', () => {
  it('proposes a match after one investigation call, tracking tokens and tools separately', async () => {
    const residual = makeResidual()
    const targetPaymentId = residual.candidates[0].payment.id

    const client = scriptedClient([
      {
        content: null,
        toolCalls: [toolCall('1', 'calendar.isBusinessDay', { date: '2026-10-02' })],
        usage: usage(100, 20),
        latencyMs: 50,
      },
      {
        content: null,
        toolCalls: [
          toolCall('2', 'propose_match', {
            paymentId: targetPaymentId,
            confidence: 0.9,
            rationale: 'Confirmed via calendar check.',
          }),
        ],
        usage: usage(120, 15),
        latencyMs: 40,
      },
    ])

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    expect(summary.results).toHaveLength(1)
    const r = summary.results[0]
    expect(r.outcome).toBe('matched')
    if (r.outcome !== 'matched') throw new Error('unreachable')
    expect(r.paymentId).toBe(targetPaymentId)
    expect(r.toolsCalled).toEqual(['calendar.isBusinessDay'])
    expect(r.tokensUsed).toBe(100 + 20 + 120 + 15)
    expect(r.latencyMs).toBe(90)

    // Cost must price prompt and completion tokens separately, not collapse
    // everything into the cheaper input bucket.
    expect(summary.totalTokens).toBe(r.tokensUsed)
    expect(summary.estimatedCostUsd).toBeGreaterThan(0)
  })

  it('flags an exception directly when the model is not confident', async () => {
    const residual = makeResidual()
    const client = scriptedClient([
      {
        content: null,
        toolCalls: [
          toolCall('1', 'flag_exception', {
            reason: 'ambiguous_multiple_candidates',
            rationale: 'Two candidates score too close to call.',
          }),
        ],
        usage: usage(80, 10),
        latencyMs: 30,
      },
    ])

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    const r = summary.results[0]
    expect(r.outcome).toBe('exception')
    if (r.outcome !== 'exception') throw new Error('unreachable')
    expect(r.reason).toBe('ambiguous_multiple_candidates')
    expect(r.rationale).toContain('close to call')
  })

  it('refuses a paymentId that was never among the candidates shown to it', async () => {
    const residual = makeResidual()
    const client = scriptedClient([
      {
        content: null,
        toolCalls: [
          toolCall('1', 'propose_match', {
            paymentId: 'pay_totally_invented',
            confidence: 0.95,
            rationale: 'Looks right.',
          }),
        ],
        usage: usage(50, 10),
        latencyMs: 20,
      },
    ])

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    const r = summary.results[0]
    expect(r.outcome).toBe('exception')
    if (r.outcome !== 'exception') throw new Error('unreachable')
    expect(r.rationale).toMatch(/not among the candidates/)
  })

  it('declines rather than crashes when the decision arguments are malformed JSON', async () => {
    const residual = makeResidual()
    const client: LLMClient = {
      model: 'test-model',
      complete: vi.fn(async () => ({
        content: null,
        toolCalls: [{ id: '1', name: 'propose_match', argumentsJson: '{not valid json' }],
        usage: usage(10, 10),
        latencyMs: 10,
      })),
    }

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    expect(summary.results[0].outcome).toBe('exception')
  })

  it('declines after MAX_TURNS of pure investigation without a decision', async () => {
    const residual = makeResidual()
    const investigateForever: LLMCompletion = {
      content: null,
      toolCalls: [toolCall('x', 'ledger.search', { counterparty: 'nobody' })],
      usage: usage(10, 5),
      latencyMs: 5,
    }
    const client = scriptedClient([
      investigateForever,
      investigateForever,
      investigateForever,
      investigateForever,
      investigateForever, // one extra in case of an off-by-one; scriptedClient throws if exceeded meaningfully
    ])

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    const r = summary.results[0]
    expect(r.outcome).toBe('exception')
    if (r.outcome !== 'exception') throw new Error('unreachable')
    expect(r.rationale).toMatch(/did not reach a decision/)
    expect(r.reason).toBe('low_confidence')
  })

  it('declines a record rather than crashing the whole run when the API call itself fails', async () => {
    const residual = makeResidual()
    const client: LLMClient = {
      model: 'test-model',
      complete: vi.fn(async () => {
        throw new Error('CONNECT tunnel failed, response 403')
      }),
    }

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    const r = summary.results[0]
    expect(r.outcome).toBe('exception')
    if (r.outcome !== 'exception') throw new Error('unreachable')
    expect(r.rationale).toContain('403')
  })

  it('nudges the model once when it returns prose with no tool call, rather than guessing', async () => {
    const residual = makeResidual()
    const client = scriptedClient([
      { content: 'Let me think about this...', toolCalls: [], usage: usage(20, 20), latencyMs: 10 },
      {
        content: null,
        toolCalls: [
          toolCall('1', 'flag_exception', { reason: 'low_confidence', rationale: 'Insufficient signal.' }),
        ],
        usage: usage(30, 10),
        latencyMs: 10,
      },
    ])

    const summary = await runAdjudication([residual], [], client, { maxAgentRecords: 20 })
    expect(summary.results[0].outcome).toBe('exception')
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it('respects maxAgentRecords, processing the highest-confidence residuals first', async () => {
    const { batch } = generate({ seed: 6 })
    const candidates = buildCandidates(batch.ledger, batch.settlements, DEFAULT_CONFIG)
    const byLedger = new Map<string, typeof candidates>()
    for (const c of candidates) {
      const list = byLedger.get(c.ledger.id)
      if (list) list.push(c)
      else byLedger.set(c.ledger.id, [c])
    }
    const residuals: ResidualCase[] = [...byLedger.entries()]
      .slice(0, 6)
      .map(([, cs]) => ({ ledger: cs[0].ledger, candidates: cs.sort((a, b) => b.confidence - a.confidence) }))

    const client = scriptedClient(
      residuals.slice(0, 2).map(() => ({
        content: null,
        toolCalls: [toolCall('1', 'flag_exception', { reason: 'low_confidence', rationale: 'test' })],
        usage: usage(10, 10),
        latencyMs: 5,
      })),
    )

    const summary = await runAdjudication(residuals, [], client, { maxAgentRecords: 2 })
    const reached = summary.results.filter((r) => r.outcome !== 'not_reached')
    const notReached = summary.results.filter((r) => r.outcome === 'not_reached')
    expect(reached).toHaveLength(2)
    expect(notReached).toHaveLength(4)
    // Highest-confidence residuals should be the ones actually processed.
    const processedIds = new Set(reached.map((r) => r.ledgerId))
    const sortedByConfidence = [...residuals].sort(
      (a, b) => (b.candidates[0]?.confidence ?? 0) - (a.candidates[0]?.confidence ?? 0),
    )
    expect(processedIds.has(sortedByConfidence[0].ledger.id)).toBe(true)
    expect(processedIds.has(sortedByConfidence[1].ledger.id)).toBe(true)
  })
})

describe('reconcile() integration with an injected LLM client', () => {
  it('resolves an otherwise-unresolved record through the agent tier end to end', async () => {
    const { batch } = generate({ seed: 5 })

    // Confirm tiers 1-3 alone leave something unresolved on this seed.
    const baseline = await reconcile(batch, { config: { enableAgent: false } })
    expect(baseline.exceptions.length).toBeGreaterThan(0)

    const client = scriptedClient([
      {
        content: null,
        toolCalls: [
          toolCall('1', 'flag_exception', {
            reason: 'orphan',
            rationale: 'Investigated and found no plausible counterpart.',
          }),
        ],
        usage: usage(50, 20),
        latencyMs: 25,
      },
    ])

    const withAgent = await reconcile(batch, {
      config: { enableAgent: true, maxAgentRecords: 1 },
      llmClient: client,
    })

    expect(withAgent.agentTier).toBe('ran')
    expect(withAgent.stats.tokensUsed).toBeGreaterThan(0)
    expect(withAgent.stats.llmTouchRate).toBeGreaterThan(0)
    expect(withAgent.stats.estimatedCostUsd).toBeGreaterThan(0)
    expect(client.complete).toHaveBeenCalledTimes(1) // maxAgentRecords: 1

    // maxAgentRecords: 1 means the agent touched exactly the highest-confidence
    // residual, not necessarily the first exception in the baseline list — so
    // find whichever exception carries the agent's rationale, rather than
    // assuming which record that would be.
    const agentException = withAgent.exceptions.find((e) => e.rationale?.includes('Investigated'))
    expect(agentException).toBeDefined()
  })

  it('reports skipped_no_key honestly when no client is available, and never fabricates agent stats', async () => {
    const { batch } = generate({ seed: 5 })
    const result = await reconcile(batch, { config: { enableAgent: true }, llmClient: null })
    expect(result.agentTier).toBe('skipped_no_key')
    expect(result.stats.tokensUsed).toBe(0)
    expect(result.stats.llmTouchRate).toBe(0)
    expect(result.matches.some((m) => m.tier === 'agent')).toBe(false)
  })

  it('reports skipped_disabled and never calls the client when the tier is turned off', async () => {
    const { batch } = generate({ seed: 5 })
    const client: LLMClient = { model: 'unused', complete: vi.fn() }
    const result = await reconcile(batch, { config: { enableAgent: false }, llmClient: client })
    expect(result.agentTier).toBe('skipped_disabled')
    expect(client.complete).not.toHaveBeenCalled()
  })

  it('never lets an agent match through below the honesty bar — precision still holds', async () => {
    const { batch, truth } = generate({ seed: 5 })
    const client = scriptedClient(
      Array.from({ length: 5 }, () => ({
        content: null,
        toolCalls: [
          toolCall('1', 'flag_exception', { reason: 'low_confidence', rationale: 'declining, per policy' }),
        ],
        usage: usage(20, 10),
        latencyMs: 5,
      })),
    )
    const result = await reconcile(batch, { config: { enableAgent: true, maxAgentRecords: 5 }, llmClient: client })
    const { score } = await import('@/lib/eval/score')
    const report = score(result, truth)
    expect(report.operating.wrongMatches).toBe(0)
  })
})
