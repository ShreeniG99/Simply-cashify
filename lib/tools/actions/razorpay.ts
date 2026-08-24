/**
 * `razorpay.settlements.list` — pulls real test-mode settlement batches from
 * Razorpay's own Settlements API, the source the plan calls out explicitly
 * since this is Razorpay's own hackathon.
 *
 * Same two-mode shape as `slack.notify` and for the same reason: a
 * settlement batch is private, account-specific data, so there is nothing
 * honest to cache as a `fixture` — either a real account is configured and
 * the call is genuinely `live`, or it is `unconfigured`. See
 * `lib/datasets/razorpay/adapter.ts` for the field-shape caveat: written
 * from Razorpay's published API docs, never verified against a live
 * response, because `api.razorpay.com` is unreachable from every build
 * session this project has run in (confirmed, same denial as every other
 * external host; see DATA.md).
 */

import { registerTool, type ToolResult } from '../registry'
import { attemptLive } from '../fixtures/cassette'
import { adaptRazorpaySettlements, type RazorpaySettlement } from '../../datasets/razorpay/adapter'
import type { CanonicalRecord } from '../../datasets/canonical'

type RazorpaySettlementsResponse = { entity: 'collection'; count: number; items: RazorpaySettlement[] }

async function fetchLiveSettlements(keyId: string, keySecret: string, count: number): Promise<RazorpaySettlement[]> {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64')
  const res = await fetch(`https://api.razorpay.com/v1/settlements?count=${count}`, {
    headers: { Authorization: `Basic ${auth}` },
  })
  if (!res.ok) throw new Error(`Razorpay Settlements API ${res.status}`)
  const body = (await res.json()) as RazorpaySettlementsResponse
  return body.items
}

export type RazorpaySettlementsInput = { count?: number }
export type RazorpaySettlementsOutput = { records: CanonicalRecord[] }

async function handleListSettlements(
  input: RazorpaySettlementsInput,
): Promise<ToolResult<RazorpaySettlementsOutput>> {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET
  if (!keyId || !keySecret) {
    return { mode: 'unconfigured', data: null, reason: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set' }
  }

  const count = Math.min(Math.max(input.count ?? 20, 1), 100)
  const attempt = await attemptLive(() => fetchLiveSettlements(keyId, keySecret, count))
  if (!attempt.ok) {
    return { mode: 'live', data: null, reason: attempt.error }
  }
  return { mode: 'live', data: { records: adaptRazorpaySettlements(attempt.value) } }
}

registerTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>({
  name: 'razorpay.settlements.list',
  description:
    "List the authenticated account's real Razorpay settlement batches (test mode), adapted to the canonical schema.",
  schema: {
    type: 'object',
    required: [],
    properties: { count: { type: 'number', description: 'Max batches to fetch, 1-100. Default 20.' } },
  },
  requiredEnv: 'RAZORPAY_KEY_ID',
  handler: handleListSettlements,
  // Same semantics as slack.notify's status(), for the same structural
  // reason: there is no `fixture` mode here to distinguish `live` from, so
  // (unlike FX/calendar/IFSC, where a real probe answers "reached the host
  // or fell back to the cassette") `live` just means "configured for live
  // use" — whether any individual call succeeds is the handler's concern,
  // reported per-call via `reason`, not something status() re-verifies.
  status: async () =>
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? 'live' : 'unconfigured',
})
