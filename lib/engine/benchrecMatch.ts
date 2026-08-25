/**
 * Matches BenchRec B (external statement) rows to A (internal ledger) rows.
 *
 * Deliberately NOT routed through `lib/engine/pipeline.ts`: that pipeline's
 * Stage A/C exist to tie a bank credit to a settlement batch and verify fee
 * arithmetic, neither of which BenchRec has (it is a pure two-way
 * reconciliation, no batch layer). This module exercises only Stage B —
 * candidate matching, tiers 1-3 — via the exact same `scoreCandidate`,
 * `exactMatch`, `fuzzyMatch`, and `assignmentMatch` functions the generator
 * and Berka paths use. Tier 4 (LLM adjudication) and `splitMatch` are not
 * run here: splitMatch's own "related" search is itself an unblocked
 * O(ledger×settlement) scan gated only by an identifier hit, and this
 * dataset's anonymized free text carries none of the UTR/invoice-ref shapes
 * `lib/engine/strings.ts` looks for — so it would cost real time to find
 * nothing, not a shortcut, an honestly-skipped stage.
 *
 * Tractability, the real reason this file exists rather than reusing
 * `buildCandidates` directly: unlike Berka, BenchRec holds everything in a
 * single account (`ACC#00001`), so there is no natural partition key to cut
 * the ~37K x ~32K cross product down. Two techniques instead:
 *
 * 1. Amount-window blocking — sort settlements by amount, binary-search each
 *    ledger row's tolerance window (`amountTolerancePct`, gated the same way
 *    `buildCandidates` gates it) instead of scanning every settlement.
 * 2. Connected-component partitioning before the O(n²m) Hungarian solver
 *    (`solveMaxScore`) runs — candidates naturally decompose into disjoint
 *    ledger/payment clusters, and solving each cluster separately gives the
 *    IDENTICAL result to solving the whole graph at once (disconnected
 *    components cannot influence each other's optimum), just without paying
 *    for one enormous matrix. A defensive cap on any single cluster's size
 *    falls back to greedy for that one cluster only — the same trade-off a
 *    real reconciliation system makes on a pathological cluster of
 *    identical round amounts, not a change to the matching logic itself.
 */

import type { CanonicalRecord } from '../datasets/canonical'
import { DEFAULT_CONFIG, type MatchConfig } from './config'
import { scoreCandidate, exactMatch, fuzzyMatch, assignmentMatch, type Candidate, type TierResult } from './match'

export type BenchRecMatchResult = {
  bId: string
  aId: string | null
  tier: 'exact' | 'fuzzy' | 'assignment' | null
  confidence: number
}

export type BenchRecMatchStats = {
  ledgerConsidered: number
  settlementsConsidered: number
  candidatesGenerated: number
  componentsSolved: number
  largestComponentSize: number
  /** Clusters too large for the O(n²m) solver, resolved greedily instead — see the module doc. */
  oversizedComponentsFellBackToGreedy: number
  /**
   * Confidence histogram over every generated candidate — cheap to compute
   * from data already in hand, and the honest explanation for a low recall
   * number if one shows up: it answers "were true matches scoring low, or
   * were they scoring close and just missing a threshold tuned for a
   * different dataset" without a second full run to find out.
   */
  confidenceHistogram: { bucket: string; count: number }[]
}

function histogramOf(candidates: Candidate[]): { bucket: string; count: number }[] {
  const edges: [number, number, string][] = [
    [0, 0.2, '0.0-0.2'],
    [0.2, 0.4, '0.2-0.4'],
    [0.4, 0.6, '0.4-0.6'],
    [0.6, 0.72, '0.6-0.72'],
    [0.72, 1.01, '0.72-1.0'],
  ]
  return edges.map(([lo, hi, bucket]) => ({
    bucket,
    count: candidates.filter((c) => c.confidence >= lo && c.confidence < hi).length,
  }))
}

/**
 * `IN_FIXED_HOLIDAYS_2026` and Razorpay's T+2 settlement window are specific
 * to the synthetic generator's world, not this 2015-2023 USD dataset — no
 * verified holiday calendar exists for whatever jurisdiction it represents,
 * so date scoring here uses plain calendar days, not business days.
 */
export const BENCHREC_CONFIG: MatchConfig = {
  ...DEFAULT_CONFIG,
  enableHolidayAwareness: false,
  enableFx: false, // single currency (USD) throughout — nothing to normalize
  // Measured directly against train.csv's labeled pairs, not assumed: of
  // 47,024 genuine 1:1 matches, 97.6% have an EXACT amount and 2.3% are
  // within 0.1% — the generator's 0.5% default is calibrated for Razorpay's
  // MDR/GST deductions, which this dataset has no equivalent of, and at
  // these dollar magnitudes (up to several billion) 0.5% blows the
  // amount-window blocking step up to millions of candidate pairs for no
  // matching benefit. 0.2% keeps real recall headroom above the measured
  // 0.1% band while staying tight enough to block efficiently.
  amountTolerancePct: 0.2,
}

/** Any single connected component larger than this falls back to greedy — see the module doc. */
const MAX_COMPONENT_FOR_ASSIGNMENT = 400

function lowerBound(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function buildBlockedCandidates(
  ledger: CanonicalRecord[],
  settlements: CanonicalRecord[],
  cfg: MatchConfig,
): Candidate[] {
  const sorted = [...settlements].sort((a, b) => Number(a.amount) - Number(b.amount))
  const amounts = sorted.map((s) => Number(s.amount))

  const out: Candidate[] = []
  for (const l of ledger) {
    const amt = Number(l.amount)
    const tol = Math.abs(amt) * (cfg.amountTolerancePct / 100)
    const lo = amt - tol
    const hi = amt + tol
    const start = lowerBound(amounts, lo)
    for (let i = start; i < amounts.length && amounts[i] <= hi; i++) {
      const c = scoreCandidate(l, sorted[i], cfg)
      // Same amount GATE buildCandidates uses — money has to genuinely agree.
      if (c.amountScore === 0) continue
      if (c.confidence > 0.2) out.push(c)
    }
  }
  return out
}

/** Union-find over ledger/payment ids, so disjoint candidate clusters can be solved independently. */
function connectedComponents(candidates: Candidate[]): Candidate[][] {
  const parent = new Map<string, string>()
  function find(x: string): string {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    while (parent.get(x) !== root) {
      const next = parent.get(x)!
      parent.set(x, root)
      x = next
    }
    return root
  }
  function union(a: string, b: string) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const c of candidates) {
    const lKey = `L:${c.ledger.id}`
    const pKey = `P:${c.payment.id}`
    if (!parent.has(lKey)) parent.set(lKey, lKey)
    if (!parent.has(pKey)) parent.set(pKey, pKey)
    union(lKey, pKey)
  }

  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const root = find(`L:${c.ledger.id}`)
    const list = groups.get(root)
    if (list) list.push(c)
    else groups.set(root, [c])
  }
  return [...groups.values()]
}

export function matchBenchRec(
  ledger: CanonicalRecord[],
  settlements: CanonicalRecord[],
  cfg: MatchConfig = BENCHREC_CONFIG,
): { results: BenchRecMatchResult[]; stats: BenchRecMatchStats } {
  const candidates = buildBlockedCandidates(ledger, settlements, cfg)
  const tier1 = exactMatch(candidates)

  const contested = candidates.filter(
    (c) => !tier1.consumedLedger.has(c.ledger.id) && !tier1.consumedPayments.has(c.payment.id),
  )
  const components = connectedComponents(contested)

  let largestComponentSize = 0
  let oversizedComponentsFellBackToGreedy = 0
  const contestedTier: 'assignment' | 'fuzzy' = cfg.enableAssignment ? 'assignment' : 'fuzzy'
  const contestedMatches: TierResult['matches'] = []

  for (const comp of components) {
    largestComponentSize = Math.max(largestComponentSize, comp.length)
    const empty: TierResult = { matches: [], consumedLedger: new Set(), consumedPayments: new Set() }

    const useGreedy = !cfg.enableAssignment || comp.length > MAX_COMPONENT_FOR_ASSIGNMENT
    if (useGreedy && cfg.enableAssignment) oversizedComponentsFellBackToGreedy++

    const result = useGreedy ? fuzzyMatch(comp, empty, cfg) : assignmentMatch(comp, empty, cfg)
    contestedMatches.push(...result.matches)
  }

  const byB = new Map<string, { aId: string; tier: 'exact' | 'assignment' | 'fuzzy'; confidence: number }>()
  for (const m of tier1.matches) byB.set(m.paymentIds[0], { aId: m.ledgerId, tier: 'exact', confidence: m.confidence })
  for (const m of contestedMatches) byB.set(m.paymentIds[0], { aId: m.ledgerId, tier: contestedTier, confidence: m.confidence })

  const results: BenchRecMatchResult[] = settlements.map((s) => {
    const hit = byB.get(s.id)
    return hit
      ? { bId: s.id, aId: hit.aId, tier: hit.tier, confidence: hit.confidence }
      : { bId: s.id, aId: null, tier: null, confidence: 0 }
  })

  return {
    results,
    stats: {
      ledgerConsidered: ledger.length,
      settlementsConsidered: settlements.length,
      candidatesGenerated: candidates.length,
      componentsSolved: components.length,
      largestComponentSize,
      oversizedComponentsFellBackToGreedy,
      confidenceHistogram: histogramOf(candidates),
    },
  }
}
