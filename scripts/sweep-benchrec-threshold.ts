/**
 * Dataset-specific accept-threshold sweep for BenchRec: `npm run
 * bench:benchrec-sweep`.
 *
 * `DATA.md` already reports the honest finding that BenchRec's real recall
 * (12.4%) is capped by a single fixed accept threshold (0.72) tuned for the
 * synthetic generator's clearer signal shape — most true matches on this
 * dataset score 0.6-0.72, just under that bar. This script is the named
 * "obvious next step": actually run the sweep, rather than assert what it
 * would show.
 *
 * This is NOT `lib/eval/score.ts`'s sweep reused verbatim. That sweep works
 * by re-filtering an ALREADY-COMPUTED match list by a rising post-hoc
 * cutoff — valid there because every threshold it tries is above the
 * generator's own match-time threshold, so no candidate below the cutoff
 * was ever a candidate to begin with. BenchRec's own finding is the mirror
 * image: the recall we're leaving on the table sits BELOW today's
 * threshold. `fuzzyMatch`/`assignmentMatch` (`lib/engine/match.ts`) bake
 * `cfg.fuzzyAcceptThreshold` directly into which edges the solver is even
 * allowed to consider, so a lower threshold can produce a genuinely
 * different optimal assignment, not just a wider filter on the same one —
 * scoring requires actually re-solving at each threshold.
 *
 * Re-solving is cheap; re-blocking is not. `buildBenchRecComponents`
 * (candidate generation + connected-component partitioning) is entirely
 * threshold-independent and is where the real benchmark's ~7 minutes goes
 * (dominated by `scoreCandidate`'s fuzzy string scoring over ~340K blocked
 * pairs) — see `lib/engine/benchrecMatch.ts`. So it runs ONCE here, and
 * `solveBenchRecComponents` (Hungarian solve per component, or greedy for
 * an oversized cluster) re-runs per threshold, which is what makes a
 * multi-point sweep over the full 69K-row eval set tractable at all.
 */

import path from 'node:path'
import { loadBenchRecFromDisk } from '../lib/datasets/benchrec/loader'
import { rowsToLedger, rowsToSettlements } from '../lib/datasets/benchrec/adapter'
import { deriveBenchRecTruthFromEval } from '../lib/datasets/benchrec/truth'
import { buildBenchRecComponents, solveBenchRecComponents, BENCHREC_CONFIG } from '../lib/engine/benchrecMatch'
import { withOverrides } from '../lib/engine/config'
import { scoreBenchRec, type BenchRecScoreReport } from '../lib/eval/benchrecScore'
import { pctString } from '../lib/util/format'

// Spans both sides of the shipped default (0.72) — the generator's own
// sweep only ever goes up from its match-time threshold; this one
// deliberately goes down too, since that's where BenchRec's signal sits.
const THRESHOLDS = [0.4, 0.45, 0.5, 0.55, 0.58, 0.6, 0.62, 0.64, 0.66, 0.68, 0.7, 0.72, 0.75, 0.8, 0.85, 0.9]

const PRECISION_TARGETS = [0.995, 0.99, 0.97, 0.95]

function pickOperatingPoint(
  rows: { threshold: number; report: BenchRecScoreReport }[],
  target: number,
): { threshold: number; report: BenchRecScoreReport } | null {
  const qualifying = rows.filter((r) => r.report.precision >= target && r.report.correct + r.report.wrong > 0)
  if (qualifying.length === 0) return null
  // Lowest threshold meeting the bar maximizes recall while still holding it —
  // same selection rule lib/eval/score.ts uses for the generator.
  return qualifying.reduce((best, r) => (r.threshold < best.threshold ? r : best))
}

async function main() {
  console.log('\nSimply Cashify — BenchRec threshold sweep')
  console.log('  re-solving at multiple fuzzyAcceptThreshold values against the same')
  console.log('  candidate set + eval/solution split as the primary benchmark. See DATA.md.\n')

  const dir = path.join(process.cwd(), 'data/raw/benchrec')
  const { evalRows, solution } = await loadBenchRecFromDisk(dir)
  const truth = deriveBenchRecTruthFromEval(evalRows, solution)

  const ledger = rowsToLedger(evalRows)
  const settlements = rowsToSettlements(evalRows)

  console.log('LOADED (eval split)')
  console.log(`  ledger (A) rows         ${ledger.length.toLocaleString()}`)
  console.log(`  statement (B) rows      ${settlements.length.toLocaleString()}`)
  console.log('')

  console.log(`Building candidates + components ONCE (threshold-independent)...`)
  const buildStart = Date.now()
  const built = buildBenchRecComponents(ledger, settlements, BENCHREC_CONFIG)
  const buildMs = Date.now() - buildStart
  console.log(`  candidates generated    ${built.candidates.length.toLocaleString()}`)
  console.log(`  build time              ${(buildMs / 1000).toFixed(1)}s`)
  console.log('')

  const rows: { threshold: number; report: BenchRecScoreReport; solveMs: number }[] = []
  for (const t of THRESHOLDS) {
    const cfg = withOverrides(BENCHREC_CONFIG, { fuzzyAcceptThreshold: t })
    const solveStart = Date.now()
    const { results } = solveBenchRecComponents(ledger.length, settlements, built, cfg)
    const solveMs = Date.now() - solveStart
    const report = scoreBenchRec(results, truth)
    rows.push({ threshold: t, report, solveMs })
    console.log(
      `  threshold ${t.toFixed(2)}  precision ${pctString(report.precision).padStart(6)}  recall ${pctString(report.recall).padStart(6)}` +
        `  claimed ${(report.correct + report.wrong).toLocaleString().padStart(6)}  wrong ${report.wrong.toLocaleString().padStart(5)}  (solve ${solveMs}ms)`,
    )
  }
  console.log('')

  console.log('OPERATING POINTS  (lowest threshold meeting each precision target, maximizing recall)')
  for (const target of PRECISION_TARGETS) {
    const point = pickOperatingPoint(rows, target)
    if (!point) {
      console.log(`  >= ${pctString(target)} precision: not reached by any threshold in this sweep`)
      continue
    }
    console.log(
      `  >= ${pctString(target)} precision: threshold ${point.threshold.toFixed(2)} -> ` +
        `precision ${pctString(point.report.precision)}, recall ${pctString(point.report.recall)}`,
    )
  }
  console.log('')

  const shipped = rows.find((r) => r.threshold === 0.72)
  if (shipped) {
    console.log(`SHIPPED DEFAULT (0.72, unchanged): precision ${pctString(shipped.report.precision)}, recall ${pctString(shipped.report.recall)}`)
    console.log('  This sweep is a diagnostic, not a silent retune — the shipped default is')
    console.log('  left as-is; see DATA.md for which operating point (if any) is adopted.')
  }
  console.log('')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
