import { beforeAll, describe, expect, it } from 'vitest'
import { buildCashForecast } from '@/lib/forecast/cash'
import { generate } from '@/lib/datasets/generate'
import { reconcile } from '@/lib/engine/pipeline'
import { IN_FIXED_HOLIDAYS_2026 } from '@/lib/util/dates'
import type { CanonicalBatch } from '@/lib/datasets/canonical'
import type { ReconcileResult } from '@/lib/engine/types'

describe('buildCashForecast', () => {
  let batch: CanonicalBatch
  let result: ReconcileResult

  beforeAll(async () => {
    const gen = generate({ seed: 42 })
    batch = gen.batch
    result = await reconcile(batch)
  })

  it('produces exactly 13 weekly buckets', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    expect(f.weeks).toHaveLength(13)
    expect(f.weeks.map((w) => w.weekIndex)).toEqual([...Array(13).keys()])
  })

  it('confirms exactly the matched invoice total in week 0, nowhere else', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    expect(f.weeks[0].confirmedMinor).toBe(f.confirmedMinor)
    expect(f.confirmedMinor).toBeGreaterThan(0n)
    for (let i = 1; i < f.weeks.length; i++) {
      expect(f.weeks[i].confirmedMinor).toBe(0n)
    }
  })

  it('learns the collection lag from this run\'s own matches rather than assuming a constant', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    expect(f.lagSampleSize).toBeGreaterThan(0)
    expect(f.collectionLagDays).toBeGreaterThanOrEqual(0)
  })

  it('projects every ledger-side exception as an open receivable, none dropped', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    const ledgerExceptionTotal = result.exceptions
      .filter((e) => e.ledgerId)
      .reduce((sum, e) => {
        const rec = batch.ledger.find((l) => l.id === e.ledgerId)
        return sum + (rec?.amount ?? 0n)
      }, 0n)
    expect(f.openReceivablesMinor).toBe(ledgerExceptionTotal)
  })

  it('cumulative total by the last week equals confirmed + all open receivables', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    const last = f.weeks[f.weeks.length - 1]
    expect(last.cumulativeMinor).toBe(f.confirmedMinor + f.openReceivablesMinor)
  })

  it('cumulative total is monotonically non-decreasing week over week', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    for (let i = 1; i < f.weeks.length; i++) {
      expect(f.weeks[i].cumulativeMinor).toBeGreaterThanOrEqual(f.weeks[i - 1].cumulativeMinor)
    }
  })

  it('confidence band widens (or holds) with distance from week 0, never narrows', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    let prevWidth = 0n
    for (const w of f.weeks) {
      const width = w.bandHighMinor - w.bandLowMinor
      expect(width).toBeGreaterThanOrEqual(0n)
      expect(width).toBeGreaterThanOrEqual(prevWidth)
      prevWidth = width
    }
  })

  it('week 0 carries no band — it already happened, not a projection', () => {
    const f = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
    expect(f.weeks[0].bandHighMinor - f.weeks[0].bandLowMinor).toBe(0n)
  })

  it('falls back to a fixed lag honestly when a run has no matches to learn from', () => {
    const empty: ReconcileResult = {
      datasetId: 'empty',
      matches: [],
      exceptions: [],
      tieouts: [],
      decisions: [],
      agentTier: 'skipped_disabled',
      stats: {
        recordCount: 0,
        ledgerCount: 0,
        wallClockMs: 0,
        recordsPerSecond: 0,
        llmTouchRate: 0,
        tokensUsed: 0,
        estimatedCostUsd: 0,
        latencyP50Ms: 0,
        latencyP95Ms: 0,
      },
    }
    const f = buildCashForecast(batch, empty, IN_FIXED_HOLIDAYS_2026)
    expect(f.lagSampleSize).toBe(0)
    expect(f.collectionLagDays).toBe(2)
  })
})
