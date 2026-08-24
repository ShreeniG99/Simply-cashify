/**
 * Adapts Razorpay's Settlements API response shape into `CanonicalRecord[]` —
 * proof that a genuinely external, differently-shaped source still only
 * needs one adapter file, same claim `lib/datasets/csvAdapter.ts` makes for
 * a hand-built CSV.
 *
 * The field shape below (`id`, `amount`, `fees`, `tax`, `utr`, `created_at`,
 * all minor-unit integers already, per Razorpay's own documented
 * convention) is written from Razorpay's public Settlements API
 * documentation, not verified against a live response — this build
 * environment's egress proxy blocks `api.razorpay.com` (confirmed, same
 * denial as every other external host this project touches; see DATA.md).
 * `lib/tools/actions/razorpay.ts` is honest about that: unlike the FX,
 * calendar, and IFSC connectors, this tool has no `fixture` mode at all,
 * because there is no immutable public fact to cache here — a settlement
 * batch is private, account-specific data, not a small closed reference set.
 * It reports only `live` (a real call succeeded) or `unconfigured` (no
 * credentials), never a fabricated stand-in for real settlement rows.
 */

import type { CanonicalRecord } from '../canonical'

export type RazorpaySettlement = {
  id: string
  entity: 'settlement'
  amount: number
  fees: number
  tax: number
  utr: string
  status: string
  created_at: number
}

function isoDateFromUnix(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

/**
 * Razorpay reports `amount`/`fees`/`tax` as integer paisa already — the same
 * minor-unit convention `CanonicalRecord.amount` uses, so this is a direct
 * `BigInt` mapping with no unit conversion, unlike the CSV adapter which
 * parses a decimal rupee string via `toMinor`.
 */
export function adaptRazorpaySettlements(rows: RazorpaySettlement[]): CanonicalRecord[] {
  return rows.map((row) => ({
    id: row.id,
    source: 'settlement' as const,
    date: isoDateFromUnix(row.created_at),
    amount: BigInt(Math.round(row.amount)),
    currency: 'INR',
    reference: row.utr || undefined,
    fees: BigInt(Math.round(row.fees)),
    tax: BigInt(Math.round(row.tax)),
    raw: row,
  }))
}
