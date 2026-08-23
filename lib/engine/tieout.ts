/**
 * Stage A — batch tie-out, and Stage C — fee arithmetic.
 *
 * Stage A matches a bank credit to a settlement batch by UTR + value date + net
 * amount. It is mostly deterministic: the UTR is a strong identifier, so this
 * rarely needs anything past tier 2.
 *
 * Stage C is not matching at all. It is verification: does
 * `gross − fees − tax ± refunds` equal what actually landed in the bank? A break
 * here is its own exception class, because it means the settlement report and
 * the credit disagree about money regardless of which invoices are involved.
 */

import type { CanonicalRecord } from '../datasets/canonical'
import type { MatchConfig } from './config'
import type { TieoutResult } from './types'
import { groupByBatch } from './types'
import { extractIdentifiers } from './strings'
import { businessDaysBetween, daysBetween } from '../util/dates'

export type BatchAggregate = {
  batchId: string
  /** Sum of positive payment rows. */
  gross: bigint
  /** Sum of negative rows (refund adjustments), as a negative number. */
  refunds: bigint
  fees: bigint
  tax: bigint
  /** What the bank credit should be. */
  expectedNet: bigint
  date: string
  utrs: string[]
  payments: CanonicalRecord[]
}

export function aggregateBatches(payments: CanonicalRecord[]): BatchAggregate[] {
  const grouped = groupByBatch(payments)
  const out: BatchAggregate[] = []

  for (const [batchId, rows] of grouped) {
    let gross = 0n
    let refunds = 0n
    let fees = 0n
    let tax = 0n
    const utrs = new Set<string>()

    for (const r of rows) {
      if (r.amount >= 0n) gross += r.amount
      else refunds += r.amount
      fees += r.fees ?? 0n
      tax += r.tax ?? 0n
      for (const u of extractIdentifiers(r.memo).utrs) utrs.add(u)
      const rawUtr = r.raw?.utr
      if (typeof rawUtr === 'string') utrs.add(rawUtr.toUpperCase())
    }

    out.push({
      batchId,
      gross,
      refunds,
      fees,
      tax,
      expectedNet: gross + refunds - fees - tax,
      date: rows.reduce((acc, r) => (r.date > acc ? r.date : acc), rows[0].date),
      utrs: [...utrs],
      payments: rows,
    })
  }

  return out
}

export function tieOut(
  bank: CanonicalRecord[],
  payments: CanonicalRecord[],
  cfg: MatchConfig,
): TieoutResult[] {
  const batches = aggregateBatches(payments)
  const claimed = new Set<string>()
  const results: TieoutResult[] = []

  for (const credit of bank) {
    const creditUtrs = new Set<string>([
      ...extractIdentifiers(credit.memo).utrs,
      ...extractIdentifiers(credit.reference).utrs,
    ])
    const rawUtr = credit.raw?.utr
    if (typeof rawUtr === 'string') creditUtrs.add(rawUtr.toUpperCase())

    let best: { batch: BatchAggregate; confidence: number } | null = null

    for (const b of batches) {
      if (claimed.has(b.batchId)) continue

      const utrHit = b.utrs.some((u) => creditUtrs.has(u))
      const amountHit = b.expectedNet === credit.amount
      const gap = cfg.enableHolidayAwareness
        ? Math.abs(businessDaysBetween(b.date, credit.date, cfg.holidays))
        : Math.abs(daysBetween(b.date, credit.date))
      const dateHit = gap <= cfg.dateToleranceBusinessDays

      // UTR alone is close to conclusive; amount + date together are strong.
      let confidence = 0
      if (utrHit && amountHit) confidence = 0.99
      else if (utrHit) confidence = 0.9
      else if (amountHit && dateHit) confidence = 0.8
      else continue

      if (!best || confidence > best.confidence) best = { batch: b, confidence }
    }

    if (!best) {
      results.push({
        bankId: credit.id,
        settlementBatchId: null,
        tier: null,
        confidence: 0,
        feeMathOk: false,
        feeMathDelta: 0n,
      })
      continue
    }

    claimed.add(best.batch.batchId)
    const delta = best.batch.expectedNet - credit.amount

    results.push({
      bankId: credit.id,
      settlementBatchId: best.batch.batchId,
      tier: best.confidence >= 0.99 ? 'exact' : 'fuzzy',
      confidence: best.confidence,
      feeMathOk: delta === 0n,
      feeMathDelta: delta,
    })
  }

  return results
}
