/**
 * Scores the BenchRec matcher against its ground truth — by ALLOCATION KEY,
 * not by row id, per the plan's own framing of this benchmark. A prediction
 * is "correct" when the A row it chose carries the same allocation key the
 * true answer names, even if a different A row happens to share that key —
 * that is the real competition's own scoring semantics, not a shortcut this
 * project invented.
 *
 * `ceiling` matters here the same way it matters for the synthetic
 * generator: not every B row's true counterpart is even present in a given
 * eval batch (its A row may simply not be included), so a 100% match rate
 * would be a red flag, not a win. Measured directly from the batch's own
 * data (`truth.ownAllocation`'s value set), not asserted.
 */

import type { BenchRecMatchResult } from '../engine/benchrecMatch'
import type { BenchRecTruth } from '../datasets/benchrec/truth'

export type BenchRecScoreReport = {
  bScored: number
  /** Chose an A whose own allocation key matches the true key. */
  correct: number
  /** Chose an A, but its key doesn't match the true key. */
  wrong: number
  /** Correctly declined — no matchable A exists in this batch for this B. */
  correctlyDeclined: number
  /** Declined, but a matchable A genuinely exists in this batch. */
  missed: number
  precision: number
  recall: number
  /** Fraction of B rows whose true A counterpart is actually present in this batch at all. */
  ceiling: number
}

export function scoreBenchRec(results: BenchRecMatchResult[], truth: BenchRecTruth): BenchRecScoreReport {
  const presentKeys = new Set(truth.ownAllocation.values())

  let correct = 0
  let wrong = 0
  let correctlyDeclined = 0
  let missed = 0
  let claimed = 0
  let matchable = 0

  for (const r of results) {
    const trueKey = truth.trueAllocation.get(r.bId) ?? null
    const isMatchable = trueKey !== null && presentKeys.has(trueKey)
    if (isMatchable) matchable++
    if (r.aId !== null) claimed++

    const chosenKey = r.aId ? (truth.ownAllocation.get(r.aId) ?? null) : null
    const isCorrect = r.aId !== null && chosenKey !== null && trueKey !== null && chosenKey === trueKey

    if (isCorrect) correct++
    else if (r.aId !== null) wrong++
    else if (isMatchable) missed++
    else correctlyDeclined++
  }

  return {
    bScored: results.length,
    correct,
    wrong,
    correctlyDeclined,
    missed,
    precision: claimed === 0 ? 1 : correct / claimed,
    recall: matchable === 0 ? 0 : correct / matchable,
    ceiling: results.length === 0 ? 0 : matchable / results.length,
  }
}
