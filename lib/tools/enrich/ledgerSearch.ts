/**
 * `ledger.search` — the one investigation tool that is genuinely internal.
 *
 * Unlike FX/calendar/IFSC, this has no external service and no fixture: it
 * queries the actual records loaded for the current run. That also means it
 * cannot be a global singleton in `lib/tools/registry.ts` the way the other
 * three are — a batch-scoped tool re-registered under the same name on every
 * run would violate the registry's duplicate-name guard. So this is a
 * factory: `makeLedgerSearchTool(records)` builds a fresh, batch-scoped tool
 * each time `lib/engine/adjudicate.ts` needs one.
 *
 * Purpose: tiers 1-3 only ever show the agent candidates that already cleared
 * a 0.2 confidence floor (see `buildCandidates`). This tool lets the agent look
 * wider — "anything at all from this counterparty in that week" — for the case
 * where the real match scored too low to surface automatically.
 */

import type { CanonicalRecord } from '../../datasets/canonical'
import { formatMinor } from '../../datasets/canonical'
import type { LLMToolDef } from '../../llm/client'

export type LedgerSearchInput = {
  counterparty?: string
  afterDate?: string
  beforeDate?: string
  limit?: number
}

export type LedgerSearchHit = {
  id: string
  date: string
  amount: string
  counterparty?: string
  memo?: string
}

export const LEDGER_SEARCH_TOOL_DEF: LLMToolDef = {
  name: 'ledger.search',
  description:
    'Search the payment records for this batch by counterparty name (partial match) and/or date range. Use this when the pre-computed candidates look wrong or incomplete — it searches more broadly than the automatic candidate generation did.',
  parameters: {
    type: 'object',
    properties: {
      counterparty: { type: 'string', description: 'Partial, case-insensitive match.' },
      afterDate: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      beforeDate: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      limit: { type: 'number', description: 'Max results, default 10.' },
    },
  },
}

export function searchLedger(records: CanonicalRecord[], input: LedgerSearchInput): LedgerSearchHit[] {
  const limit = Math.min(input.limit ?? 10, 25)
  const needle = input.counterparty?.toLowerCase()

  return records
    .filter((r) => {
      if (needle && !r.counterparty?.toLowerCase().includes(needle)) return false
      if (input.afterDate && r.date < input.afterDate) return false
      if (input.beforeDate && r.date > input.beforeDate) return false
      return true
    })
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      date: r.date,
      amount: formatMinor(r.amount, r.currency),
      counterparty: r.counterparty,
      memo: r.memo,
    }))
}
