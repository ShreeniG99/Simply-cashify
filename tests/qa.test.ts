import { describe, expect, it, vi } from 'vitest'
import {
  answerQuestion,
  buildContext,
  findRecordId,
  narrateTools,
  templateAnswer,
} from '@/lib/qa/answer'
import type { RunPayload } from '@/lib/api/run'
import type { LLMClient, LLMCompletion, LLMMessage } from '@/lib/llm/client'

/** A hand-built RunPayload — enough surface to exercise retrieval and answers. */
function fixture(): RunPayload {
  return {
    runId: 'run_test',
    seed: 1,
    datasetId: 'generated-1',
    createdAt: new Date().toISOString(),
    report: {} as RunPayload['report'],
    ablation: [],
    stats: {} as RunPayload['stats'],
    agentTier: 'skipped_no_key',
    tierBreakdown: [],
    ceiling: 0.9,
    cashForecast: {
      asOf: '2026-09-30',
      collectionLagDays: 2,
      lagSampleSize: 2,
      confirmedMinor: '0.00',
      openReceivablesMinor: '0.00',
      weeks: [],
    },
    matches: [
      {
        ledgerId: 'INV-2841',
        paymentIds: ['pay_2841'],
        tier: 'fuzzy',
        confidence: 0.82,
        amount: '47,392.00',
        counterparty: 'ACME CORP PVT LTD',
        autoCleared: true,
      },
      {
        ledgerId: 'INV-2093',
        paymentIds: ['pay_2093'],
        tier: 'exact',
        confidence: 0.99,
        amount: '10,000.00',
        autoCleared: true,
      },
      {
        ledgerId: 'INV-2124',
        paymentIds: ['pay_2124'],
        tier: 'agent',
        confidence: 0.91,
        amount: '58,860.00',
        autoCleared: true,
      },
    ],
    exceptions: [
      {
        id: 'INV-2008',
        reason: 'low_confidence',
        detail: 'Best candidate pay_2008 scored 0.7, below the 0.72 threshold',
        controllerSummary: 'The closest candidate, pay_2008, falls short of our auto-approval bar — worth a second look before confirming.',
        side: 'ledger',
        record: { id: 'INV-2008', date: '2026-09-15', amount: '9,892.00' },
      },
      {
        id: 'INV-2093-DUP',
        reason: 'duplicate_suspected',
        detail: 'Appears to duplicate INV-2093, which is already settled',
        controllerSummary: 'This looks like a repeat of INV-2093, which is already settled — probably a duplicate entry rather than a separate payment.',
        side: 'ledger',
      },
    ],
    decisions: [
      {
        subjectId: 'INV-2841',
        tier: 'fuzzy',
        outcome: 'matched',
        confidence: 0.82,
        evidence: ['token set 92%', 'settled T+2 business days'],
        toolsCalled: [],
        alternatives: [],
        latencyMs: 0,
      },
      {
        subjectId: 'INV-2008',
        tier: 'exception',
        outcome: 'exception',
        confidence: 0.7,
        evidence: ['amount within 0.1%'],
        toolsCalled: [],
        alternatives: [
          { paymentIds: ['pay_2008'], score: 0.7, rejectedBecause: 'below the 0.72 threshold' },
        ],
        latencyMs: 0,
      },
      {
        subjectId: 'INV-2124',
        tier: 'agent',
        outcome: 'matched',
        confidence: 0.91,
        evidence: ['settlement landed on a bank holiday'],
        toolsCalled: ['calendar.isBusinessDay', 'ledger.search'],
        alternatives: [],
        latencyMs: 340,
        tokensUsed: 210,
      },
    ],
  }
}

describe('findRecordId', () => {
  const run = fixture()

  it('finds an id mentioned in a natural question', () => {
    expect(findRecordId("why didn't INV-2841 settle?", run)).toBe('INV-2841')
  })

  it('finds a payment id, not just a ledger id', () => {
    expect(findRecordId('what is pay_2841 for?', run)).toBe('pay_2841')
  })

  it('finds an id that only appears in an exception, not in matches', () => {
    expect(findRecordId('what happened with INV-2008', run)).toBe('INV-2008')
  })

  it('finds an id that only appears as a decision alternative', () => {
    // pay_2008 appears only inside INV-2008's decision.alternatives, not in matches.
    expect(findRecordId('why not pay_2008', run)).toBe('pay_2008')
  })

  it('prefers the longer, more specific id when both are genuinely present', () => {
    expect(findRecordId('tell me about INV-2093-DUP', run)).toBe('INV-2093-DUP')
  })

  it('returns null rather than guessing when nothing in the run matches', () => {
    expect(findRecordId('why is the sky blue', run)).toBeNull()
    expect(findRecordId('what about INV-9999', run)).toBeNull()
  })
})

describe('buildContext', () => {
  const run = fixture()

  it('resolves a matched record', () => {
    const ctx = buildContext(run, 'INV-2841')
    expect(ctx.outcome).toBe('matched')
    expect(ctx.match?.ledgerId).toBe('INV-2841')
    expect(ctx.decision?.subjectId).toBe('INV-2841')
  })

  it('resolves an exception record', () => {
    const ctx = buildContext(run, 'INV-2008')
    expect(ctx.outcome).toBe('exception')
    expect(ctx.exception?.reason).toBe('low_confidence')
  })

  it('resolves unknown for an id not present, even if somehow requested', () => {
    const ctx = buildContext(run, 'INV-0000')
    expect(ctx.outcome).toBe('unknown')
  })

  it('resolves a match by payment id even though the record key is the ledger id', () => {
    const ctx = buildContext(run, 'pay_2841')
    expect(ctx.outcome).toBe('matched')
    expect(ctx.match?.ledgerId).toBe('INV-2841')
  })
})

describe('narrateTools', () => {
  it('returns null for no tool calls, not an empty sentence', () => {
    expect(narrateTools([])).toBeNull()
    expect(narrateTools([], 'agent')).toBeNull()
  })

  it('agent tier: narrates a real per-record event, past tense', () => {
    const s = narrateTools(['calendar.isBusinessDay'], 'agent')
    expect(s).toContain('checked whether')
    expect(s).toContain('bank holiday')
  })

  it('agent tier: narrates multiple tools in order', () => {
    const s = narrateTools(['calendar.isBusinessDay', 'ledger.search'], 'agent')
    expect(s).toContain('bank holiday')
    expect(s).toContain('broadly across the ledger')
  })

  it('agent tier: falls back to the raw name for an unrecognized tool rather than dropping it', () => {
    expect(narrateTools(['some.futureTool'], 'agent')).toContain('some.futureTool')
  })

  /**
   * Tiers 1-3 compute synchronously, in-process — there is no discrete call to
   * log, only a global capability flag (pipeline.ts's toolsFor). Phrasing that
   * as "it checked whether THIS record's date was a holiday" would claim a
   * specific, provable action that never happened for that record. This is
   * the fix for a real overclaim caught while screenshotting the Q&A card.
   */
  it('non-agent tiers: describes a capability, not a per-record event', () => {
    const s = narrateTools(['calendar.isBusinessDay'], 'fuzzy')
    expect(s).not.toContain('checked whether')
    expect(s).toContain('holiday-aware date scoring')
    expect(s).toContain('not a per-record lookup')
  })

  it('non-agent tiers: same wording regardless of which non-agent tier', () => {
    const undefinedTier = narrateTools(['calendar.isBusinessDay'])
    const exactTier = narrateTools(['calendar.isBusinessDay'], 'exact')
    expect(undefinedTier).toBe(exactTier)
  })

  it('non-agent tiers: deduplicates repeated capability flags', () => {
    const s = narrateTools(['calendar.isBusinessDay', 'calendar.isBusinessDay'], 'fuzzy')
    expect(s?.match(/holiday-aware date scoring/g)?.length).toBe(1)
  })
})

/** Joins headline + points into one string for convenient substring assertions. */
function flatten(answer: { headline: string; points: string[] }): string {
  return [answer.headline, ...answer.points].join(' ')
}

describe('templateAnswer', () => {
  const run = fixture()

  it('returns a headline and points, not one dense paragraph', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2841'))
    expect(typeof answer.headline).toBe('string')
    expect(Array.isArray(answer.points)).toBe(true)
  })

  it('states the match, tier, confidence, and auto-clear status', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2841'))
    expect(answer.headline).toContain('INV-2841')
    expect(answer.headline).toContain('pay_2841')
    expect(answer.headline).toContain('auto-cleared')
    expect(flatten(answer)).toContain('fuzzy')
  })

  it('leads with the controller-voice summary for an exception, not the raw technical detail', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2008'))
    expect(answer.headline).toBe(
      'The closest candidate, pay_2008, falls short of our auto-approval bar — worth a second look before confirming.',
    )
  })

  it('still carries the precise technical numbers in the supporting points, for audit', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2008'))
    expect(flatten(answer)).toContain('0.72 threshold')
  })

  it('surfaces agent tool investigation in the answer — the legibility payoff', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2124'))
    expect(flatten(answer)).toContain('bank holiday')
  })

  it('lists rejected alternatives, each as its own point', () => {
    const answer = templateAnswer(buildContext(run, 'INV-2008'))
    const altPoint = answer.points.find((p) => p.includes('pay_2008'))
    expect(altPoint).toBeDefined()
    expect(altPoint).toContain('set aside')
  })

  it('says plainly that an unknown id does not exist, rather than fabricating', () => {
    const answer = templateAnswer(buildContext(run, 'INV-0000'))
    expect(answer.headline).toBe('No record called INV-0000 exists in this run.')
    expect(answer.points).toEqual([])
  })
})

const usage = (p: number, c: number) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c })

describe('answerQuestion', () => {
  const run = fixture()

  it('answers with the template when no client is configured', async () => {
    const result = await answerQuestion('why is INV-2008 unresolved', run, null)
    expect(result.mode).toBe('template')
    expect(result.recordId).toBe('INV-2008')
    expect(result.answer.headline).toContain('closest candidate')
  })

  it('returns the no-id message, unattached to any record, when nothing matches', async () => {
    const result = await answerQuestion('what is the weather', run, null)
    expect(result.recordId).toBeNull()
    expect(result.mode).toBe('template')
    expect(flatten(result.answer)).toMatch(/specific invoice or payment id/)
  })

  it('uses the LLM to polish prose when a client is configured and returns valid structured JSON', async () => {
    const client: LLMClient = {
      model: 'test',
      complete: vi.fn(
        async (): Promise<LLMCompletion> => ({
          content: JSON.stringify({
            headline: 'INV-2841 cleared automatically via fuzzy matching at 0.82 confidence.',
            points: ['It matched pay_2841 on a strong text and timing signal.'],
          }),
          toolCalls: [],
          usage: usage(80, 20),
          latencyMs: 50,
        }),
      ),
    }
    const result = await answerQuestion("why did INV-2841 settle?", run, client)
    expect(result.mode).toBe('llm')
    expect(result.answer.headline).toContain('0.82')
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it('degrades to the template, not a crash, when the model replies with valid JSON in the wrong shape', async () => {
    const client: LLMClient = {
      model: 'test',
      complete: vi.fn(async (): Promise<LLMCompletion> => ({
        content: JSON.stringify({ answer: 'wrong field name entirely' }),
        toolCalls: [],
        usage: usage(10, 5),
        latencyMs: 10,
      })),
    }
    const result = await answerQuestion('why is INV-2008 unresolved', run, client)
    expect(result.mode).toBe('template')
    expect(result.answer.headline).toContain('closest candidate')
  })

  it('degrades to the template, not a crash, when the model replies with prose instead of JSON', async () => {
    const client: LLMClient = {
      model: 'test',
      complete: vi.fn(async (): Promise<LLMCompletion> => ({
        content: 'Sure! INV-2841 matched pay_2841 at high confidence.',
        toolCalls: [],
        usage: usage(10, 5),
        latencyMs: 10,
      })),
    }
    const result = await answerQuestion('why did INV-2841 settle?', run, client)
    expect(result.mode).toBe('template')
  })

  it('passes only the narrow per-record context to the model, not the whole run', async () => {
    let capturedUserMessage = ''
    const client: LLMClient = {
      model: 'test',
      complete: vi.fn(async (messages: LLMMessage[]) => {
        capturedUserMessage = messages.find((m) => m.role === 'user')?.content as string
        return { content: 'ok', toolCalls: [], usage: usage(10, 5), latencyMs: 10 }
      }),
    }
    await answerQuestion('why did INV-2841 settle?', run, client)
    const parsed = JSON.parse(capturedUserMessage.split('Context: ')[1])
    expect(parsed.recordId).toBe('INV-2841')
    // Must not smuggle unrelated records into the same context.
    expect(JSON.stringify(parsed)).not.toContain('INV-2008')
  })

  it('falls back to the template, not an error, when the live call fails', async () => {
    const client: LLMClient = {
      model: 'test',
      complete: vi.fn(async () => {
        throw new Error('CONNECT tunnel failed, response 403')
      }),
    }
    const result = await answerQuestion('why is INV-2008 unresolved', run, client)
    expect(result.mode).toBe('template')
    expect(result.answer.headline).toContain('closest candidate')
  })

  it('does not call the model at all when no record id was found', async () => {
    const client: LLMClient = { model: 'test', complete: vi.fn() }
    await answerQuestion('what is the weather', run, client)
    expect(client.complete).not.toHaveBeenCalled()
  })
})
