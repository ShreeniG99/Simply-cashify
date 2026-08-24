/**
 * GROUND TRUTH for the Berka task. Same rule as `lib/datasets/truth.ts`:
 * `lib/engine/berkaMatch.ts` must never import this module, enforced by
 * `tests/truth-isolation.test.ts`.
 *
 * Important honesty note, not a hidden caveat: this truth is derived from the
 * SAME identifier (destination bank+account) the matcher is allowed to use.
 * Unlike the synthetic generator — where truth is independent of every field the
 * matcher sees — this is not a test of matching DIFFICULTY, and reporting a
 * near-100% accuracy on it would not mean the same thing as a 100% score on the
 * generator would. What it genuinely proves is scale: the full pipeline runs
 * correctly and fast over real, unmodified, million-row financial data, and
 * correctly declines the ~85% of transactions that have no standing order
 * behind them at all. The generator, not Berka, is where matching difficulty is
 * exercised — see DATA.md.
 */

import type { OrderRow, TransRow } from './types'

export type BerkaTruth = {
  /**
   * Canonical trans id ("trans_123") -> canonical order id it executes
   * ("order_45"), or null. IDs are prefixed to match `berka/adapter.ts` exactly
   * so the scorer can compare truth to the matcher's output without translation.
   */
  execution: Map<string, string | null>
  /** Canonical order id -> whether at least one trans row ever executed it. */
  orderExecuted: Map<string, boolean>
}

function destinationKey(bank: string, account: string): string {
  return `${bank}:${account}`
}

export function deriveBerkaTruth(orders: OrderRow[], trans: TransRow[]): BerkaTruth {
  // Index orders per account: an execution can only belong to an order on the
  // SAME account, and a trans row only ever needs to be checked against that
  // handful of candidates rather than all 6,471 orders.
  const ordersByAccount = new Map<string, OrderRow[]>()
  for (const o of orders) {
    const list = ordersByAccount.get(o.accountId)
    if (list) list.push(o)
    else ordersByAccount.set(o.accountId, [o])
  }

  const execution = new Map<string, string | null>()
  const orderExecuted = new Map<string, boolean>(orders.map((o) => [`order_${o.orderId}`, false]))

  for (const t of trans) {
    const transId = `trans_${t.transId}`
    if (t.type !== 'VYDAJ') {
      execution.set(transId, null)
      continue
    }
    const candidates = ordersByAccount.get(t.accountId)
    if (!candidates) {
      execution.set(transId, null)
      continue
    }
    const key = destinationKey(t.bank, t.account)
    const hit = candidates.find((o) => destinationKey(o.bankTo, o.accountTo) === key && o.amount === t.amount)
    const orderId = hit ? `order_${hit.orderId}` : null
    execution.set(transId, orderId)
    if (orderId) orderExecuted.set(orderId, true)
  }

  return { execution, orderExecuted }
}
