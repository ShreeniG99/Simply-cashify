/**
 * Multi-seed ablation.
 *
 * A single seed cannot distinguish a real effect from noise. Measuring the
 * assignment tier made that concrete: on seed 42 greedy and optimal produce
 * identical output, so the row looks inert — but across eight seeds they
 * disagree on ~0.6% of rows, with optimal ahead. One number would have reported
 * either "no effect" or "clear win" depending purely on which seed was picked.
 *
 * "One cherry-picked match proves nothing" applies to our own methodology, not
 * just to the matches. So every rung is run across N seeds and reported as a
 * mean with its spread.
 */

import { generate } from '../datasets/generate'
import { reconcile } from '../engine/pipeline'
import { score } from './score'
import { ABLATION_RUNGS } from '../engine/config'

export type SeededAblationRow = {
  label: string
  seeds: number
  meanPrecision: number
  meanRecall: number
  meanF1: number
  meanAutoClear: number
  meanFalseExceptions: number
  /** Standard deviation of recall across seeds. */
  recallStdDev: number
  minRecall: number
  maxRecall: number
  /** Recall gain over the previous rung, averaged per seed. */
  meanGainOverPrevious: number
  /** True when the gain is smaller than the run-to-run spread — i.e. noise. */
  gainWithinNoise: boolean
}

export type SeededAblation = {
  seeds: number[]
  rows: SeededAblationRow[]
}

const DEFAULT_SEEDS = [42, 7, 13, 99, 2024, 555, 8080, 31337]

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

export function runSeededAblation(
  opts: { seeds?: number[]; invoiceCount?: number } = {},
): SeededAblation {
  const seeds = opts.seeds ?? DEFAULT_SEEDS

  // rung index -> per-seed metrics
  const perRung: {
    precision: number[]
    recall: number[]
    f1: number[]
    autoClear: number[]
    falseExceptions: number[]
  }[] = ABLATION_RUNGS.map(() => ({
    precision: [],
    recall: [],
    f1: [],
    autoClear: [],
    falseExceptions: [],
  }))

  // Gains are computed per seed, then averaged — averaging the means first
  // would hide seeds where a rung actually hurt.
  const gainsPerRung: number[][] = ABLATION_RUNGS.map(() => [])

  for (const seed of seeds) {
    const { batch, truth } = generate({ seed, invoiceCount: opts.invoiceCount })
    let previousRecall: number | null = null

    for (let i = 0; i < ABLATION_RUNGS.length; i++) {
      const result = reconcile(batch, { config: ABLATION_RUNGS[i].overrides })
      const s = score(result, truth).operating

      perRung[i].precision.push(s.precision)
      perRung[i].recall.push(s.recall)
      perRung[i].f1.push(s.f1)
      perRung[i].autoClear.push(s.autoClearRate)
      perRung[i].falseExceptions.push(s.falseExceptions)

      if (previousRecall !== null) gainsPerRung[i].push(s.recall - previousRecall)
      previousRecall = s.recall
    }
  }

  const rows: SeededAblationRow[] = ABLATION_RUNGS.map((rung, i) => {
    const r = perRung[i]
    const sd = stdDev(r.recall)
    const gain = mean(gainsPerRung[i])
    return {
      label: rung.label,
      seeds: seeds.length,
      meanPrecision: mean(r.precision),
      meanRecall: mean(r.recall),
      meanF1: mean(r.f1),
      meanAutoClear: mean(r.autoClear),
      meanFalseExceptions: mean(r.falseExceptions),
      recallStdDev: sd,
      minRecall: Math.min(...r.recall),
      maxRecall: Math.max(...r.recall),
      meanGainOverPrevious: gain,
      // A gain smaller than the run-to-run spread is not evidence of anything.
      gainWithinNoise: i > 0 && Math.abs(gain) < sd,
    }
  })

  return { seeds, rows }
}
