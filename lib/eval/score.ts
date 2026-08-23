/**
 * Scores pipeline output against ground truth.
 *
 * The headline metric is deliberately NOT match rate. In finance a wrong
 * auto-approved match is far more expensive than an honest exception, because a
 * wrong match is invisible — it surfaces at month-end close or in an audit,
 * whereas an exception surfaces immediately and gets checked. So the reported
 * figure is: how much volume can be auto-cleared while holding precision at a
 * target.
 */

import type { ProposedMatch, ReconcileResult } from '../engine/types'
import type { DiscrepancyClass, GroundTruth, TruthPair } from '../datasets/truth'
import { ALL_CLASSES } from '../datasets/truth'

export type ScoreAtThreshold = {
  threshold: number
  /** Claims at or above the threshold. */
  claimed: number
  /** Claims whose payment set exactly equals the truth's. */
  correct: number
  /** Claims that disagree with truth — the expensive, invisible errors. */
  wrongMatches: number
  precision: number
  recall: number
  f1: number
  /** Fraction of all ledger rows resolved without a human. */
  autoClearRate: number
  /** Matchable invoices we explicitly declined. */
  falseExceptions: number
  /** Genuinely unmatchable rows we correctly declined — orphans and duplicates. */
  correctlyDeclined: number
}

export type ClassBreakdown = {
  class: DiscrepancyClass
  total: number
  correct: number
  accuracy: number
}

export type ScoreReport = {
  datasetId: string
  ledgerCount: number
  /** Truth pairs that have at least one payment — the honest ceiling. */
  matchableCount: number
  /** Score at the operating threshold chosen by calibration. */
  operating: ScoreAtThreshold
  /** Full sweep, for the confidence/coverage curve. */
  curve: ScoreAtThreshold[]
  /** Per-discrepancy-class accuracy — what makes the exception list diagnostic. */
  byClass: ClassBreakdown[]
  /** The precision the operating point was selected to hold. */
  precisionTarget: number
  /** True when no threshold reached the target — say so rather than pretending. */
  targetMissed: boolean
}

const DEFAULT_THRESHOLDS = [
  0, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.92, 0.94, 0.96, 0.98, 0.99,
]

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

/**
 * BenchRec's ground truth is an *allocation key* (currency + account +
 * attributes) rather than a row id, so comparison is pluggable. The default
 * compares payment-id sets, which is what the generator and Berka use.
 */
export type MatchComparator = (claim: ProposedMatch, truth: TruthPair) => boolean

export const compareByPaymentIds: MatchComparator = (claim, truth) =>
  sameSet(claim.paymentIds, truth.paymentIds)

export function scoreAtThreshold(
  result: ReconcileResult,
  truth: GroundTruth,
  threshold: number,
  compare: MatchComparator = compareByPaymentIds,
): ScoreAtThreshold {
  const truthByLedger = new Map(truth.pairs.map((p) => [p.ledgerId, p]))
  const matchable = truth.pairs.filter((p) => p.paymentIds.length > 0)
  const ledgerCount = truth.pairs.length

  const claims = result.matches.filter((m) => m.confidence >= threshold)

  let correct = 0
  let wrongMatches = 0
  for (const claim of claims) {
    const t = truthByLedger.get(claim.ledgerId)
    if (t && t.paymentIds.length > 0 && compare(claim, t)) correct++
    else wrongMatches++
  }

  // Anything the pipeline explicitly declined, plus anything demoted below the
  // threshold, lands on a human's desk.
  const claimedIds = new Set(claims.map((m) => m.ledgerId))
  const declinedIds = new Set(
    result.exceptions.map((e) => e.ledgerId).filter((v): v is string => Boolean(v)),
  )
  for (const m of result.matches) {
    if (m.confidence < threshold) declinedIds.add(m.ledgerId)
  }

  let falseExceptions = 0
  let correctlyDeclined = 0
  for (const id of declinedIds) {
    if (claimedIds.has(id)) continue
    const t = truthByLedger.get(id)
    if (!t) continue
    if (t.paymentIds.length > 0) falseExceptions++
    else correctlyDeclined++
  }

  const precision = claims.length === 0 ? 1 : correct / claims.length
  const recall = matchable.length === 0 ? 0 : correct / matchable.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    threshold,
    claimed: claims.length,
    correct,
    wrongMatches,
    precision,
    recall,
    f1,
    autoClearRate: ledgerCount === 0 ? 0 : claims.length / ledgerCount,
    falseExceptions,
    correctlyDeclined,
  }
}

/**
 * Sweep thresholds and pick the operating point: the LOWEST threshold (hence
 * highest coverage) whose precision still meets the target. If nothing meets it,
 * return the best-precision point and flag `targetMissed` rather than quietly
 * reporting a number that misses the bar.
 */
export function score(
  result: ReconcileResult,
  truth: GroundTruth,
  opts: {
    precisionTarget?: number
    thresholds?: number[]
    compare?: MatchComparator
  } = {},
): ScoreReport {
  const precisionTarget = opts.precisionTarget ?? 0.995
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
  const compare = opts.compare ?? compareByPaymentIds

  const curve = thresholds.map((t) => scoreAtThreshold(result, truth, t, compare))

  const qualifying = curve.filter((c) => c.precision >= precisionTarget && c.claimed > 0)
  const targetMissed = qualifying.length === 0
  const operating = targetMissed
    ? curve.reduce((best, c) => (c.precision > best.precision ? c : best), curve[0])
    : qualifying.reduce((best, c) => (c.autoClearRate > best.autoClearRate ? c : best))

  return {
    datasetId: truth.datasetId,
    ledgerCount: truth.pairs.length,
    matchableCount: truth.pairs.filter((p) => p.paymentIds.length > 0).length,
    operating,
    curve,
    byClass: breakdownByClass(result, truth, operating.threshold, compare),
    precisionTarget,
    targetMissed,
  }
}

/**
 * Per-class accuracy. This is the diagnostic payoff of a generated batch: it
 * turns "22 exceptions" into "we handle FX and splits, we lose on typo'd
 * references".
 */
export function breakdownByClass(
  result: ReconcileResult,
  truth: GroundTruth,
  threshold: number,
  compare: MatchComparator = compareByPaymentIds,
): ClassBreakdown[] {
  const claims = new Map(
    result.matches.filter((m) => m.confidence >= threshold).map((m) => [m.ledgerId, m]),
  )
  const declined = new Set(
    result.exceptions.map((e) => e.ledgerId).filter((v): v is string => Boolean(v)),
  )

  return ALL_CLASSES.map((cls) => {
    const pairs = truth.pairs.filter((p) => p.class === cls)
    let correct = 0
    for (const p of pairs) {
      const claim = claims.get(p.ledgerId)
      if (p.paymentIds.length === 0) {
        // Correct behaviour is to decline, not to match.
        if (!claim && declined.has(p.ledgerId)) correct++
      } else if (claim && compare(claim, p)) {
        correct++
      }
    }
    return {
      class: cls,
      total: pairs.length,
      correct,
      accuracy: pairs.length === 0 ? 0 : correct / pairs.length,
    }
  }).filter((b) => b.total > 0)
}
