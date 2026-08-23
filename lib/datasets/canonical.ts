/**
 * The internal representation every data source adapts to.
 *
 * The matching engine only ever sees `CanonicalRecord[]` — it never knows
 * whether the rows came from the generator, BenchRec, Berka or an uploaded CSV.
 * Adding a dataset means writing one adapter, not touching the engine.
 */

export type SourceKind = 'bank' | 'settlement' | 'ledger'

export type CanonicalRecord = {
  /** Stable within a source for one run. */
  id: string
  source: SourceKind
  /** ISO 8601 date (YYYY-MM-DD). Value/posting date, not booking timestamp. */
  date: string
  /**
   * MINOR UNITS (paisa, cents) as a bigint — never a float.
   *
   * 0.1 + 0.2 !== 0.3 under IEEE-754. In reconciliation that surfaces as a
   * phantom ₹0.01 fee-math break that costs an evening to chase. Integer minor
   * units make exact arithmetic actually exact.
   *
   * Negative means money out (a refund adjustment).
   */
  amount: bigint
  /** ISO 4217, uppercase. */
  currency: string
  /** UTR / settlement_id / invoice number — whichever identifies this row. */
  reference?: string
  counterparty?: string
  /** Free text: bank narration, payment note. Often the only fuzzy signal. */
  memo?: string
  /** For a payment row: the settlement batch it belongs to. */
  parentId?: string
  /** Gateway fee (MDR), minor units, positive. Settlement rows only. */
  fees?: bigint
  /** Tax on the fee (GST on MDR), minor units, positive. Settlement rows only. */
  tax?: bigint
  /** IFSC of the counterparty bank, when known. */
  ifsc?: string
  /** The untouched source row, retained so the audit trail can show it. */
  raw: Record<string, unknown>
}

/** A batch as handed to the pipeline. Deliberately contains no ground truth. */
export type CanonicalBatch = {
  datasetId: string
  /** Currency all amounts are compared in after normalization. */
  baseCurrency: string
  bank: CanonicalRecord[]
  settlements: CanonicalRecord[]
  ledger: CanonicalRecord[]
}

export function recordCount(batch: CanonicalBatch): number {
  return batch.bank.length + batch.settlements.length + batch.ledger.length
}

/** Format minor units for display: 14646000n -> "1,46,460.00" (Indian grouping). */
export function formatMinor(amount: bigint, currency = 'INR'): string {
  const neg = amount < 0n
  const abs = neg ? -amount : amount
  const major = abs / 100n
  const minor = abs % 100n
  const grouped =
    currency === 'INR' ? groupIndian(major.toString()) : groupWestern(major.toString())
  return `${neg ? '-' : ''}${grouped}.${minor.toString().padStart(2, '0')}`
}

/** Indian digit grouping: last 3, then 2s. 15000000 -> 1,50,00,000 */
function groupIndian(s: string): string {
  if (s.length <= 3) return s
  const head = s.slice(0, -3)
  const tail = s.slice(-3)
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
}

function groupWestern(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Parse "1234.56" or "1234" into minor units without going through a float. */
export function toMinor(value: string | number): bigint {
  const s = typeof value === 'number' ? value.toFixed(2) : value.trim()
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [whole, frac = ''] = body.split('.')
  const cents = (frac + '00').slice(0, 2)
  const n = BigInt(whole || '0') * 100n + BigInt(cents || '0')
  return neg ? -n : n
}
