/**
 * Raw BenchRec (ICAIF'23 Benchmark Competition) rows, field-for-field as the
 * real CSVs are shaped.
 *
 * Long format, not wide: each row is either an A-side (internal ledger) row
 * or a B-side (external statement) row — never both — and rows that belong
 * to the same real-world transaction group share a `matchId`. A_id/B_id are
 * populated exclusively of each other on any given row. See
 * `lib/datasets/benchrec/adapter.ts` for how this is split into the two
 * canonical sides.
 */

export type BenchRecRow = {
  matchId: string
  matchDate: string
  matchRule: string
  matchedBy: string
  wasPreviouslyMismatched: string
  A_transactionType: string
  A_id: string
  /**
   * A normalized fingerprint of this A row's own currency/date/account/text —
   * a real, given input field (present on every A row), not a withheld
   * answer. It IS what a B row's true `targetAllocation` should equal when
   * they belong to the same real-world transaction.
   */
  A_allocation: string
  A_importDate: string
  A_debitOrCredit: string
  A_amount: string
  A_valueDate: string
  A_currencyCode: string
  A_account: string
  A_transactionReferences: string
  A_transactionAttributes: string
  B_transactionType: string
  B_id: string
  B_importDate: string
  B_debitOrCredit: string
  B_amount: string
  B_valueDate: string
  B_currencyCode: string
  B_account: string
  B_transactionReferences: string
  B_transactionAttributes: string
  /**
   * The answer for a B row: which A row's allocation key it truly belongs
   * to. Present in `train.csv`; blank (withheld) in `eval.csv` — see
   * `solution.csv` / `SolutionRow` for the held-out answer to that file.
   */
  targetAllocation: string
}

/** `solution.csv` — the held-out answer key for `eval.csv`'s B rows. */
export type SolutionRow = {
  B_id: string
  targetAllocation: string
  /** Kaggle leaderboard split (Public/Private) — not used by this project. */
  usage: string
}
