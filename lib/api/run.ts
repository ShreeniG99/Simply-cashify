/**
 * Assembles a full run: generate → reconcile → score → ablate.
 *
 * Shared by the API route and the `bench` CLI so the dashboard and the
 * benchmark numbers can never drift apart.
 */

import { generate } from '../datasets/generate'
import { reconcile } from '../engine/pipeline'
import { score, type ScoreReport } from '../eval/score'
import { ABLATION_RUNGS } from '../engine/config'
import { formatMinor, type CanonicalRecord } from '../datasets/canonical'
import type { ReconcileResult } from '../engine/types'

export type AblationRow = {
  label: string
  precision: number
  recall: number
  f1: number
  autoClearRate: number
  falseExceptions: number
  wrongMatches: number
}

/** A payload safe to serialize: bigints become formatted strings. */
export type RunPayload = {
  runId: string
  seed: number
  datasetId: string
  createdAt: string
  report: ScoreReport
  ablation: AblationRow[]
  stats: ReconcileResult['stats']
  agentTier: ReconcileResult['agentTier']
  tierBreakdown: { tier: string; count: number }[]
  exceptions: {
    id: string
    reason: string
    detail: string
    rationale?: string
    side: 'ledger' | 'bank'
    record?: { id: string; date: string; amount: string; counterparty?: string; memo?: string }
  }[]
  matches: {
    ledgerId: string
    paymentIds: string[]
    tier: string
    confidence: number
    amount: string
    counterparty?: string
    autoCleared: boolean
  }[]
  decisions: ReconcileResult['decisions']
  /** The honest ceiling: what fraction of rows are matchable at all. */
  ceiling: number
}

export async function runReconciliation(
  opts: { seed?: number; invoiceCount?: number } = {},
): Promise<RunPayload> {
  const seed = opts.seed ?? Math.floor(Math.random() * 100000)
  const { batch, truth } = generate({ seed, invoiceCount: opts.invoiceCount })
  const result = await reconcile(batch)
  const report = score(result, truth)

  // Sequential, not Promise.all: the LLM-adjudication rung makes real API
  // calls when a key is configured, and running six rungs concurrently would
  // multiply concurrent Groq requests against a free tier limited to ~30 RPM.
  const ablation: AblationRow[] = []
  for (const rung of ABLATION_RUNGS) {
    const r = await reconcile(batch, { config: rung.overrides })
    const s = score(r, truth)
    ablation.push({
      label: rung.label,
      precision: s.operating.precision,
      recall: s.operating.recall,
      f1: s.operating.f1,
      autoClearRate: s.operating.autoClearRate,
      falseExceptions: s.operating.falseExceptions,
      wrongMatches: s.operating.wrongMatches,
    })
  }

  const ledgerById = new Map(batch.ledger.map((l) => [l.id, l]))
  const bankById = new Map(batch.bank.map((b) => [b.id, b]))
  const threshold = report.operating.threshold

  const tierCounts = new Map<string, number>()
  for (const m of result.matches) {
    tierCounts.set(m.tier, (tierCounts.get(m.tier) ?? 0) + 1)
  }
  tierCounts.set('unresolved', result.exceptions.length)

  return {
    runId: `run_${seed}_${Date.now()}`,
    seed,
    datasetId: batch.datasetId,
    createdAt: new Date().toISOString(),
    report,
    ablation,
    stats: result.stats,
    agentTier: result.agentTier,
    tierBreakdown: [...tierCounts].map(([tier, count]) => ({ tier, count })),
    exceptions: result.exceptions.map((e, i) => {
      const rec = e.ledgerId ? ledgerById.get(e.ledgerId) : bankById.get(e.bankId ?? '')
      return {
        id: e.ledgerId ?? e.bankId ?? `exc_${i}`,
        reason: e.reason,
        detail: e.detail,
        rationale: e.rationale,
        side: e.ledgerId ? ('ledger' as const) : ('bank' as const),
        record: rec ? summarize(rec) : undefined,
      }
    }),
    matches: result.matches.map((m) => {
      const rec = ledgerById.get(m.ledgerId)
      return {
        ledgerId: m.ledgerId,
        paymentIds: m.paymentIds,
        tier: m.tier,
        confidence: m.confidence,
        amount: rec ? formatMinor(rec.amount, rec.currency) : '—',
        counterparty: rec?.counterparty,
        autoCleared: m.confidence >= threshold,
      }
    }),
    decisions: result.decisions,
    ceiling: report.ledgerCount === 0 ? 0 : report.matchableCount / report.ledgerCount,
  }
}

function summarize(rec: CanonicalRecord) {
  return {
    id: rec.id,
    date: rec.date,
    amount: formatMinor(rec.amount, rec.currency),
    counterparty: rec.counterparty,
    memo: rec.memo,
  }
}
