/**
 * Scores the Berka matcher against its ground truth.
 *
 * See the honesty note in `lib/datasets/berka/truth.ts`: this measures
 * correctness and throughput at real scale, not matching difficulty — that is
 * the generator's job. A near-100% score here says the pipeline is fast and
 * correct on a million real rows, not that reconciliation is easy.
 */

import type { BerkaMatchResult } from '../engine/berkaMatch'
import type { BerkaTruth } from '../datasets/berka/truth'

export type BerkaScoreReport = {
  transScored: number
  /** Predicted an order and got the exact right one. */
  correct: number
  /** Predicted an order but the wrong one. */
  wrong: number
  /** Correctly declined — truth says no order, matcher says no order. */
  correctlyDeclined: number
  /** Matcher declined a transaction that truth says does belong to an order. */
  missed: number
  precision: number
  recall: number
}

export function scoreBerka(results: BerkaMatchResult[], truth: BerkaTruth): BerkaScoreReport {
  let correct = 0
  let wrong = 0
  let correctlyDeclined = 0
  let missed = 0
  let claimed = 0
  let matchable = 0

  for (const r of results) {
    const trueOrder = truth.execution.get(r.transId) ?? null
    if (trueOrder !== null) matchable++
    if (r.orderId !== null) claimed++

    if (r.orderId !== null && trueOrder !== null && r.orderId === trueOrder) correct++
    else if (r.orderId !== null && trueOrder !== r.orderId) wrong++
    else if (r.orderId === null && trueOrder === null) correctlyDeclined++
    else if (r.orderId === null && trueOrder !== null) missed++
  }

  return {
    transScored: results.length,
    correct,
    wrong,
    correctlyDeclined,
    missed,
    precision: claimed === 0 ? 1 : correct / claimed,
    recall: matchable === 0 ? 0 : correct / matchable,
  }
}
