/**
 * GROUND TRUTH for the BenchRec task. Same rule as `lib/datasets/truth.ts`
 * and `lib/datasets/berka/truth.ts`: `lib/engine/benchrecMatch.ts` must
 * never import this module, enforced by `tests/truth-isolation.test.ts`.
 *
 * The plan's own framing, confirmed against the real data: "ground truth is
 * an allocation key = currency + account + attributes, so the scorer
 * compares keys, not row ids." Concretely: every A row already carries its
 * own `A_allocation` fingerprint as a real given input field (never
 * withheld); the only thing actually hidden is each B row's
 * `targetAllocation` — its claim about which A fingerprint it belongs to.
 * `train.csv` reveals that field directly; `eval.csv` blanks it and
 * `solution.csv` is the held-out answer.
 *
 * `ownAllocation` lives here rather than in the adapter specifically so the
 * matching engine has no path to it at all — it is a real, non-secret input
 * field, but folding it into what the matcher's string scoring reads would
 * turn "reconcile these two transactions" into "do an exact key lookup,"
 * which is not what real reconciliation looks like. See the longer note in
 * `lib/datasets/benchrec/adapter.ts`.
 */

import type { BenchRecRow, SolutionRow } from './types'

export type BenchRecTruth = {
  /** B canonical id ("B_123") -> the true allocation key it belongs to, or null if genuinely unmatched (an orphan, or its true A counterpart simply isn't present in this batch). */
  trueAllocation: Map<string, string | null>
  /** A canonical id ("A_123") -> that row's own allocation key. */
  ownAllocation: Map<string, string>
}

function deriveOwnAllocation(rows: BenchRecRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of rows) {
    if (row.A_id.trim() && row.A_allocation.trim()) {
      m.set(`A_${row.A_id}`, row.A_allocation.trim())
    }
  }
  return m
}

/** `train.csv` is fully labeled — every B row already carries its correct `targetAllocation` directly. */
export function deriveBenchRecTruthFromTrain(rows: BenchRecRow[]): BenchRecTruth {
  const trueAllocation = new Map<string, string | null>()
  for (const row of rows) {
    if (!row.B_id.trim()) continue
    const key = row.targetAllocation.trim()
    trueAllocation.set(`B_${row.B_id}`, key.length > 0 ? key : null)
  }
  return { trueAllocation, ownAllocation: deriveOwnAllocation(rows) }
}

/** `eval.csv` withholds `targetAllocation` for its B rows; `solution.csv` is the held-out answer. */
export function deriveBenchRecTruthFromEval(evalRows: BenchRecRow[], solution: SolutionRow[]): BenchRecTruth {
  const trueAllocation = new Map<string, string | null>()
  for (const row of solution) {
    if (!row.B_id.trim()) continue
    const key = row.targetAllocation.trim()
    trueAllocation.set(`B_${row.B_id}`, key.length > 0 ? key : null)
  }
  return { trueAllocation, ownAllocation: deriveOwnAllocation(evalRows) }
}
