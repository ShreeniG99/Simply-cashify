/**
 * Exception copy in a controller's voice.
 *
 * `ReconExceptionRecord.detail` (lib/engine/types.ts) is deliberately precise
 * and technical — it names the exact candidate id, score, threshold, or paisa
 * delta, because the decision drawer and Settlement Q&A exist so a controller
 * can re-verify a specific claim. That precision reads as a debug log when
 * it's the FIRST thing a controller sees while scanning fifty rows, though —
 * "Best candidate pay_2008 scored 0.7, below the 0.72 threshold" answers "what
 * number produced this", not "what do I do about it".
 *
 * So the main exceptions table shows `controllerSummary` instead: the same
 * fact, phrased the way a controller would actually say it out loud. Nothing
 * here invents a new fact — every sentence is computed from the same
 * structured data `detail` was built from, at the same call site in
 * `lib/engine/pipeline.ts`, never by reformatting or parsing the `detail`
 * string after the fact (string-parsing a message to re-derive its own
 * inputs would be fragile and is exactly backwards).
 *
 * `GENERIC_CONTROLLER_COPY` below is only the fallback for the few call sites
 * that predate this field (older test fixtures) — it has no dynamic detail
 * because none was available to it, and nothing in the real pipeline uses it.
 */

import type { ExceptionReason } from '../engine/types'

export const GENERIC_CONTROLLER_COPY: Record<ExceptionReason, string> = {
  orphan: "This doesn't tie back to anything on the other side — likely still outstanding.",
  low_confidence: "The closest candidate falls short of our auto-approval bar — worth a second look.",
  ambiguous_multiple_candidates:
    'More than one candidate is equally plausible — needs a human to pick between them.',
  fee_math_break: "The settlement math doesn't add up — worth flagging to the payment processor.",
  fx_unresolved: "Couldn't be compared in INR — a currency conversion is missing.",
  duplicate_suspected: 'Looks like a repeat of an invoice that is already settled.',
  invalid_bank_details: "The bank details on file don't look right — worth confirming before paying out.",
}

/** Always renders something, even for a pre-field fixture — never a blank cell. */
export function controllerCopy(exception: { reason: ExceptionReason; controllerSummary?: string }): string {
  return exception.controllerSummary ?? GENERIC_CONTROLLER_COPY[exception.reason]
}
