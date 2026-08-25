/**
 * Real-data benchmark on the BenchRec (ICAIF'23) dataset: `npm run bench:benchrec`.
 *
 * Same role as `npm run bench:berka` — a scale/real-data proof point, run
 * from the CLI rather than the dashboard, provenance-stamped so a quoted
 * number traces back to the commit and run that produced it. See DATA.md.
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import { loadBenchRecFromDisk } from '../lib/datasets/benchrec/loader'
import { rowsToLedger, rowsToSettlements } from '../lib/datasets/benchrec/adapter'
import { deriveBenchRecTruthFromEval } from '../lib/datasets/benchrec/truth'
import { matchBenchRec, BENCHREC_CONFIG } from '../lib/engine/benchrecMatch'
import { scoreBenchRec } from '../lib/eval/benchrecScore'
import { pctString } from '../lib/util/format'

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

async function main() {
  console.log('\nSimply Cashify — BenchRec real-data benchmark')
  console.log(`  commit ${commitHash()}   ${new Date().toISOString()}`)
  console.log('  source: ICAIF\'23 Benchmark Competition (BenchRec), real labeled cash reconciliation data')
  console.log('  scored against the held-out eval + solution split. See DATA.md for provenance.\n')

  const loadStart = Date.now()
  const dir = path.join(process.cwd(), 'data/raw/benchrec')
  const { evalRows, solution } = await loadBenchRecFromDisk(dir)
  const loadMs = Date.now() - loadStart

  const ledger = rowsToLedger(evalRows)
  const settlements = rowsToSettlements(evalRows)

  console.log('LOADED (eval split)')
  console.log(`  ledger (A) rows         ${ledger.length.toLocaleString()}`)
  console.log(`  statement (B) rows      ${settlements.length.toLocaleString()}`)
  console.log(`  parse time              ${loadMs}ms`)
  console.log('')

  const matchStart = Date.now()
  const { results, stats } = matchBenchRec(ledger, settlements, BENCHREC_CONFIG)
  const matchMs = Date.now() - matchStart

  const truth = deriveBenchRecTruthFromEval(evalRows, solution)
  const report = scoreBenchRec(results, truth)

  const totalRecords = ledger.length + settlements.length
  const totalMs = loadMs + matchMs
  const recordsPerSecond = Math.round((totalRecords / totalMs) * 1000)

  console.log('THROUGHPUT')
  console.log(`  total records processed ${totalRecords.toLocaleString()}  (${ledger.length.toLocaleString()} ledger + ${settlements.length.toLocaleString()} statement)`)
  console.log(`  matching time           ${matchMs}ms`)
  console.log(`  end-to-end (parse+match)${totalMs}ms`)
  console.log(`  throughput              ${recordsPerSecond.toLocaleString()} rec/s`)
  console.log('')

  console.log('MATCHING SHAPE')
  console.log(`  candidates generated    ${stats.candidatesGenerated.toLocaleString()}  (amount-window blocked — see lib/engine/benchrecMatch.ts)`)
  console.log(`  connected components    ${stats.componentsSolved.toLocaleString()}  (largest: ${stats.largestComponentSize.toLocaleString()})`)
  console.log(`  oversized -> greedy      ${stats.oversizedComponentsFellBackToGreedy.toLocaleString()}`)
  const exactCount = results.filter((r) => r.tier === 'exact').length
  const assignmentCount = results.filter((r) => r.tier === 'assignment' || r.tier === 'fuzzy').length
  console.log(`  resolved by tier 1 (exact)      ${exactCount.toLocaleString()}  — this dataset's anonymized text carries no UTR/invoice-ref-shaped identifier, so this is honestly near zero`)
  console.log(`  resolved by tier 2/3 (fuzzy/assignment) ${assignmentCount.toLocaleString()}`)
  console.log('')

  console.log('ACCURACY  (allocation-key scoring — see lib/eval/benchrecScore.ts)')
  console.log(`  ceiling                 ${pctString(report.ceiling)}  — fraction of B rows whose true A counterpart is even present in this batch`)
  console.log(`  precision               ${pctString(report.precision)}  (${report.correct} correct / ${report.correct + report.wrong} claimed)`)
  console.log(`  recall                  ${pctString(report.recall)}`)
  console.log(`  correctly declined      ${report.correctlyDeclined.toLocaleString()}`)
  console.log(`  wrong auto-approvals    ${report.wrong.toLocaleString()}`)
  console.log(`  missed (should've matched) ${report.missed.toLocaleString()}`)
  console.log('')

  console.log('CONFIDENCE DISTRIBUTION  (every generated candidate, not just accepted ones)')
  console.log(`  the accept threshold (${BENCHREC_CONFIG.fuzzyAcceptThreshold}) is the generator's own default, not`)
  console.log('  retuned for this dataset — this histogram is the honest explanation if recall')
  console.log('  looks low: whether true matches are scoring low, or scoring close and just')
  console.log('  missing a threshold calibrated for a different dataset\'s signal shape.')
  for (const b of stats.confidenceHistogram) {
    console.log(`  ${b.bucket.padEnd(10)} ${b.count.toLocaleString()}`)
  }
  console.log('')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
