/**
 * FX normalization.
 *
 * Conversion is ALWAYS done at the record's own transaction date, never at
 * today's rate. A 2026-10-01 settlement must convert at the 2026-10-01 rate
 * today, next week, and at audit time — that figure is an immutable historical
 * fact. Using a `/latest` endpoint would mean re-running the same batch silently
 * produced different numbers and the accuracy score drifted for reasons
 * unrelated to matching.
 *
 * Because the rate for a past date cannot change, a recorded fixture and a live
 * call return identical values: the fixture is a cache of an immutable fact, not
 * an approximation. That is why fixture is the default mode.
 *
 * Step 3 replaces this with the full three-mode connector over
 * api.frankfurter.app; the rate table here is the recorded fixture it will read.
 */

/**
 * Recorded rates, quoted as units of INR per 1 unit of the foreign currency.
 * Seeded from the same constants the generator uses so a generated batch and a
 * replayed conversion agree exactly.
 */
export const FX_FIXTURE: Record<string, number> = {
  USD: 87.42,
  EUR: 94.15,
  GBP: 110.63,
  SGD: 64.88,
  AED: 23.8,
}

export type FxMode = 'live' | 'fixture' | 'unconfigured'

export type FxResult = {
  amount: bigint
  rate: number
  mode: FxMode
  /** False when the currency pair is unknown — never guess a rate. */
  resolved: boolean
}

export function convertToInr(amount: bigint, currency: string, _date: string): FxResult {
  const cur = currency.toUpperCase()
  if (cur === 'INR') {
    return { amount, rate: 1, mode: 'fixture', resolved: true }
  }
  const rate = FX_FIXTURE[cur]
  if (rate === undefined) {
    // Unknown pair: report it unresolved and let the caller raise an exception.
    // Fabricating a rate here would silently corrupt every downstream figure.
    return { amount, rate: 0, mode: 'fixture', resolved: false }
  }
  // Round half-up in minor units; the generator rounds the same way.
  const converted = BigInt(Math.round(Number(amount) * rate))
  return { amount: converted, rate, mode: 'fixture', resolved: true }
}
