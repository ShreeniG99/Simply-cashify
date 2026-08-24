import { DEFAULT_STRING_WEIGHTS, type StringWeights } from './strings'
import { IN_FIXED_HOLIDAYS_2026 } from '../util/dates'

/**
 * Engine configuration.
 *
 * The `enable*` flags exist so the ablation table is produced by genuinely
 * switching capabilities off and re-running, not by re-describing one result.
 */
export type MatchConfig = {
  holidays: string[]
  /** Expected settlement lag, in business days (Razorpay is T+2). */
  settlementWindowBusinessDays: number
  /** Extra business-day slack before a settlement counts as late. */
  dateToleranceBusinessDays: number
  /** Percentage the amounts may differ by and still be considered. */
  amountTolerancePct: number
  stringWeights: StringWeights
  /** How the three signals combine into a confidence. */
  signalWeights: { string: number; amount: number; date: number }
  /** Minimum confidence for the fuzzy tier to claim a match. */
  fuzzyAcceptThreshold: number

  /**
   * Cap on how many residual records the agent tier will actually process in
   * one run, highest automated confidence first. Bounds real API cost and
   * free-tier rate limits (~30 RPM on Groq) — a single dashboard run stays
   * well under the cap; see the much lower override on the ablation rung
   * below, which fires the agent across an 8-seed sweep and would otherwise
   * multiply real API calls by 8x.
   */
  maxAgentRecords: number

  // ---- ablation switches ----
  enableFuzzy: boolean
  /** When false, date windows count weekends/holidays as ordinary days. */
  enableHolidayAwareness: boolean
  enableAssignment: boolean
  enableAgent: boolean
  enableFx: boolean
}

export const DEFAULT_CONFIG: MatchConfig = {
  holidays: [...IN_FIXED_HOLIDAYS_2026],
  settlementWindowBusinessDays: 2,
  dateToleranceBusinessDays: 1,
  amountTolerancePct: 0.5,
  stringWeights: DEFAULT_STRING_WEIGHTS,
  // Amount is gated in `buildCandidates`, so by the time these weights apply
  // the money already agrees. What is left to decide between surviving
  // candidates is text and timing — hence the heavier date weight.
  signalWeights: { string: 0.5, amount: 0.2, date: 0.3 },
  fuzzyAcceptThreshold: 0.72,
  maxAgentRecords: 20,
  enableFuzzy: true,
  enableHolidayAwareness: true,
  enableAssignment: true,
  enableAgent: true,
  enableFx: true,
}

/** The ablation ladder: each rung adds one capability to the one before it. */
export const ABLATION_RUNGS: { label: string; overrides: Partial<MatchConfig> }[] = [
  {
    label: 'Exact only',
    overrides: {
      enableFuzzy: false,
      enableHolidayAwareness: false,
      enableAssignment: false,
      enableAgent: false,
      enableFx: false,
    },
  },
  {
    label: '+ Fuzzy',
    overrides: {
      enableFuzzy: true,
      enableHolidayAwareness: false,
      enableAssignment: false,
      enableAgent: false,
      enableFx: false,
    },
  },
  {
    label: '+ FX normalization',
    overrides: {
      enableFuzzy: true,
      enableHolidayAwareness: false,
      enableAssignment: false,
      enableAgent: false,
      enableFx: true,
    },
  },
  {
    label: '+ Holiday-aware windows',
    overrides: {
      enableFuzzy: true,
      enableHolidayAwareness: true,
      enableAssignment: false,
      enableAgent: false,
      enableFx: true,
    },
  },
  {
    label: '+ Optimal assignment',
    overrides: {
      enableFuzzy: true,
      enableHolidayAwareness: true,
      enableAssignment: true,
      enableAgent: false,
      enableFx: true,
    },
  },
  {
    label: '+ LLM adjudication',
    overrides: {
      enableFuzzy: true,
      enableHolidayAwareness: true,
      enableAssignment: true,
      enableAgent: true,
      enableFx: true,
      // This rung fires across an 8-seed sweep in the seeded ablation
      // (lib/eval/ablation.ts). Without a much lower cap here, that sweep
      // would multiply real API calls by 8x against a free tier limited to
      // ~30 RPM. A single dashboard run keeps the full DEFAULT_CONFIG cap.
      maxAgentRecords: 5,
    },
  },
]

export function withOverrides(base: MatchConfig, o: Partial<MatchConfig>): MatchConfig {
  return { ...base, ...o }
}
