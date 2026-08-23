import { describe, expect, it } from 'vitest'
import { score, scoreAtThreshold } from '@/lib/eval/score'
import type { ReconcileResult } from '@/lib/engine/types'
import type { GroundTruth } from '@/lib/datasets/truth'
import { countClasses } from '@/lib/datasets/truth'
import { generate } from '@/lib/datasets/generate'
import { reconcile } from '@/lib/engine/pipeline'
import { ABLATION_RUNGS } from '@/lib/engine/config'

/** A hand-built fixture with a known right answer. */
function fixture(): { result: ReconcileResult; truth: GroundTruth } {
  const pairs = [
    { ledgerId: 'L1', paymentIds: ['P1'], class: 'clean' as const },
    { ledgerId: 'L2', paymentIds: ['P2'], class: 'clean' as const },
    { ledgerId: 'L3', paymentIds: ['P3'], class: 'clean' as const },
    { ledgerId: 'L4', paymentIds: [], class: 'true_orphan' as const },
  ]

  const result: ReconcileResult = {
    datasetId: 'fixture',
    matches: [
      { ledgerId: 'L1', paymentIds: ['P1'], tier: 'exact', confidence: 0.99 }, // right
      { ledgerId: 'L2', paymentIds: ['P9'], tier: 'fuzzy', confidence: 0.9 }, // WRONG
      { ledgerId: 'L3', paymentIds: ['P3'], tier: 'fuzzy', confidence: 0.6 }, // right, low conf
    ],
    exceptions: [{ ledgerId: 'L4', reason: 'orphan', detail: 'no counterpart' }],
    tieouts: [],
    decisions: [],
    agentTier: 'skipped_disabled',
    stats: {
      recordCount: 8,
      ledgerCount: 4,
      wallClockMs: 1,
      recordsPerSecond: 8000,
      llmTouchRate: 0,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
    },
  }

  return {
    result,
    truth: { datasetId: 'fixture', seed: 0, tieouts: [], pairs, classCounts: countClasses(pairs) },
  }
}

describe('scorer', () => {
  it('computes precision, recall and auto-clear at a low threshold', () => {
    const { result, truth } = fixture()
    const s = scoreAtThreshold(result, truth, 0.5)
    expect(s.claimed).toBe(3)
    expect(s.correct).toBe(2) // L1 and L3
    expect(s.wrongMatches).toBe(1) // L2 claimed P9
    expect(s.precision).toBeCloseTo(2 / 3)
    expect(s.recall).toBeCloseTo(2 / 3) // 3 matchable
    expect(s.autoClearRate).toBeCloseTo(3 / 4)
  })

  it('raising the threshold trades coverage for precision', () => {
    const { result, truth } = fixture()
    const high = scoreAtThreshold(result, truth, 0.95)
    expect(high.claimed).toBe(1) // only the 0.99 exact survives
    expect(high.correct).toBe(1)
    expect(high.precision).toBe(1)
    expect(high.autoClearRate).toBeCloseTo(1 / 4)
    // Both demoted rows are matchable in truth, so both now need a human:
    // L3 (correct but under-confident) and L2 (which was wrong anyway).
    expect(high.falseExceptions).toBe(2)
  })

  it('credits correctly declining an unmatchable row', () => {
    const { result, truth } = fixture()
    expect(scoreAtThreshold(result, truth, 0.5).correctlyDeclined).toBe(1) // L4
  })

  it('picks the highest-coverage operating point that still meets the target', () => {
    const { result, truth } = fixture()
    const report = score(result, truth, { precisionTarget: 1 })
    expect(report.targetMissed).toBe(false)
    expect(report.operating.precision).toBe(1)
  })

  it('flags a missed target rather than quietly reporting a worse number', () => {
    const { result, truth } = fixture()
    const impossible = score(result, truth, {
      precisionTarget: 1,
      thresholds: [0.5, 0.6], // every point here includes the wrong match
    })
    expect(impossible.targetMissed).toBe(true)
  })
})

describe('end-to-end on generated data', () => {
  const { batch, truth } = generate({ seed: 42 })
  const result = reconcile(batch)
  const report = score(result, truth)

  it('never auto-approves a wrong match at the operating point', () => {
    // A wrong auto-approved match is the expensive, invisible failure. It is
    // strictly worse than an honest exception.
    expect(report.operating.wrongMatches).toBe(0)
    expect(report.operating.precision).toBeGreaterThanOrEqual(report.precisionTarget)
  })

  it('does not claim to have matched everything', () => {
    // 100% would mean it guessed on the true orphans.
    expect(report.operating.autoClearRate).toBeLessThan(1)
    expect(result.exceptions.length).toBeGreaterThan(0)
  })

  it('gives every exception a typed reason and a readable detail', () => {
    for (const e of result.exceptions) {
      expect(e.reason).toBeTruthy()
      expect(e.detail.length).toBeGreaterThan(10)
    }
  })

  it('writes a decision record for every ledger row', () => {
    const subjects = new Set(result.decisions.map((d) => d.subjectId))
    for (const l of batch.ledger) expect(subjects.has(l.id)).toBe(true)
  })

  it('ties out every bank credit that has a settlement behind it', () => {
    const tied = result.tieouts.filter((t) => t.settlementBatchId !== null)
    expect(tied.length).toBeGreaterThan(0)
    // Stage C must hold for every batch we tied out.
    for (const t of tied) expect(t.feeMathOk).toBe(true)
  })
})

describe('ablation', () => {
  const { batch, truth } = generate({ seed: 42 })

  const rungs = ABLATION_RUNGS.map((rung) => ({
    label: rung.label,
    report: score(reconcile(batch, { config: rung.overrides }), truth),
  }))

  it('every rung holds the precision target — capability adds coverage, not risk', () => {
    for (const r of rungs) {
      expect(r.report.operating.precision, r.label).toBeGreaterThanOrEqual(0.995)
    }
  })

  it('fuzzy matching measurably beats exact-only', () => {
    const exact = rungs.find((r) => r.label === 'Exact only')!
    const fuzzy = rungs.find((r) => r.label === '+ Fuzzy')!
    expect(fuzzy.report.operating.recall).toBeGreaterThan(exact.report.operating.recall)
  })

  it('holiday awareness earns its place, rather than decorating the table', () => {
    // If this fails, the holiday class has gone inert again — check that the
    // chosen holiday still falls on a weekday.
    const before = rungs.find((r) => r.label === '+ FX normalization')!
    const after = rungs.find((r) => r.label === '+ Holiday-aware windows')!
    expect(after.report.operating.recall).toBeGreaterThan(before.report.operating.recall)
    expect(after.report.operating.falseExceptions).toBeLessThan(
      before.report.operating.falseExceptions,
    )
  })
})
