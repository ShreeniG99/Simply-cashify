/**
 * Benchmark CLI: `npm run bench`
 *
 * Benchmarks belong here rather than on the dashboard. They are numbers you
 * cite, not buttons you press mid-demo — nobody re-runs a large batch live on
 * stage. Output is provenance-stamped (seed, date, commit) so a figure quoted in
 * a slide can always be traced back to the run that produced it.
 */

import { execSync } from 'node:child_process'
import { runReconciliation } from '../lib/api/run'
import { pctString } from '../lib/util/format'
import { runSeededAblation } from '../lib/eval/ablation'

const seed = Number(process.env.SEED ?? 42)
const invoiceCount = Number(process.env.INVOICES ?? 180)

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

const run = runReconciliation({ seed, invoiceCount })
const op = run.report.operating

console.log('')
console.log('Simply Cashify — reconciliation benchmark')
console.log(`  dataset ${run.datasetId}   seed ${run.seed}   commit ${commitHash()}`)
console.log(`  ${new Date().toISOString()}`)
console.log('')

console.log('OPERATING POINT')
console.log(`  confidence threshold   ${op.threshold}`)
console.log(
  `  precision              ${pctString(op.precision)}   (target ${pctString(run.report.precisionTarget)})${
    run.report.targetMissed ? '   ** TARGET MISSED **' : ''
  }`,
)
console.log(`  auto-clear             ${pctString(op.autoClearRate)}`)
console.log(`  recall                 ${pctString(op.recall)}`)
console.log(`  wrong auto-approvals   ${op.wrongMatches}`)
console.log(`  honest ceiling         ${pctString(run.ceiling)}  (orphans cannot be matched)`)
console.log('')

console.log('THROUGHPUT')
console.log(`  records                ${run.stats.recordCount}`)
console.log(`  wall clock             ${run.stats.wallClockMs}ms`)
console.log(`  rate                   ${run.stats.recordsPerSecond.toLocaleString()} rec/s`)
console.log(`  agent tier             ${run.agentTier}`)
console.log('')

console.log(`ABLATION (seed ${run.seed})`)
console.log('  config                      precision   recall   F1       auto-clear   false exc.')
for (const r of run.ablation) {
  console.log(
    `  ${r.label.padEnd(26)}` +
      `${pctString(r.precision).padStart(8)}` +
      `${pctString(r.recall).padStart(9)}` +
      `${pctString(r.f1).padStart(9)}` +
      `${pctString(r.autoClearRate).padStart(13)}` +
      `${String(r.falseExceptions).padStart(12)}`,
  )
}
console.log('')

// A single seed cannot separate a real effect from noise, so the headline
// ablation is the multi-seed one.
const seeded = runSeededAblation()
console.log(`ABLATION ACROSS ${seeded.seeds.length} SEEDS  [${seeded.seeds.join(', ')}]`)
console.log('  config                     mean recall   (min–max)      ±sd      gain')
for (const r of seeded.rows) {
  const gain =
    r.meanGainOverPrevious === 0 && r.label === seeded.rows[0].label
      ? '     —'
      : `${r.meanGainOverPrevious >= 0 ? '+' : ''}${(r.meanGainOverPrevious * 100).toFixed(1)}pp`
  const flag = r.gainWithinNoise ? '  (within noise)' : ''
  console.log(
    `  ${r.label.padEnd(26)}` +
      `${pctString(r.meanRecall).padStart(8)}   ` +
      `(${pctString(r.minRecall)}–${pctString(r.maxRecall)})`.padEnd(17) +
      `${pctString(r.recallStdDev).padStart(6)}` +
      `${gain.padStart(9)}${flag}`,
  )
}
console.log('')

console.log('ACCURACY BY DISCREPANCY CLASS')
for (const b of run.report.byClass) {
  console.log(
    `  ${b.class.replace(/_/g, ' ').padEnd(26)}${String(b.correct).padStart(3)}/${String(
      b.total,
    ).padEnd(4)}${pctString(b.accuracy).padStart(7)}`,
  )
}
console.log('')

const reasons = new Map<string, number>()
for (const e of run.exceptions) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1)
console.log(`EXCEPTIONS (${run.exceptions.length})`)
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason.replace(/_/g, ' ').padEnd(32)}${String(count).padStart(4)}`)
}
console.log('')
