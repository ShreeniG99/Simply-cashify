/**
 * Cash position forecast — 13 weekly numbers, not a calendar.
 *
 * Only possible because reconciliation already ran: week 0 is the cash this
 * run just *confirmed* (matched invoices — money genuinely tied to a
 * settlement, not a guess), and every week after that projects the invoices
 * still outstanding (this run's exceptions on the ledger side) forward using
 * a collection lag *learned from this run's own matched population*, not an
 * assumed constant.
 *
 * Honesty limits, stated plainly rather than hidden in the math:
 *  - "Today" (`asOf`) is defined as the latest ledger invoice date this run
 *    saw — there is no real wall-clock "now" for a synthetic historical
 *    batch, so the forecast horizon starts at the edge of known data.
 *  - The confidence band widens *linearly* with distance from week 0. That
 *    is a placeholder shape, not a fitted variance model — the matched
 *    population in one run (tens to low hundreds of invoices) is too small
 *    to fit a real distribution honestly. Said outright in the UI copy too.
 *  - An open receivable with no matched precedent at all falls back to a
 *    fixed 2-business-day lag (the same T+2 the generator uses for a clean
 *    settlement) rather than silently landing at week 0.
 */

import type { CanonicalBatch } from '../datasets/canonical'
import type { ReconcileResult } from '../engine/types'
import { addBusinessDays, daysBetween, parseISO } from '../util/dates'

export type CashWeek = {
  weekIndex: number
  weekStart: string
  /** Minor units landing in this week specifically (not cumulative). */
  confirmedMinor: bigint
  projectedMinor: bigint
  cumulativeMinor: bigint
  bandLowMinor: bigint
  bandHighMinor: bigint
}

export type CashForecast = {
  asOf: string
  /** Median calendar days between invoice date and settlement date, from this run's own matches. */
  collectionLagDays: number
  /** How many matched invoices the lag was learned from. 0 means the fallback constant was used. */
  lagSampleSize: number
  confirmedMinor: bigint
  openReceivablesMinor: bigint
  weeks: CashWeek[]
}

const FALLBACK_LAG_DAYS = 2
const HORIZON_WEEKS = 13

function median(values: number[]): number {
  if (values.length === 0) return FALLBACK_LAG_DAYS
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function buildCashForecast(
  batch: CanonicalBatch,
  result: ReconcileResult,
  holidays: readonly string[],
): CashForecast {
  const ledgerById = new Map(batch.ledger.map((l) => [l.id, l]))
  const settlementById = new Map(batch.settlements.map((s) => [s.id, s]))

  // Learn the lag from this run's own matched population: invoice date to the
  // date its earliest settlement payment actually landed.
  const lagSamples: number[] = []
  const confirmedIds = new Set<string>()
  let confirmedMinor = 0n
  for (const m of result.matches) {
    const invoice = ledgerById.get(m.ledgerId)
    if (!invoice) continue
    confirmedIds.add(m.ledgerId)
    confirmedMinor += invoice.amount
    for (const pid of m.paymentIds) {
      const payment = settlementById.get(pid)
      if (payment) lagSamples.push(daysBetween(invoice.date, payment.date))
    }
  }
  const collectionLagDays = lagSamples.length > 0 ? median(lagSamples) : FALLBACK_LAG_DAYS

  // "Today": the edge of known data, not a real wall clock — see module doc.
  const asOf = batch.ledger.reduce((max, r) => (r.date > max ? r.date : max), batch.ledger[0]?.date ?? '')

  // Open receivables: ledger-side exceptions this run could not confirm.
  const openReceivables: { amount: bigint; landingDate: string }[] = []
  for (const e of result.exceptions) {
    if (!e.ledgerId) continue
    const invoice = ledgerById.get(e.ledgerId)
    if (!invoice) continue
    const landingDate = addBusinessDays(invoice.date, Math.round(collectionLagDays), holidays)
    openReceivables.push({ amount: invoice.amount, landingDate })
  }
  const openReceivablesMinor = openReceivables.reduce((sum, r) => sum + r.amount, 0n)

  const weeks: CashWeek[] = Array.from({ length: HORIZON_WEEKS }, (_, i) => ({
    weekIndex: i,
    weekStart: addBusinessDaysCalendar(asOf, i * 7),
    confirmedMinor: i === 0 ? confirmedMinor : 0n,
    projectedMinor: 0n,
    cumulativeMinor: 0n,
    bandLowMinor: 0n,
    bandHighMinor: 0n,
  }))

  for (const r of openReceivables) {
    const offset = daysBetween(asOf, r.landingDate)
    const weekIndex = Math.min(HORIZON_WEEKS - 1, Math.max(0, Math.floor(offset / 7)))
    weeks[weekIndex].projectedMinor += r.amount
  }

  let cumulative = 0n
  for (const w of weeks) {
    cumulative += w.confirmedMinor + w.projectedMinor
    w.cumulativeMinor = cumulative
    // Linear widening band on the *projected* (uncertain) portion only — the
    // confirmed week-0 cash carries no band, it already happened.
    const uncertainty =
      openReceivablesMinor > 0n
        ? (openReceivablesMinor * BigInt(w.weekIndex) * 30n) / BigInt(HORIZON_WEEKS - 1 || 1) / 100n
        : 0n
    w.bandLowMinor = cumulative - uncertainty
    w.bandHighMinor = cumulative + uncertainty
  }

  return {
    asOf,
    collectionLagDays,
    lagSampleSize: lagSamples.length,
    confirmedMinor,
    openReceivablesMinor,
    weeks,
  }
}

/** Calendar-day offset for bucket boundaries — weekly buckets don't need business-day precision. */
function addBusinessDaysCalendar(iso: string, days: number): string {
  const d = parseISO(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
