/**
 * Matches Berka transactions to the standing orders they execute.
 *
 * Deliberately NOT routed through the invoice-tier pipeline (`pipeline.ts`).
 * That pipeline resolves one ledger row to one (or, for a split, two) payment
 * rows — the Razorpay batch-explosion shape. A Berka order can be executed by
 * dozens of transactions spread over years, which is a different cardinality
 * entirely, so this is a dedicated one-to-many pass. It reuses `scoreAmount`
 * from the shared engine so the tolerance logic stays in one place.
 *
 * Tractability: naively scoring every (order, trans) pair is 6,471 x 1,056,320
 * ≈ 6.8 BILLION comparisons — not happening. A trans row can only ever execute
 * an order on the SAME account, so partitioning by account_id first turns this
 * into (orders per account) x (trans per account) summed over ~4,500 accounts,
 * each of which holds at most a handful of orders. This is not a shortcut that
 * changes the answer — no order ever executes on another account's money — it's
 * the same restriction a real reconciliation system would apply, made necessary
 * here by the requirement to make it not run out of memory.
 */

import type { BerkaLedgerRecord, BerkaBankRecord } from '../datasets/berka/adapter'
import { scoreAmount } from './match'

export type BerkaMatchResult = {
  transId: string
  orderId: string | null
  confidence: number
}

export type BerkaMatchStats = {
  transConsidered: number
  transWithNoOrderOnAccount: number
  ordersConsidered: number
}

const AMOUNT_TOLERANCE_PCT = 0.1
/** Below this, an order that exists on the account is still not a plausible source. */
const ACCEPT_THRESHOLD = 0.8

export function matchBerka(
  ledger: BerkaLedgerRecord[],
  bank: BerkaBankRecord[],
): { results: BerkaMatchResult[]; stats: BerkaMatchStats } {
  const ordersByAccount = new Map<string, BerkaLedgerRecord[]>()
  for (const o of ledger) {
    const list = ordersByAccount.get(o.accountId)
    if (list) list.push(o)
    else ordersByAccount.set(o.accountId, [o])
  }

  const results: BerkaMatchResult[] = []
  let transWithNoOrderOnAccount = 0

  for (const t of bank) {
    const candidates = ordersByAccount.get(t.accountId)
    if (!candidates || candidates.length === 0) {
      transWithNoOrderOnAccount++
      results.push({ transId: t.id, orderId: null, confidence: 0 })
      continue
    }

    let best: { order: BerkaLedgerRecord; confidence: number } | null = null
    for (const order of candidates) {
      // Structured-field equality, not narration parsing: these are
      // machine-written columns (destination bank + account), not free text.
      const identifierHit = order.reference === t.reference
      if (!identifierHit) continue

      const amount = scoreAmount(order.amount, t.amount, AMOUNT_TOLERANCE_PCT)
      // Weighted toward amount once the identifier already agrees; the
      // identifier match is what makes this order plausible at all.
      const confidence = 0.5 + amount.score * 0.5
      if (!best || confidence > best.confidence) best = { order, confidence }
    }

    if (best && best.confidence >= ACCEPT_THRESHOLD) {
      results.push({ transId: t.id, orderId: best.order.id, confidence: best.confidence })
    } else {
      results.push({ transId: t.id, orderId: null, confidence: best?.confidence ?? 0 })
    }
  }

  return {
    results,
    stats: {
      transConsidered: bank.length,
      transWithNoOrderOnAccount,
      ordersConsidered: ledger.length,
    },
  }
}
