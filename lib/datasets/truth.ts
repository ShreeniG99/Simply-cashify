/**
 * GROUND TRUTH — the answer key.
 *
 * ⚠️  Nothing under `lib/engine/**` may import this module. The whole accuracy
 * claim rests on the matching pipeline never seeing the labels, so the rule is
 * enforced structurally by `tests/truth-isolation.test.ts` rather than left to
 * convention. Only the generator (which writes it) and `lib/eval/**` (which
 * scores against it) are allowed to touch it.
 */

export type DiscrepancyClass =
  /** Amount, date and reference all line up. */
  | 'clean'
  /** Settlement landed 1–3 days after the ledger date. */
  | 'timing_drift'
  /** Settlement looks late but a bank holiday explains it. */
  | 'holiday_delayed'
  /** Ledger raised in USD/EUR, settled in INR. */
  | 'fx_settlement'
  /** One invoice paid across two settlement batches. */
  | 'split_settlement'
  /** A refund nets against the batch. */
  | 'partial_refund'
  /** Same invoice recorded twice in the ledger. */
  | 'duplicate_entry'
  /** Reference typo'd or tokens reordered in the memo. */
  | 'typo_reference'
  /** Counterparty IFSC is not a real branch code. */
  | 'wrong_ifsc'
  /** No counterpart exists. MUST stay unmatched — this is the honesty guardrail. */
  | 'true_orphan'
  /** Two similar invoices where only global assignment picks the right pairing. */
  | 'ambiguous_near_duplicate'

export const ALL_CLASSES: DiscrepancyClass[] = [
  'clean',
  'timing_drift',
  'holiday_delayed',
  'fx_settlement',
  'split_settlement',
  'partial_refund',
  'duplicate_entry',
  'typo_reference',
  'wrong_ifsc',
  'true_orphan',
  'ambiguous_near_duplicate',
]

/** Stage B truth: which payment(s) a ledger invoice should resolve to. */
export type TruthPair = {
  ledgerId: string
  /** Empty means the invoice should remain unmatched. */
  paymentIds: string[]
  class: DiscrepancyClass
  /** For `duplicate_entry`: the ledger row this one duplicates. */
  duplicateOf?: string
}

/** Stage A truth: which settlement batch a bank credit should tie out to. */
export type TruthTieout = {
  bankId: string
  /** Null means the credit has no corresponding settlement batch. */
  settlementBatchId: string | null
}

export type GroundTruth = {
  datasetId: string
  seed: number
  tieouts: TruthTieout[]
  pairs: TruthPair[]
  classCounts: Record<DiscrepancyClass, number>
}

export function countClasses(pairs: TruthPair[]): Record<DiscrepancyClass, number> {
  const counts = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<
    DiscrepancyClass,
    number
  >
  for (const p of pairs) counts[p.class]++
  return counts
}

/**
 * The honest ceiling: the fraction of invoices that *can* be matched at all.
 * True orphans and duplicate entries are correctly left unmatched, so a system
 * reporting 100% match rate on this data is not winning — it is guessing.
 */
export function matchableCeiling(pairs: TruthPair[]): number {
  if (pairs.length === 0) return 0
  const matchable = pairs.filter((p) => p.paymentIds.length > 0).length
  return matchable / pairs.length
}
