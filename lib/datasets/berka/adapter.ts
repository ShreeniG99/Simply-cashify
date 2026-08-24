/**
 * Berka -> canonical schema.
 *
 * Real semantics: an `order` is a standing payment instruction (e.g. a monthly
 * SIPO household-bill debit); `trans` rows are the actual executed
 * transactions. So the shape here is genuinely different from the Razorpay
 * generator's one-settlement-explodes-to-N-payments batch — it's one standing
 * instruction generating a recurring stream over YEARS (a real account can show
 * 60+ executions of the same order). `lib/engine/berkaMatch.ts` handles that
 * one-to-many shape directly rather than forcing it through the invoice-tier
 * pipeline built for batch explosion.
 *
 * This module must not import `./truth` — same discipline as the generator.
 */

import type { CanonicalRecord } from '../canonical'
import type { OrderRow, TransRow } from './types'

export type BerkaLedgerRecord = CanonicalRecord & { accountId: string }
export type BerkaBankRecord = CanonicalRecord & { accountId: string }

/** `bank:account` as a single comparable identifier — these are structured fields, not narration text to parse. */
function destinationKey(bank: string, account: string): string {
  return `${bank}:${account}`
}

export function ordersToLedger(orders: OrderRow[]): BerkaLedgerRecord[] {
  return orders.map((o) => ({
    id: `order_${o.orderId}`,
    source: 'ledger',
    // Orders carry no date of their own — they are standing instructions, not
    // dated invoices. Left undated; the matcher scores on identifier + amount
    // only for this dataset, which is what real recurring-payment reconciliation
    // is based on.
    date: '',
    amount: o.amount,
    currency: 'CZK',
    reference: destinationKey(o.bankTo, o.accountTo),
    counterparty: o.kSymbol || undefined,
    accountId: o.accountId,
    raw: { order_id: o.orderId, bank_to: o.bankTo, account_to: o.accountTo, k_symbol: o.kSymbol },
  }))
}

/**
 * Only outgoing (`VYDAJ`) transactions can execute a standing order — deposits
 * and cash withdrawals cannot. Filtering here, rather than scoring every row,
 * is what keeps the 1M-row pass tractable without discarding any row silently:
 * the excluded types are still counted and reported by the bench script.
 */
export function transToBank(trans: TransRow[]): BerkaBankRecord[] {
  return trans
    .filter((t) => t.type === 'VYDAJ')
    .map((t) => ({
      id: `trans_${t.transId}`,
      source: 'bank',
      date: t.date,
      amount: t.amount,
      currency: 'CZK',
      reference: destinationKey(t.bank, t.account),
      counterparty: t.kSymbol || undefined,
      accountId: t.accountId,
      raw: { trans_id: t.transId, bank: t.bank, account: t.account, k_symbol: t.kSymbol },
    }))
}
