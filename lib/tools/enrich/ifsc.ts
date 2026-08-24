/**
 * IFSC (bank branch code) lookup — Razorpay's own open, keyless, CORS-enabled
 * toolkit at ifsc.razorpay.com.
 *
 * Fixture honesty note: the six codes below are the ones the generator invents
 * (`lib/datasets/generate.ts`'s `IFSC_CODES`). The bank/branch/city values are
 * illustrative placeholders, not a verified copy of the live registry — this
 * build session cannot reach ifsc.razorpay.com to confirm them. Presenting
 * invented branch details as verified would be exactly the fabrication this
 * module exists to refuse, so `mode: 'fixture'` is always returned honestly
 * for these six, never upgraded to imply a real lookup happened. On an
 * unrestricted machine `preferLive: true` performs the real lookup.
 */

import { registerTool, type ToolResult } from '../registry'
import { attemptLive } from '../fixtures/cassette'

export type IfscInfo = { bank: string; branch: string; city: string }

/** Illustrative only — see the file-level note. Keyed on the generator's six codes. */
export const IFSC_FIXTURE: Record<string, IfscInfo> = {
  HDFC0000001: { bank: 'HDFC Bank', branch: 'Branch 0001 (fixture)', city: 'Mumbai' },
  ICIC0000123: { bank: 'ICICI Bank', branch: 'Branch 0123 (fixture)', city: 'Bengaluru' },
  SBIN0001234: { bank: 'State Bank of India', branch: 'Branch 1234 (fixture)', city: 'Delhi' },
  UTIB0000456: { bank: 'Axis Bank', branch: 'Branch 0456 (fixture)', city: 'Pune' },
  KKBK0000789: { bank: 'Kotak Mahindra Bank', branch: 'Branch 0789 (fixture)', city: 'Chennai' },
  YESB0000321: { bank: 'Yes Bank', branch: 'Branch 0321 (fixture)', city: 'Hyderabad' },
}

/** Same structural rule the matcher already uses (`lib/engine/strings.ts`). */
function isWellFormed(code: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code.toUpperCase())
}

type RazorpayIfscResponse = { BANK: string; BRANCH: string; CITY: string }

async function fetchLiveIfsc(code: string): Promise<IfscInfo> {
  const res = await fetch(`https://ifsc.razorpay.com/${code.toUpperCase()}`)
  if (!res.ok) throw new Error(`IFSC ${res.status}`)
  const body = (await res.json()) as RazorpayIfscResponse
  return { bank: body.BANK, branch: body.BRANCH, city: body.CITY }
}

export type IfscToolInput = { ifsc: string; preferLive?: boolean }

async function handleLookupIfsc(input: IfscToolInput): Promise<ToolResult<IfscInfo>> {
  const code = input.ifsc.toUpperCase()

  if (!isWellFormed(code)) {
    return { mode: 'fixture', data: null, reason: `${code} is not a structurally valid IFSC` }
  }

  if (input.preferLive) {
    const attempt = await attemptLive(() => fetchLiveIfsc(code))
    if (attempt.ok) return { mode: 'live', data: attempt.value }
    // Fall through to the fixture.
  }

  const fixture = IFSC_FIXTURE[code]
  if (!fixture) {
    return { mode: 'fixture', data: null, reason: `No fixture entry for ${code}` }
  }
  return { mode: 'fixture', data: fixture }
}

registerTool<IfscToolInput, IfscInfo>({
  name: 'bank.lookupIFSC',
  description:
    "Look up a bank branch by its IFSC code, to validate a counterparty's bank details.",
  schema: {
    type: 'object',
    required: ['ifsc'],
    properties: { ifsc: { type: 'string', description: 'e.g. HDFC0000001' } },
  },
  handler: handleLookupIfsc,
  status: async () => {
    const attempt = await attemptLive(() => fetchLiveIfsc('HDFC0000001'))
    return attempt.ok ? 'live' : 'fixture' // keyless: never unconfigured
  },
})
