import { describe, expect, it } from 'vitest'
import { parseBerkaDate, parseOrders, parseTrans } from '@/lib/datasets/berka/loader'
import { ordersToLedger, transToBank } from '@/lib/datasets/berka/adapter'
import { deriveBerkaTruth } from '@/lib/datasets/berka/truth'
import { matchBerka } from '@/lib/engine/berkaMatch'
import { scoreBerka } from '@/lib/eval/berkaScore'
import type { OrderRow, TransRow } from '@/lib/datasets/berka/types'

// Real Berka format: `;`-delimited, quoted, CRLF-terminated.
const ORDER_FIXTURE =
  '"order_id";"account_id";"bank_to";"account_to";"amount";"k_symbol"\r\n' +
  '29401;1;"YZ";"87144583";2452.00;"SIPO"\r\n' +
  '29402;2;"ST";"89597016";3372.70;"UVER"\r\n' +
  '29403;2;"QR";"13943797";7266.00;"SIPO"\r\n'

const TRANS_FIXTURE =
  '"trans_id";"account_id";"date";"type";"operation";"amount";"balance";"k_symbol";"bank";"account"\r\n' +
  // Executes order 29401 (account 1, dest YZ:87144583, amount 2452.00).
  '100001;1;930805;"VYDAJ";"PREVOD NA UCET";2452.00;10000.00;"SIPO";"YZ";"87144583"\r\n' +
  // Executes order 29403 (account 2, dest QR:13943797, amount 7266.00), twice — recurring.
  '100002;2;930805;"VYDAJ";"PREVOD NA UCET";7266.00;31802.90;"SIPO";"QR";"13943797"\r\n' +
  '100003;2;930905;"VYDAJ";"PREVOD NA UCET";7266.00;19725.80;"SIPO";"QR";"13943797"\r\n' +
  // Ordinary deposit, unrelated to any order.
  '100004;1;930101;"PRIJEM";"VKLAD";700.00;700.00;"";"";""\r\n' +
  // Outgoing on account 1, but to a different destination — no order behind it.
  '100005;1;931010;"VYDAJ";"VYBER";500.00;9500.00;"";"XX";"99999999"\r\n'
// Note: order 29402 (account 2, ST:89597016) is never executed — an organic
// orphan, exactly like the true_orphan class in the synthetic generator.

describe('Berka date parsing', () => {
  it('converts YYMMDD to ISO for the 1993-1999 range', () => {
    expect(parseBerkaDate('930805')).toBe('1993-08-05')
    expect(parseBerkaDate('981231')).toBe('1998-12-31')
  })
})

describe('Berka parsing', () => {
  it('parses orders, stripping quotes and CRLF', () => {
    const rows = parseOrders(ORDER_FIXTURE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      orderId: '29401',
      accountId: '1',
      bankTo: 'YZ',
      accountTo: '87144583',
      amount: 245200n,
      kSymbol: 'SIPO',
    })
  })

  it('parses transactions', () => {
    const rows = parseTrans(TRANS_FIXTURE)
    expect(rows).toHaveLength(5)
    expect(rows[0].date).toBe('1993-08-05')
    expect(rows[0].amount).toBe(245200n)
    expect(rows[0].type).toBe('VYDAJ')
  })
})

describe('Berka adapter', () => {
  const orders = parseOrders(ORDER_FIXTURE)
  const trans = parseTrans(TRANS_FIXTURE)

  it('carries a canonical id prefix consistent with truth', () => {
    const ledger = ordersToLedger(orders)
    expect(ledger[0].id).toBe('order_29401')
  })

  it('filters to VYDAJ only, without silently dropping the rest', () => {
    const bank = transToBank(trans)
    // 100004 is PRIJEM, excluded.
    expect(bank).toHaveLength(4)
    expect(bank.every((b) => trans.find((t) => `trans_${t.transId}` === b.id)?.type === 'VYDAJ')).toBe(
      true,
    )
  })
})

describe('Berka ground truth', () => {
  const orders = parseOrders(ORDER_FIXTURE)
  const trans = parseTrans(TRANS_FIXTURE)
  const truth = deriveBerkaTruth(orders, trans)

  it('ties a recurring execution back to its order across multiple months', () => {
    expect(truth.execution.get('trans_100002')).toBe('order_29403')
    expect(truth.execution.get('trans_100003')).toBe('order_29403')
  })

  it('correctly finds no order for an unrelated outgoing transaction', () => {
    expect(truth.execution.get('trans_100005')).toBe(null)
  })

  it('marks a never-executed order as an organic orphan', () => {
    expect(truth.orderExecuted.get('order_29402')).toBe(false)
    expect(truth.orderExecuted.get('order_29401')).toBe(true)
  })
})

describe('Berka matcher', () => {
  const orders = parseOrders(ORDER_FIXTURE)
  const trans = parseTrans(TRANS_FIXTURE)
  const ledger = ordersToLedger(orders)
  const bank = transToBank(trans)
  const truth = deriveBerkaTruth(orders, trans)
  const { results } = matchBerka(ledger, bank)

  it('matches both recurring executions to the same order', () => {
    const r2 = results.find((r) => r.transId === 'trans_100002')!
    const r3 = results.find((r) => r.transId === 'trans_100003')!
    expect(r2.orderId).toBe('order_29403')
    expect(r3.orderId).toBe('order_29403')
  })

  it('declines a transaction to the wrong destination on the same account', () => {
    const r = results.find((r) => r.transId === 'trans_100005')!
    expect(r.orderId).toBe(null)
  })

  it('scores perfectly on this fixture — the task is unambiguous by construction', () => {
    const report = scoreBerka(results, truth)
    expect(report.precision).toBe(1)
    expect(report.wrong).toBe(0)
  })
})

describe('Berka at a larger synthetic scale (no network required)', () => {
  it('stays correct and fast across a few thousand synthetic accounts', () => {
    const orders: OrderRow[] = []
    const trans: TransRow[] = []
    for (let i = 0; i < 3000; i++) {
      const accountId = String(i)
      orders.push({
        orderId: String(i),
        accountId,
        bankTo: 'AB',
        accountTo: String(10000000 + i),
        amount: BigInt(1000 + (i % 50) * 100),
        kSymbol: 'SIPO',
      })
      // Three recurring executions per order.
      for (let m = 0; m < 3; m++) {
        trans.push({
          transId: `${i}-${m}`,
          accountId,
          date: `1996-0${m + 1}-01`,
          type: 'VYDAJ',
          operation: 'PREVOD NA UCET',
          amount: BigInt(1000 + (i % 50) * 100),
          balance: 0n,
          kSymbol: 'SIPO',
          bank: 'AB',
          account: String(10000000 + i),
        })
      }
    }

    const ledger = ordersToLedger(orders)
    const bank = transToBank(trans)
    const truth = deriveBerkaTruth(orders, trans)

    const start = Date.now()
    const { results } = matchBerka(ledger, bank)
    const elapsed = Date.now() - start

    const report = scoreBerka(results, truth)
    expect(report.precision).toBe(1)
    expect(report.recall).toBe(1)
    // Not a hard perf assertion — just a guard against an accidental
    // quadratic-over-all-accounts regression creeping back in.
    expect(elapsed).toBeLessThan(5000)
  })
})
