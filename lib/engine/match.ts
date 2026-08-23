/**
 * Tier 1 (exact) and tier 2 (fuzzy) matching of ledger invoices to settlement
 * payments.
 *
 * Both tiers share candidate scoring; they differ in how much evidence they
 * demand. Tier 1 requires an identifier hit AND an exact amount — cheap and
 * effectively never wrong. Tier 2 combines string, amount and date signals into
 * a confidence and accepts above a threshold.
 *
 * Assignment here is deliberately GREEDY. Global optimal assignment is tier 3;
 * keeping greedy as the tier-2 behaviour is what lets the ablation table show a
 * genuine delta when tier 3 is switched on.
 */

import type { CanonicalRecord } from '../datasets/canonical'
import type { MatchConfig } from './config'
import { scoreStrings, type StringScore } from './strings'
import { solveMaxScore } from './assign'
import { businessDaysBetween, daysBetween } from '../util/dates'

export type Candidate = {
  ledger: CanonicalRecord
  payment: CanonicalRecord
  confidence: number
  strings: StringScore
  amountScore: number
  dateScore: number
  evidence: string[]
}

/** 1.0 when identical, decaying to 0 at the tolerance boundary. */
export function scoreAmount(
  ledgerAmount: bigint,
  paymentAmount: bigint,
  tolerancePct: number,
): { score: number; evidence: string } {
  if (ledgerAmount === paymentAmount) return { score: 1, evidence: 'amount exact' }
  const a = Number(ledgerAmount)
  const b = Number(paymentAmount)
  if (a === 0) return { score: 0, evidence: 'amount zero' }
  const diffPct = (Math.abs(a - b) / Math.abs(a)) * 100
  if (diffPct > tolerancePct) return { score: 0, evidence: `amount off ${diffPct.toFixed(2)}%` }
  return {
    score: 1 - diffPct / tolerancePct,
    evidence: `amount within ${diffPct.toFixed(2)}%`,
  }
}

/**
 * Score the settlement lag.
 *
 * With holiday awareness on, the gap is measured in business days so a
 * settlement delayed by a bank holiday still scores as on-time. With it off, the
 * same settlement looks late — which is exactly the false-exception class the
 * ablation row measures.
 */
export function scoreDate(
  ledgerDate: string,
  paymentDate: string,
  cfg: MatchConfig,
): { score: number; evidence: string } {
  const expected = cfg.settlementWindowBusinessDays
  const slack = cfg.dateToleranceBusinessDays

  const gap = cfg.enableHolidayAwareness
    ? businessDaysBetween(ledgerDate, paymentDate, cfg.holidays)
    : daysBetween(ledgerDate, paymentDate)

  if (gap < 0) return { score: 0, evidence: `settled ${-gap}d before invoice` }

  const unit = cfg.enableHolidayAwareness ? 'business days' : 'days'
  if (gap <= expected) return { score: 1, evidence: `settled T+${gap} ${unit}` }

  const over = gap - expected
  if (over <= slack) return { score: 0.85, evidence: `settled T+${gap} ${unit} (within slack)` }
  // Decay over roughly a working fortnight rather than cutting off hard.
  const score = Math.max(0, 1 - over / 10)
  return { score, evidence: `settled T+${gap} ${unit} (late)` }

  // NOTE: a peak-shaped score (decaying either side of T+2) was tried here on
  // the theory that a plateau throws away information and leaves timing unable
  // to separate two same-amount invoices from one customer. Measured, it made
  // things worse: the holiday-aware ablation row went from +5.2pp to negative,
  // and the assignment row did not move at all. Reverted.
}

export function scoreCandidate(
  ledger: CanonicalRecord,
  payment: CanonicalRecord,
  cfg: MatchConfig,
): Candidate {
  const strings = scoreStrings(ledger, payment, cfg.stringWeights)
  const amount = scoreAmount(ledger.amount, payment.amount, cfg.amountTolerancePct)
  const date = scoreDate(ledger.date, payment.date, cfg)

  const confidence =
    strings.total * cfg.signalWeights.string +
    amount.score * cfg.signalWeights.amount +
    date.score * cfg.signalWeights.date

  return {
    ledger,
    payment,
    confidence,
    strings,
    amountScore: amount.score,
    dateScore: date.score,
    evidence: [...strings.evidence, amount.evidence, date.evidence],
  }
}

/** Every (ledger, payment) pair worth scoring at all. */
export function buildCandidates(
  ledger: CanonicalRecord[],
  payments: CanonicalRecord[],
  cfg: MatchConfig,
): Candidate[] {
  const out: Candidate[] = []
  for (const l of ledger) {
    for (const p of payments) {
      // Refunds are batch-level adjustments, not invoice counterparts.
      if (p.amount < 0n) continue

      const c = scoreCandidate(l, p, cfg)

      // Amount is a GATE, not merely a weighted signal. In reconciliation the
      // money has to agree — a payment for a different sum is not a weaker
      // match for this invoice, it is not a match at all. Treating it as a soft
      // signal lets two payments from the same counterparty score alike on
      // text and drown the true match in false ambiguity.
      //
      // Partial amounts (split settlements) are handled by `splitMatch`, which
      // sums candidates before applying the same tolerance.
      if (c.amountScore === 0) continue

      if (c.confidence > 0.2) out.push(c)
    }
  }
  return out
}

export type TierResult = {
  matches: { ledgerId: string; paymentIds: string[]; confidence: number; evidence: string[] }[]
  consumedLedger: Set<string>
  consumedPayments: Set<string>
}

/**
 * Tier 1 — exact. Demands an identifier hit and an exact amount. Anything this
 * tier claims should essentially never be wrong.
 */
export function exactMatch(candidates: Candidate[]): TierResult {
  const matches: TierResult['matches'] = []
  const consumedLedger = new Set<string>()
  const consumedPayments = new Set<string>()

  const exact = candidates
    .filter((c) => c.strings.identifier >= 1 && c.amountScore === 1)
    .sort((a, b) => b.confidence - a.confidence)

  for (const c of exact) {
    if (consumedLedger.has(c.ledger.id) || consumedPayments.has(c.payment.id)) continue
    consumedLedger.add(c.ledger.id)
    consumedPayments.add(c.payment.id)
    matches.push({
      ledgerId: c.ledger.id,
      paymentIds: [c.payment.id],
      // Exact is not free of risk (two invoices can share a reference), but it
      // is the strongest evidence available short of a settlement id.
      confidence: 0.99,
      evidence: c.evidence,
    })
  }

  return { matches, consumedLedger, consumedPayments }
}

/**
 * Tier 2 — fuzzy, greedy. Takes the highest-confidence candidate first and
 * consumes both sides, which is precisely where it goes wrong on near-duplicate
 * pairs. Tier 3 fixes that.
 */
export function fuzzyMatch(
  candidates: Candidate[],
  already: TierResult,
  cfg: MatchConfig,
): TierResult {
  const matches: TierResult['matches'] = []
  const consumedLedger = new Set(already.consumedLedger)
  const consumedPayments = new Set(already.consumedPayments)

  if (!cfg.enableFuzzy) {
    return { matches, consumedLedger, consumedPayments }
  }

  const ranked = candidates
    .filter(
      (c) => !already.consumedLedger.has(c.ledger.id) && !already.consumedPayments.has(c.payment.id),
    )
    .filter((c) => c.confidence >= cfg.fuzzyAcceptThreshold)
    .sort((a, b) => b.confidence - a.confidence)

  for (const c of ranked) {
    if (consumedLedger.has(c.ledger.id) || consumedPayments.has(c.payment.id)) continue
    consumedLedger.add(c.ledger.id)
    consumedPayments.add(c.payment.id)
    matches.push({
      ledgerId: c.ledger.id,
      paymentIds: [c.payment.id],
      confidence: c.confidence,
      evidence: c.evidence,
    })
  }

  return { matches, consumedLedger, consumedPayments }
}

/**
 * Tier 3 — optimal assignment over the SAME candidate set tier 2 would have
 * resolved greedily.
 *
 * This deliberately replaces `fuzzyMatch` rather than mopping up after it. If
 * greedy ran first and consumed the contested rows, the solver could never undo
 * those choices and the ablation row would measure nothing. Comparing greedy and
 * optimal on identical inputs is the only way the delta means anything.
 */
export function assignmentMatch(
  candidates: Candidate[],
  already: TierResult,
  cfg: MatchConfig,
): TierResult {
  const matches: TierResult['matches'] = []
  const consumedLedger = new Set(already.consumedLedger)
  const consumedPayments = new Set(already.consumedPayments)

  if (!cfg.enableFuzzy) return { matches, consumedLedger, consumedPayments }

  const open = candidates.filter(
    (c) => !consumedLedger.has(c.ledger.id) && !consumedPayments.has(c.payment.id),
  )
  if (open.length === 0) return { matches, consumedLedger, consumedPayments }

  const ledgerIds = [...new Set(open.map((c) => c.ledger.id))]
  const paymentIds = [...new Set(open.map((c) => c.payment.id))]
  const rowIndex = new Map(ledgerIds.map((id, i) => [id, i]))
  const colIndex = new Map(paymentIds.map((id, i) => [id, i]))

  const scores = new Map<string, Candidate>()
  for (const c of open) scores.set(`${c.ledger.id} ${c.payment.id}`, c)

  const { rowToCol } = solveMaxScore(ledgerIds.length, paymentIds.length, (r, col) => {
    const c = scores.get(`${ledgerIds[r]} ${paymentIds[col]}`)
    if (!c || c.confidence < cfg.fuzzyAcceptThreshold) return undefined
    return c.confidence
  })

  for (const [ledgerId, r] of rowIndex) {
    const col = rowToCol[r]
    if (col < 0) continue
    const c = scores.get(`${ledgerId} ${paymentIds[col]}`)
    if (!c) continue
    consumedLedger.add(ledgerId)
    consumedPayments.add(c.payment.id)
    matches.push({
      ledgerId,
      paymentIds: [c.payment.id],
      confidence: c.confidence,
      evidence: [...c.evidence, 'chosen by global optimal assignment'],
    })
  }

  // Silence unused-variable lint on colIndex while keeping the symmetry legible.
  void colIndex

  return { matches, consumedLedger, consumedPayments }
}

/**
 * Split settlements: one invoice paid across two batches. Looks for a pair of
 * still-unconsumed payments that share the invoice's reference and sum to its
 * amount within tolerance.
 *
 * Restricted to pairs on purpose — three-way splits are rare and the
 * combinatorics stop being free.
 */
export function splitMatch(
  ledger: CanonicalRecord[],
  payments: CanonicalRecord[],
  already: TierResult,
  cfg: MatchConfig,
): TierResult {
  const matches: TierResult['matches'] = []
  const consumedLedger = new Set(already.consumedLedger)
  const consumedPayments = new Set(already.consumedPayments)

  if (!cfg.enableFuzzy) return { matches, consumedLedger, consumedPayments }

  const openLedger = ledger.filter((l) => !consumedLedger.has(l.id))
  const openPayments = payments.filter((p) => !consumedPayments.has(p.id) && p.amount > 0n)

  for (const l of openLedger) {
    const related = openPayments.filter((p) => {
      if (consumedPayments.has(p.id)) return false
      const s = scoreStrings(l, p, cfg.stringWeights)
      return s.identifier >= 1
    })
    if (related.length < 2) continue

    let found: [CanonicalRecord, CanonicalRecord] | null = null
    for (let i = 0; i < related.length && !found; i++) {
      for (let j = i + 1; j < related.length && !found; j++) {
        const sum = related[i].amount + related[j].amount
        if (scoreAmount(l.amount, sum, cfg.amountTolerancePct).score > 0) {
          found = [related[i], related[j]]
        }
      }
    }
    if (!found) continue

    consumedLedger.add(l.id)
    consumedPayments.add(found[0].id)
    consumedPayments.add(found[1].id)
    matches.push({
      ledgerId: l.id,
      paymentIds: [found[0].id, found[1].id],
      confidence: 0.93,
      evidence: [
        'split settlement',
        `${found[0].id} + ${found[1].id} sum to invoice amount`,
      ],
    })
  }

  return { matches, consumedLedger, consumedPayments }
}
