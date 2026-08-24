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
import { buildCashForecast } from '../forecast/cash'
import { IN_FIXED_HOLIDAYS_2026 } from '../util/dates'
import { notifySlack } from '../tools/actions/slack'
import { controllerCopy } from '../copy/exceptions'
import type { OnProgress } from '../engine/progress'

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
    controllerSummary: string
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
  cashForecast: {
    asOf: string
    collectionLagDays: number
    lagSampleSize: number
    confirmedMinor: string
    openReceivablesMinor: string
    weeks: {
      weekIndex: number
      weekStart: string
      confirmed: string
      projected: string
      cumulative: string
      bandLow: string
      bandHigh: string
      /** Major-unit numbers (rupees, not paisa) for charting — display uses the formatted strings above. */
      confirmedValue: number
      projectedValue: number
      cumulativeValue: number
      bandLowValue: number
      bandHighValue: number
    }[]
  }
}

export async function runReconciliation(
  opts: { seed?: number; invoiceCount?: number } = {},
  onProgress?: OnProgress,
): Promise<RunPayload> {
  const seed = opts.seed ?? Math.floor(Math.random() * 100000)
  onProgress?.({ kind: 'phase', label: 'Generating the batch' })
  const { batch, truth } = generate({ seed, invoiceCount: opts.invoiceCount })

  onProgress?.({ kind: 'phase', label: 'Reconciling the primary run' })
  const result = await reconcile(batch, { onProgress })
  const report = score(result, truth)

  // Sequential, not Promise.all: the LLM-adjudication rung makes real API
  // calls when a key is configured, and running six rungs concurrently would
  // multiply concurrent Groq requests against a free tier limited to ~30 RPM.
  // Sequential execution is also what makes this loop the genuinely visible
  // part of a run — six real passes over the same batch, not a simulated wait.
  onProgress?.({ kind: 'phase', label: `Running the ablation sweep — ${ABLATION_RUNGS.length} configurations` })
  const ablation: AblationRow[] = []
  for (let i = 0; i < ABLATION_RUNGS.length; i++) {
    const rung = ABLATION_RUNGS[i]
    onProgress?.({
      kind: 'phase',
      label: `Ablation ${i + 1}/${ABLATION_RUNGS.length} — ${rung.label}`,
    })
    // Tier-level events aren't forwarded here: the main run above already
    // shows the full tier breakdown, and surfacing it six more times for each
    // ablation rung would bury the one signal that actually matters at this
    // point — which rung is running now.
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
  onProgress?.({ kind: 'phase', label: 'Scoring and assembling the run' })

  const ledgerById = new Map(batch.ledger.map((l) => [l.id, l]))
  const bankById = new Map(batch.bank.map((b) => [b.id, b]))
  const threshold = report.operating.threshold

  const tierCounts = new Map<string, number>()
  for (const m of result.matches) {
    tierCounts.set(m.tier, (tierCounts.get(m.tier) ?? 0) + 1)
  }
  tierCounts.set('unresolved', result.exceptions.length)

  const payload: RunPayload = {
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
        controllerSummary: controllerCopy(e),
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
    cashForecast: (() => {
      const forecast = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
      const c = batch.baseCurrency
      return {
        asOf: forecast.asOf,
        collectionLagDays: forecast.collectionLagDays,
        lagSampleSize: forecast.lagSampleSize,
        confirmedMinor: formatMinor(forecast.confirmedMinor, c),
        openReceivablesMinor: formatMinor(forecast.openReceivablesMinor, c),
        weeks: forecast.weeks.map((w) => ({
          weekIndex: w.weekIndex,
          weekStart: w.weekStart,
          confirmed: formatMinor(w.confirmedMinor, c),
          projected: formatMinor(w.projectedMinor, c),
          cumulative: formatMinor(w.cumulativeMinor, c),
          bandLow: formatMinor(w.bandLowMinor, c),
          bandHigh: formatMinor(w.bandHighMinor, c),
          confirmedValue: Number(w.confirmedMinor) / 100,
          projectedValue: Number(w.projectedMinor) / 100,
          cumulativeValue: Number(w.cumulativeMinor) / 100,
          bandLowValue: Number(w.bandLowMinor) / 100,
          bandHighValue: Number(w.bandHighMinor) / 100,
        })),
      }
    })(),
  }

  // Fire-and-forget: notifySlack() itself never throws (see lib/tools/actions/slack.ts)
  // and no-ops silently when SLACK_WEBHOOK_URL isn't set, so this never affects the run.
  await notifySlack(
    `Simply Cashify run ${payload.runId}: auto-cleared ${(report.operating.autoClearRate * 100).toFixed(1)}% ` +
      `at ${(report.operating.precision * 100).toFixed(1)}% precision, ${payload.exceptions.length} exceptions routed for review.`,
  )

  return payload
}

/**
 * An uploaded batch carries no ground truth — there is no answer key to
 * score matches against, so this payload reports what the engine decided
 * (matches, exceptions, tiers, the full audit trail, a cash forecast) and
 * deliberately has no `report`, `ablation`, or `ceiling` field. Fabricating
 * a precision number against an unknown answer would be exactly the kind of
 * claim this project refuses to make elsewhere.
 */
export type UploadRunPayload = {
  runId: string
  datasetId: string
  createdAt: string
  recordCounts: { bank: number; settlements: number; ledger: number }
  stats: ReconcileResult['stats']
  agentTier: ReconcileResult['agentTier']
  tierBreakdown: { tier: string; count: number }[]
  exceptions: RunPayload['exceptions']
  matches: { ledgerId: string; paymentIds: string[]; tier: string; confidence: number; amount: string; counterparty?: string }[]
  decisions: ReconcileResult['decisions']
  cashForecast: RunPayload['cashForecast']
}

export async function runReconciliationFromBatch(
  batch: import('../datasets/canonical').CanonicalBatch,
): Promise<UploadRunPayload> {
  const result = await reconcile(batch)

  const ledgerById = new Map(batch.ledger.map((l) => [l.id, l]))
  const bankById = new Map(batch.bank.map((b) => [b.id, b]))

  const tierCounts = new Map<string, number>()
  for (const m of result.matches) {
    tierCounts.set(m.tier, (tierCounts.get(m.tier) ?? 0) + 1)
  }
  tierCounts.set('unresolved', result.exceptions.length)

  const forecast = buildCashForecast(batch, result, IN_FIXED_HOLIDAYS_2026)
  const c = batch.baseCurrency

  await notifySlack(
    `Simply Cashify: uploaded batch reconciled — ${result.matches.length} matched, ` +
      `${result.exceptions.length} exceptions routed for review.`,
  )

  return {
    runId: `upload_${Date.now()}`,
    datasetId: batch.datasetId,
    createdAt: new Date().toISOString(),
    recordCounts: {
      bank: batch.bank.length,
      settlements: batch.settlements.length,
      ledger: batch.ledger.length,
    },
    stats: result.stats,
    agentTier: result.agentTier,
    tierBreakdown: [...tierCounts].map(([tier, count]) => ({ tier, count })),
    exceptions: result.exceptions.map((e, i) => {
      const rec = e.ledgerId ? ledgerById.get(e.ledgerId) : bankById.get(e.bankId ?? '')
      return {
        id: e.ledgerId ?? e.bankId ?? `exc_${i}`,
        reason: e.reason,
        detail: e.detail,
        controllerSummary: controllerCopy(e),
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
      }
    }),
    decisions: result.decisions,
    cashForecast: {
      asOf: forecast.asOf,
      collectionLagDays: forecast.collectionLagDays,
      lagSampleSize: forecast.lagSampleSize,
      confirmedMinor: formatMinor(forecast.confirmedMinor, c),
      openReceivablesMinor: formatMinor(forecast.openReceivablesMinor, c),
      weeks: forecast.weeks.map((w) => ({
        weekIndex: w.weekIndex,
        weekStart: w.weekStart,
        confirmed: formatMinor(w.confirmedMinor, c),
        projected: formatMinor(w.projectedMinor, c),
        cumulative: formatMinor(w.cumulativeMinor, c),
        bandLow: formatMinor(w.bandLowMinor, c),
        bandHigh: formatMinor(w.bandHighMinor, c),
        confirmedValue: Number(w.confirmedMinor) / 100,
        projectedValue: Number(w.projectedMinor) / 100,
        cumulativeValue: Number(w.cumulativeMinor) / 100,
        bandLowValue: Number(w.bandLowMinor) / 100,
        bandHighValue: Number(w.bandHighMinor) / 100,
      })),
    },
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
