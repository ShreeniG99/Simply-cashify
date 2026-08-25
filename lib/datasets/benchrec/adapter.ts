/**
 * BenchRec -> canonical schema.
 *
 * Real semantics, genuinely different from both the Razorpay generator and
 * Berka: this is a pure two-way reconciliation (A = internal ledger, B =
 * external statement), no bank-credit/settlement-batch layer at all, so
 * `bank` is always empty for a BenchRec batch — Stage A/C of the pipeline
 * (`lib/engine/tieout.ts`) never sees a row to tie out. Only Stage B
 * (candidate matching, tiers 1-4) is exercised here, via a dedicated matcher
 * (`lib/engine/benchrecMatch.ts`) rather than `lib/engine/pipeline.ts` — see
 * that file for why (blocking strategy, not account partitioning: this
 * dataset holds everything in one account).
 *
 * What is deliberately NOT carried into `reference`/`memo`: `A_allocation`.
 * It is a real, given input field (present on every A row in the raw CSV,
 * never withheld) rather than a secret — but it is close enough to a direct
 * answer key (only `targetAllocation`, B's own guess at that same string, is
 * withheld) that folding it into a field the matcher's string-scoring reads
 * would turn "reconcile these two transactions" into "do an exact key
 * lookup," which is not what real reconciliation looks like and not what
 * this project's matcher does anywhere else. It is kept only in `raw`, for
 * audit display and — critically — for scoring: `lib/datasets/benchrec/truth.ts`
 * reads it there to check whether the CHOSEN A actually carries the right
 * key, never to feed it to the matcher. That module must not be imported
 * from here or from `lib/engine/benchrecMatch.ts` — enforced by
 * `tests/truth-isolation.test.ts`.
 */

import { toMinor, type CanonicalRecord } from '../canonical'
import type { BenchRecRow } from './types'

function parseAmount(raw: string): bigint | null {
  const s = raw.trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  return toMinor(s)
}

/** Free-text signal the matcher's string scoring can actually compare between sides. */
function memoFor(references: string, attributes: string): string | undefined {
  const text = [references, attributes].map((s) => s.trim()).filter(Boolean).join(' ')
  return text.length > 0 ? text : undefined
}

export function rowsToLedger(rows: BenchRecRow[]): CanonicalRecord[] {
  const out: CanonicalRecord[] = []
  for (const row of rows) {
    if (!row.A_id.trim()) continue
    const amount = parseAmount(row.A_amount)
    if (amount === null) continue
    out.push({
      id: `A_${row.A_id}`,
      source: 'ledger',
      date: row.A_valueDate.trim(),
      amount,
      currency: row.A_currencyCode.trim() || 'USD',
      memo: memoFor(row.A_transactionReferences, row.A_transactionAttributes),
      raw: row,
    })
  }
  return out
}

export function rowsToSettlements(rows: BenchRecRow[]): CanonicalRecord[] {
  const out: CanonicalRecord[] = []
  for (const row of rows) {
    if (!row.B_id.trim()) continue
    const amount = parseAmount(row.B_amount)
    if (amount === null) continue
    out.push({
      id: `B_${row.B_id}`,
      source: 'settlement',
      date: row.B_valueDate.trim(),
      amount,
      currency: row.B_currencyCode.trim() || 'USD',
      memo: memoFor(row.B_transactionReferences, row.B_transactionAttributes),
      raw: row,
    })
  }
  return out
}
