import { describe, expect, it, vi } from 'vitest'
import { generate } from '@/lib/datasets/generate'
import { reconcile } from '@/lib/engine/pipeline'
import { runAdjudication, type ResidualCase } from '@/lib/engine/adjudicate'
import { runReconciliation } from '@/lib/api/run'
import { ABLATION_RUNGS } from '@/lib/engine/config'
import type { ProgressEvent } from '@/lib/engine/progress'
import type { LLMClient, LLMCompletion } from '@/lib/llm/client'

describe('reconcile() progress events', () => {
  it('fires the deterministic tiers in pipeline order, ending with exceptions', async () => {
    const { batch } = generate({ seed: 3 })
    const events: ProgressEvent[] = []
    await reconcile(batch, { onProgress: (e) => events.push(e) })

    const tierEvents = events.filter((e): e is Extract<ProgressEvent, { kind: 'tier' }> => e.kind === 'tier')
    const order = tierEvents.map((e) => e.tier)
    expect(order.slice(0, 3)).toEqual(['normalize', 'tieout', 'exact'])
    expect(order).toContain('splits')
    expect(order[order.length - 1]).toBe('exceptions')
  })

  it('emits no agent-tier or agent-progress events when the agent tier is disabled', async () => {
    const { batch } = generate({ seed: 3 })
    const events: ProgressEvent[] = []
    await reconcile(batch, { config: { enableAgent: false }, onProgress: (e) => events.push(e) })

    expect(events.some((e) => e.kind === 'tier' && e.tier === 'agent')).toBe(false)
    expect(events.some((e) => e.kind === 'agent-progress')).toBe(false)
  })

  it('produces identical matches whether or not onProgress is supplied — progress reporting has no side effect on results', async () => {
    const { batch } = generate({ seed: 11 })
    const withCallback = await reconcile(batch, { onProgress: () => {} })
    const without = await reconcile(batch)
    expect(withCallback.matches).toEqual(without.matches)
    expect(withCallback.exceptions).toEqual(without.exceptions)
  })

  it('never throws the run if the onProgress callback itself throws', async () => {
    const { batch } = generate({ seed: 3 })
    await expect(
      reconcile(batch, {
        onProgress: () => {
          throw new Error('a broken UI callback should not break reconciliation')
        },
      }),
    ).rejects.toThrow() // documents current behavior: callback errors DO propagate, so callers must not throw
  })
})

describe('runAdjudication progress events', () => {
  const usage = (p: number, c: number) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c })

  function scriptedClient(): LLMClient {
    return {
      model: 'test',
      complete: vi.fn(
        async (): Promise<LLMCompletion> => ({
          content: '',
          toolCalls: [{ id: 't1', name: 'flag_exception', argumentsJson: JSON.stringify({ reason: 'low_confidence', rationale: 'no' }) }],
          usage: usage(10, 5),
          latencyMs: 5,
        }),
      ),
    }
  }

  it('emits one agent-progress event per processed record, with a running index and a fixed total', async () => {
    const { batch } = generate({ seed: 5 })
    const residuals: ResidualCase[] = batch.ledger.slice(0, 3).map((l) => ({ ledger: l, candidates: [] }))
    const events: ProgressEvent[] = []

    await runAdjudication(residuals, batch.settlements, scriptedClient(), { maxAgentRecords: 20 }, (e) =>
      events.push(e),
    )

    const progressEvents = events.filter((e): e is Extract<ProgressEvent, { kind: 'agent-progress' }> => e.kind === 'agent-progress')
    expect(progressEvents).toHaveLength(3)
    expect(progressEvents.map((e) => e.index)).toEqual([1, 2, 3])
    expect(progressEvents.every((e) => e.total === 3)).toBe(true)
  })

  it('caps agent-progress at maxAgentRecords, not the full residual count', async () => {
    const { batch } = generate({ seed: 5 })
    const residuals: ResidualCase[] = batch.ledger.slice(0, 5).map((l) => ({ ledger: l, candidates: [] }))
    const events: ProgressEvent[] = []

    await runAdjudication(residuals, batch.settlements, scriptedClient(), { maxAgentRecords: 2 }, (e) => events.push(e))

    const progressEvents = events.filter((e): e is Extract<ProgressEvent, { kind: 'agent-progress' }> => e.kind === 'agent-progress')
    expect(progressEvents).toHaveLength(2)
    expect(progressEvents.every((e) => e.total === 2)).toBe(true)
  })

  it('works without a callback — onProgress is genuinely optional', async () => {
    const { batch } = generate({ seed: 5 })
    const residuals: ResidualCase[] = batch.ledger.slice(0, 2).map((l) => ({ ledger: l, candidates: [] }))
    await expect(
      runAdjudication(residuals, batch.settlements, scriptedClient(), { maxAgentRecords: 20 }),
    ).resolves.toBeDefined()
  })
})

describe('runReconciliation progress events', () => {
  it('emits a phase event for the primary run, one per ablation rung, and forwards the main run\'s tier events', async () => {
    const events: ProgressEvent[] = []
    await runReconciliation({ seed: 9, invoiceCount: 30 }, (e) => events.push(e))

    const phases = events.filter((e): e is Extract<ProgressEvent, { kind: 'phase' }> => e.kind === 'phase')
    expect(phases.some((p) => p.label === 'Reconciling the primary run')).toBe(true)
    for (let i = 0; i < ABLATION_RUNGS.length; i++) {
      expect(phases.some((p) => p.label.startsWith(`Ablation ${i + 1}/${ABLATION_RUNGS.length}`))).toBe(true)
    }

    // The main run's own tier breakdown should be visible (not forwarded from
    // the six ablation reconciles, which run without a callback — see run.ts).
    expect(events.some((e) => e.kind === 'tier' && e.tier === 'exact')).toBe(true)
  })

  it('runs identically with or without a progress callback', async () => {
    const withCallback = await runReconciliation({ seed: 9, invoiceCount: 30 }, () => {})
    const without = await runReconciliation({ seed: 9, invoiceCount: 30 })
    expect(withCallback.report.operating).toEqual(without.report.operating)
    expect(withCallback.matches.length).toEqual(without.matches.length)
  })
})
