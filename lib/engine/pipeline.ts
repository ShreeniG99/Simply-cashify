/**
 * The reconciliation pipeline.
 *
 * Runs the tiers cheapest-first so deterministic work handles the bulk and the
 * expensive tiers only ever see the residual. Every ledger row leaves with
 * either a claim or a typed exception, and a `DecisionRecord` explaining how it
 * got there — an unexplainable match is worthless to a controller.
 *
 * This module must NOT import `lib/datasets/truth`. It works blind; scoring
 * happens afterwards in `lib/eval`.
 */

import type { CanonicalBatch, CanonicalRecord } from '../datasets/canonical'
import { formatMinor, recordCount } from '../datasets/canonical'
import { DEFAULT_CONFIG, type MatchConfig } from './config'
import {
  assignmentMatch,
  buildCandidates,
  exactMatch,
  fuzzyMatch,
  splitMatch,
  type Candidate,
  type TierResult,
} from './match'
import { tieOut } from './tieout'
import { isValidIfsc } from './strings'
import { convertToInr } from '../tools/enrich/fx'
import { runAdjudication, type ResidualCase } from './adjudicate'
import { createGroqClientFromEnv } from '../llm/groq'
import type { LLMClient } from '../llm/client'
import type { OnProgress } from './progress'
import type {
  DecisionRecord,
  ExceptionReason,
  ProposedMatch,
  ReconExceptionRecord,
  ReconcileResult,
  MatchTier,
} from './types'

export type ReconcileOptions = {
  config?: Partial<MatchConfig>
  /** Injected for tests; production code omits this and reads GROQ_API_KEY. */
  llmClient?: LLMClient | null
  /** Optional live progress events — see lib/engine/progress.ts. Never required for correctness. */
  onProgress?: OnProgress
}

export async function reconcile(
  batch: CanonicalBatch,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const cfg: MatchConfig = { ...DEFAULT_CONFIG, ...opts.config }
  const onProgress = opts.onProgress
  const started = Date.now()

  // ---- Tier 0: normalize to the base currency at each record's own date ----
  onProgress?.({ kind: 'tier', tier: 'normalize', label: 'Tier 0 — normalizing currencies to a common base' })
  const unresolvedFx = new Set<string>()
  const ledger = batch.ledger.map((rec) => normalize(rec, batch.baseCurrency, cfg, unresolvedFx))
  const payments = batch.settlements.map((rec) =>
    normalize(rec, batch.baseCurrency, cfg, unresolvedFx),
  )

  // ---- Stage A + C: tie bank credits to batches and verify the arithmetic ----
  onProgress?.({ kind: 'tier', tier: 'tieout', label: 'Stage A — tying bank credits to settlement batches' })
  const tieouts = tieOut(batch.bank, payments, cfg)

  // ---- Stage B: tiers 1-2 over ledger x payments ----
  const candidates = buildCandidates(ledger, payments, cfg)
  const byLedger = groupCandidates(candidates)

  onProgress?.({ kind: 'tier', tier: 'exact', label: 'Tier 1 — exact match by identifier and amount' })
  const tier1 = exactMatch(candidates)

  // Tier 3 REPLACES tier 2's greedy resolution rather than running after it.
  // Greedy consumes both sides of every pair it takes, so anything it got wrong
  // would already be locked in and the solver could not undo it — the ablation
  // row would then measure nothing at all.
  const contestedTier: MatchTier = cfg.enableAssignment ? 'assignment' : 'fuzzy'
  onProgress?.({
    kind: 'tier',
    tier: contestedTier,
    label: cfg.enableAssignment
      ? 'Tier 3 — optimal assignment over the contested residual'
      : 'Tier 2 — fuzzy match over the contested residual',
  })
  const contested = cfg.enableAssignment
    ? assignmentMatch(candidates, tier1, cfg)
    : fuzzyMatch(candidates, tier1, cfg)

  const merged: TierResult = {
    matches: [...tier1.matches, ...contested.matches],
    consumedLedger: contested.consumedLedger,
    consumedPayments: contested.consumedPayments,
  }
  onProgress?.({ kind: 'tier', tier: 'splits', label: 'Checking split settlements — one invoice, several payments' })
  const splits = splitMatch(ledger, payments, merged, cfg)

  const matches: ProposedMatch[] = [
    ...tier1.matches.map((m) => toProposed(m, 'exact')),
    ...contested.matches.map((m) => toProposed(m, contestedTier)),
    ...splits.matches.map((m) => toProposed(m, 'fuzzy')),
  ]

  const decisions: DecisionRecord[] = []
  const evidenceByLedger = new Map<string, string[]>()
  for (const m of [...tier1.matches, ...contested.matches, ...splits.matches]) {
    evidenceByLedger.set(m.ledgerId, m.evidence)
  }

  for (const m of matches) {
    decisions.push({
      subjectId: m.ledgerId,
      tier: m.tier,
      outcome: 'matched',
      confidence: m.confidence,
      evidence: evidenceByLedger.get(m.ledgerId) ?? [],
      toolsCalled: toolsFor(m.ledgerId, ledger, cfg),
      alternatives: alternativesFor(m, byLedger.get(m.ledgerId) ?? []),
      latencyMs: 0,
    })
  }

  // ---- Tier 4: LLM adjudication over whatever tiers 1-3 could not resolve ----
  const matchedLedger = new Set(matches.map((m) => m.ledgerId))
  const exceptions: ReconExceptionRecord[] = []
  const agentExceptionIds = new Set<string>()

  const llmClient = opts.llmClient !== undefined ? opts.llmClient : cfg.enableAgent ? createGroqClientFromEnv() : null
  const agentTier: ReconcileResult['agentTier'] = !cfg.enableAgent
    ? 'skipped_disabled'
    : llmClient
      ? 'ran'
      : 'skipped_no_key'

  let agentTokens = 0
  let agentCostUsd = 0
  let agentLatencies: number[] = []

  if (agentTier === 'ran' && llmClient) {
    const residuals: ResidualCase[] = ledger
      .filter((l) => !matchedLedger.has(l.id))
      .map((l) => ({
        ledger: l,
        candidates: (byLedger.get(l.id) ?? []).slice().sort((a, b) => b.confidence - a.confidence),
      }))

    onProgress?.({ kind: 'tier', tier: 'agent', label: 'Tier 4 — LLM adjudication over the genuine residual' })
    const summary = await runAdjudication(residuals, payments, llmClient, cfg, onProgress)
    agentTokens = summary.totalTokens
    agentCostUsd = summary.estimatedCostUsd
    agentLatencies = summary.latencies

    for (const r of summary.results) {
      if (r.outcome === 'not_reached') continue

      if (r.outcome === 'matched') {
        matches.push({ ledgerId: r.ledgerId, paymentIds: [r.paymentId], tier: 'agent', confidence: r.confidence })
        matchedLedger.add(r.ledgerId)
        decisions.push({
          subjectId: r.ledgerId,
          tier: 'agent',
          outcome: 'matched',
          confidence: r.confidence,
          evidence: [r.rationale],
          toolsCalled: r.toolsCalled,
          alternatives: [],
          latencyMs: r.latencyMs,
          tokensUsed: r.tokensUsed,
        })
      } else {
        agentExceptionIds.add(r.ledgerId)
        // The agent's rationale is already prompted to be "one or two sentences a
        // controller could audit" (see adjudicate.ts's FLAG_EXCEPTION schema), so
        // unlike the deterministic tiers it doubles as its own controller summary
        // rather than needing a separate technical-vs-plain-language split.
        exceptions.push({
          ledgerId: r.ledgerId,
          reason: r.reason,
          detail: r.rationale,
          controllerSummary: r.rationale,
          rationale: r.rationale,
        })
        decisions.push({
          subjectId: r.ledgerId,
          tier: 'exception',
          outcome: 'exception',
          confidence: 0,
          evidence: [r.rationale],
          toolsCalled: r.toolsCalled,
          alternatives: [],
          latencyMs: r.latencyMs,
          tokensUsed: r.tokensUsed,
        })
      }
    }
  }

  // ---- Exceptions: everything tiers 1-4 could not resolve ----
  onProgress?.({ kind: 'tier', tier: 'exceptions', label: 'Classifying the remaining residual with a typed reason' })
  // Which ledger row actually claimed each payment, so a candidate that scored
  // WELL can be explained honestly ("already matched to INV-2090") instead of
  // the blanket "below accept threshold" claim, which is false whenever the
  // candidate's own score clears the threshold — see rejectedBecauseFor below.
  const claimedBy = new Map<string, string>()
  for (const m of matches) {
    for (const paymentId of m.paymentIds) claimedBy.set(paymentId, m.ledgerId)
  }

  for (const l of ledger) {
    if (matchedLedger.has(l.id) || agentExceptionIds.has(l.id)) continue
    const cands = (byLedger.get(l.id) ?? []).sort((a, b) => b.confidence - a.confidence)
    const { reason, detail, controllerSummary } = classifyException(l, cands, ledger, matchedLedger, unresolvedFx, cfg)

    exceptions.push({ ledgerId: l.id, reason, detail, controllerSummary })
    decisions.push({
      subjectId: l.id,
      tier: 'exception',
      outcome: 'exception',
      confidence: cands[0]?.confidence ?? 0,
      evidence: cands[0]?.evidence ?? ['no candidate above the noise floor'],
      toolsCalled: toolsFor(l.id, ledger, cfg),
      alternatives: (cands.slice(0, 3) ?? []).map((c) => ({
        paymentIds: [c.payment.id],
        score: round(c.confidence),
        rejectedBecause: rejectedBecauseFor(c, cfg, claimedBy, reason),
      })),
      latencyMs: 0,
    })
  }

  // Stage A orphans and Stage C breaks are exceptions in their own right.
  for (const t of tieouts) {
    if (t.settlementBatchId === null) {
      exceptions.push({
        bankId: t.bankId,
        reason: 'orphan',
        detail: 'Bank credit has no corresponding settlement batch',
        controllerSummary:
          "This bank credit doesn't tie back to any settlement batch we have on file — check for a UTR mismatch, or a settlement report we haven't received yet.",
      })
    } else if (!t.feeMathOk) {
      const overShort = t.feeMathDelta > 0n ? 'short by' : 'over by'
      exceptions.push({
        bankId: t.bankId,
        reason: 'fee_math_break',
        detail: `gross − fees − tax ± refunds differs from the credit by ${t.feeMathDelta} paisa`,
        controllerSummary: `The settlement math doesn't add up — what landed in the bank is ${overShort} ${formatMinor(t.feeMathDelta < 0n ? -t.feeMathDelta : t.feeMathDelta)} versus gross minus fees and tax. Worth flagging to the payment processor.`,
      })
    }
  }

  const wallClockMs = Date.now() - started
  const total = recordCount(batch)

  return {
    datasetId: batch.datasetId,
    matches,
    exceptions,
    tieouts,
    decisions,
    agentTier,
    stats: {
      recordCount: total,
      ledgerCount: ledger.length,
      wallClockMs,
      recordsPerSecond: wallClockMs === 0 ? total * 1000 : Math.round((total / wallClockMs) * 1000),
      llmTouchRate: ledger.length === 0 ? 0 : agentLatencies.length / ledger.length,
      tokensUsed: agentTokens,
      estimatedCostUsd: agentCostUsd,
      latencyP50Ms: percentile(agentLatencies, 50),
      latencyP95Ms: percentile(agentLatencies, 95),
    },
  }
}

/** Nearest-rank percentile over an unsorted array. Empty input -> 0, never NaN. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// ------------------------------------------------------------------ helpers

function normalize(
  rec: CanonicalRecord,
  base: string,
  cfg: MatchConfig,
  unresolved: Set<string>,
): CanonicalRecord {
  if (rec.currency === base) return rec

  if (!cfg.enableFx) {
    // FX disabled for this ablation rung: leave the amount alone and record that
    // it could not be compared, rather than pretending the figures are alike.
    unresolved.add(rec.id)
    return rec
  }

  const converted = convertToInr(rec.amount, rec.currency, rec.date)
  if (!converted.resolved) {
    unresolved.add(rec.id)
    return rec
  }
  return { ...rec, amount: converted.amount, currency: base }
}

function groupCandidates(candidates: Candidate[]): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const list = out.get(c.ledger.id)
    if (list) list.push(c)
    else out.set(c.ledger.id, [c])
  }
  return out
}

function toProposed(
  m: { ledgerId: string; paymentIds: string[]; confidence: number },
  tier: MatchTier,
): ProposedMatch {
  return { ledgerId: m.ledgerId, paymentIds: m.paymentIds, tier, confidence: m.confidence }
}

function toolsFor(ledgerId: string, ledger: CanonicalRecord[], cfg: MatchConfig): string[] {
  const rec = ledger.find((l) => l.id === ledgerId)
  const tools: string[] = []
  if (cfg.enableFx && rec && rec.currency !== 'INR') tools.push('fx.convert')
  if (cfg.enableHolidayAwareness) tools.push('calendar.isBusinessDay')
  return tools
}

/**
 * Why a candidate wasn't used for an exception row — honestly, not by rote.
 *
 * The naive version of this ("confidence X below accept threshold Y") is
 * only true for the `low_confidence` exception class. Applying it to every
 * exception unconditionally produces a self-contradiction the moment a
 * candidate scores WELL: a duplicate ledger row's best candidate can score a
 * perfect 1.0 against the payment its twin already claimed, and "1 is below
 * 0.72" is simply false. Real fix is to check what's actually true of this
 * candidate before writing the sentence, not to reuse one sentence for every
 * exception reason.
 */
function rejectedBecauseFor(
  c: Candidate,
  cfg: MatchConfig,
  claimedBy: Map<string, string>,
  reason: ExceptionReason,
): string {
  if (c.confidence < cfg.fuzzyAcceptThreshold) {
    return `confidence ${round(c.confidence)} below accept threshold ${cfg.fuzzyAcceptThreshold}`
  }
  const claimant = claimedBy.get(c.payment.id)
  if (claimant) {
    return `already matched to ${claimant}, which scored higher or was resolved first`
  }
  // The candidate itself clears the threshold and nothing else claimed it —
  // this row was excluded for a reason that has nothing to do with candidate
  // scoring at all (e.g. this exact ledger row is itself the duplicate, or
  // carries an invalid IFSC). Name that reason rather than blaming the score.
  return `scored ${round(c.confidence)}, above threshold — not used because this invoice was flagged as ${reason.replace(/_/g, ' ')}`
}

function alternativesFor(m: ProposedMatch, cands: Candidate[]) {
  return cands
    .filter((c) => !m.paymentIds.includes(c.payment.id))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((c) => ({
      paymentIds: [c.payment.id],
      score: round(c.confidence),
      rejectedBecause: `scored ${round(c.confidence)} against the winner's ${round(m.confidence)}`,
    }))
}

/**
 * Give the exception a typed reason. The order matters: the most specific
 * explanation wins, so a controller reads "this IFSC is malformed" rather than
 * the useless "no match found".
 */
function classifyException(
  l: CanonicalRecord,
  cands: Candidate[],
  allLedger: CanonicalRecord[],
  matchedLedger: Set<string>,
  unresolvedFx: Set<string>,
  cfg: MatchConfig,
): { reason: ExceptionReason; detail: string; controllerSummary: string } {
  if (unresolvedFx.has(l.id)) {
    return {
      reason: 'fx_unresolved',
      detail: cfg.enableFx
        ? `No rate available for ${l.currency} on ${l.date}`
        : `Invoice raised in ${l.currency}; FX normalization is disabled`,
      controllerSummary: cfg.enableFx
        ? `We don't have an exchange rate for ${l.currency} on ${l.date}, so this couldn't be compared to the settlement.`
        : `This invoice was raised in ${l.currency}, but currency conversion is off for this run, so it couldn't be compared.`,
    }
  }

  if (l.ifsc && !isValidIfsc(l.ifsc)) {
    return {
      reason: 'invalid_bank_details',
      detail: `IFSC ${l.ifsc} is not a valid branch code`,
      controllerSummary: `The IFSC on file, ${l.ifsc}, isn't a valid branch code — worth confirming the counterparty's bank details before this goes any further.`,
    }
  }

  // A second ledger row carrying the same reference and amount as one already
  // matched is a double entry, not a missing payment.
  const twin = allLedger.find(
    (o) =>
      o.id !== l.id &&
      o.reference === l.reference &&
      o.amount === l.amount &&
      matchedLedger.has(o.id),
  )
  if (twin) {
    return {
      reason: 'duplicate_suspected',
      detail: `Appears to duplicate ${twin.id}, which is already settled`,
      controllerSummary: `This looks like a repeat of ${twin.id}, which is already settled — probably a duplicate entry rather than a separate payment.`,
    }
  }

  if (cands.length >= 2) {
    const [first, second] = cands
    if (first.confidence - second.confidence < 0.05 && first.confidence > 0.5) {
      return {
        reason: 'ambiguous_multiple_candidates',
        detail: `${cands.length} candidates within 5% confidence; top two are ${first.payment.id} and ${second.payment.id}`,
        controllerSummary: `${cands.length} settlement payments are equally plausible here — ${first.payment.id} and ${second.payment.id} are the closest two. Needs a human to pick.`,
      }
    }
  }

  if (cands.length > 0 && cands[0].confidence > 0.3) {
    return {
      reason: 'low_confidence',
      detail: `Best candidate ${cands[0].payment.id} scored ${round(cands[0].confidence)}, below the ${cfg.fuzzyAcceptThreshold} threshold`,
      controllerSummary: `The closest candidate, ${cands[0].payment.id}, falls short of our auto-approval bar — worth a second look before confirming.`,
    }
  }

  return {
    reason: 'orphan',
    detail: 'No settlement payment corresponds to this invoice',
    controllerSummary: 'Nothing on the settlement side lines up with this invoice at all — likely still outstanding, or paid outside this batch.',
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
