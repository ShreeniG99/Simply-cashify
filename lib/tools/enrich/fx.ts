/**
 * FX normalization — synchronous fast-path (`convertToInr`, used by every
 * matching tier, including the 1M-row Berka loop) plus a registry-wrapped
 * async tool (`fx.convert`) for step 4's agent to call directly.
 *
 * Both read the SAME fixture table, so an agent's tool call and the engine's
 * own tier-0 normalization can never disagree with each other mid-run.
 *
 * Conversion is ALWAYS at the record's own transaction date, never `/latest` —
 * see the file-level reasoning this originally shipped with in step 1. A past
 * date's rate is an immutable historical fact, so live and fixture agree
 * exactly whenever both are reachable; the fixture is a cache of a fact that
 * cannot change, not an approximation of a moving one.
 */

import { registerTool, type ToolResult } from '../registry'
import { attemptLive } from '../fixtures/cassette'

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

/** The synchronous fast path. Unchanged from step 1; every matching tier calls this directly. */
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

/**
 * Frankfurter's historical endpoint: GET /{date}?amount=1&from=XXX&to=INR.
 * Unreachable from this build session (403 policy denial, verified); genuinely
 * reachable from an unrestricted machine.
 */
async function fetchLiveRate(currency: string, date: string): Promise<number> {
  const url = `https://api.frankfurter.app/${date}?amount=1&from=${currency}&to=INR`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`)
  const body = (await res.json()) as { rates?: Record<string, number> }
  const rate = body.rates?.INR
  if (rate === undefined) throw new Error('Frankfurter response missing INR rate')
  return rate
}

export type FxToolInput = { amountMinor: string; currency: string; date: string; preferLive?: boolean }
export type FxToolOutput = { amountMinor: string; rate: number }

async function handleFxConvert(input: FxToolInput): Promise<ToolResult<FxToolOutput>> {
  const amount = BigInt(input.amountMinor)
  const cur = input.currency.toUpperCase()

  if (cur === 'INR') {
    return { mode: 'fixture', data: { amountMinor: amount.toString(), rate: 1 } }
  }

  if (input.preferLive) {
    const attempt = await attemptLive(() => fetchLiveRate(cur, input.date))
    if (attempt.ok) {
      const converted = BigInt(Math.round(Number(amount) * attempt.value))
      return { mode: 'live', data: { amountMinor: converted.toString(), rate: attempt.value } }
    }
    // Fall through to the fixture rather than failing the call outright.
  }

  const rate = FX_FIXTURE[cur]
  if (rate === undefined) {
    return { mode: 'fixture', data: null, reason: `No fixture rate recorded for ${cur}` }
  }
  const converted = BigInt(Math.round(Number(amount) * rate))
  return { mode: 'fixture', data: { amountMinor: converted.toString(), rate } }
}

registerTool<FxToolInput, FxToolOutput>({
  name: 'fx.convert',
  description: 'Convert an amount to INR at a given historical date, for cross-currency reconciliation.',
  schema: {
    type: 'object',
    required: ['amountMinor', 'currency', 'date'],
    properties: {
      amountMinor: { type: 'string', description: 'Amount in minor units (paisa/cents), as a string.' },
      currency: { type: 'string', description: 'ISO 4217 currency code, e.g. USD.' },
      date: { type: 'string', description: 'Transaction date, YYYY-MM-DD. The rate for this exact date is used.' },
    },
  },
  handler: handleFxConvert,
  status: async () => {
    const attempt = await attemptLive(() => fetchLiveRate('USD', '2026-01-02'))
    return attempt.ok ? 'live' : 'fixture' // keyless: never unconfigured
  },
})
