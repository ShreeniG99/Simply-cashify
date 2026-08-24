/**
 * Engine result types.
 *
 * Nothing here may reference `lib/datasets/truth` — the pipeline works blind and
 * is scored afterwards. See `tests/truth-isolation.test.ts`.
 */

import type { CanonicalRecord } from '../datasets/canonical'

/** Which tier resolved a record. Ordered cheapest to most expensive. */
export type MatchTier = 'exact' | 'fuzzy' | 'assignment' | 'agent'

export const TIER_ORDER: MatchTier[] = ['exact', 'fuzzy', 'assignment', 'agent']

export type ExceptionReason =
  | 'orphan'
  | 'low_confidence'
  | 'ambiguous_multiple_candidates'
  | 'fee_math_break'
  | 'fx_unresolved'
  | 'duplicate_suspected'
  | 'invalid_bank_details'

/** A claim that a ledger invoice resolves to one or more settlement payments. */
export type ProposedMatch = {
  ledgerId: string
  /** More than one for a split settlement. */
  paymentIds: string[]
  tier: MatchTier
  /** 0..1. The auto-approval gate thresholds on this. */
  confidence: number
}

export type ReconExceptionRecord = {
  /** Whichever side the exception is anchored to. */
  ledgerId?: string
  paymentId?: string
  bankId?: string
  reason: ExceptionReason
  /**
   * Precise and technical — the exact candidate id, score, threshold, or paisa
   * delta involved. This is the audit trail: what the decision drawer and
   * Settlement Q&A show, because a controller re-checking a decision needs
   * the specific numbers, not a paraphrase.
   */
  detail: string
  /**
   * The same fact in a controller's own words — what the main exceptions
   * table shows. Optional because a few call sites (older tests, hand-built
   * fixtures) predate this field; `lib/copy/exceptions.ts` supplies a
   * reason-only fallback sentence when it's missing, so nothing renders
   * blank, but every real pipeline decision site fills it in.
   */
  controllerSummary?: string
  /** Populated when the agent tier looked at this and declined to match. */
  rationale?: string
}

/** Stage A: a bank credit tied out to a settlement batch. */
export type TieoutResult = {
  bankId: string
  settlementBatchId: string | null
  tier: MatchTier | null
  confidence: number
  /** Stage C: does gross − fees − tax ± refunds equal the credited amount? */
  feeMathOk: boolean
  /** Non-zero when Stage C fails; minor units. */
  feeMathDelta: bigint
}

/**
 * The audit trail entry for one decision. An unexplainable match is worthless to
 * a controller, so every claim carries how it was reached and what was rejected.
 */
export type DecisionRecord = {
  /** The record the decision is about (usually a ledger invoice id). */
  subjectId: string
  tier: MatchTier | 'exception'
  outcome: 'matched' | 'exception'
  confidence: number
  /** Signals that drove the decision, e.g. "reference exact", "amount within 0.0%". */
  evidence: string[]
  /** Tool calls made while deciding, in order. */
  toolsCalled: string[]
  /** Candidates considered and why they lost. */
  alternatives: { paymentIds: string[]; score: number; rejectedBecause: string }[]
  latencyMs: number
  /** Populated only for agent-tier decisions. */
  tokensUsed?: number
}

export type RunStats = {
  recordCount: number
  ledgerCount: number
  wallClockMs: number
  recordsPerSecond: number
  /** Fraction of ledger rows that reached the LLM tier. */
  llmTouchRate: number
  tokensUsed: number
  estimatedCostUsd: number
  latencyP50Ms: number
  latencyP95Ms: number
}

export type ReconcileResult = {
  datasetId: string
  matches: ProposedMatch[]
  exceptions: ReconExceptionRecord[]
  tieouts: TieoutResult[]
  decisions: DecisionRecord[]
  stats: RunStats
  /** Tier the agent stage ran in, so the UI can say "skipped" honestly. */
  agentTier: 'ran' | 'skipped_no_key' | 'skipped_disabled'
}

/** Groups settlement payment rows into their batches by `parentId`. */
export function groupByBatch(payments: CanonicalRecord[]): Map<string, CanonicalRecord[]> {
  const out = new Map<string, CanonicalRecord[]>()
  for (const p of payments) {
    const key = p.parentId ?? p.id
    const list = out.get(key)
    if (list) list.push(p)
    else out.set(key, [p])
  }
  return out
}
