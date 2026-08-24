/**
 * Throughput and correctness at scale, on the real Berka dataset: `npm run bench:berka`.
 *
 * This is deliberately a different claim from `npm run bench`. The generator
 * proves matching DIFFICULTY (ambiguity, honesty, ablation). Berka proves the
 * pipeline is fast and correct on real, unmodified, million-row financial data.
 * See the note in `lib/datasets/berka/truth.ts` for why the two numbers are not
 * comparable.
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import { loadBerkaFromDisk } from '../lib/datasets/berka/loader'
import { ordersToLedger, transToBank } from '../lib/datasets/berka/adapter'
import { deriveBerkaTruth } from '../lib/datasets/berka/truth'
import { matchBerka } from '../lib/engine/berkaMatch'
import { scoreBerka } from '../lib/eval/berkaScore'
import { pctString } from '../lib/util/format'

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

async function main() {
  console.log('\nSimply Cashify — Berka real-data benchmark')
  console.log(`  commit ${commitHash()}   ${new Date().toISOString()}`)
  console.log('  source: PKDD\'99 Discovery Challenge (Berka dataset), real anonymized')
  console.log('  Czech bank data, 1993-1998. See DATA.md for provenance.\n')

  const loadStart = Date.now()
  const dir = path.join(process.cwd(), 'data/raw/berka')
  const { orders, trans } = await loadBerkaFromDisk(dir)
  const loadMs = Date.now() - loadStart

  console.log('LOADED')
  console.log(`  standing orders        ${orders.length.toLocaleString()}`)
  console.log(`  transactions            ${trans.length.toLocaleString()}`)
  console.log(`  parse time              ${loadMs}ms`)
  console.log('')

  const matchStart = Date.now()
  const ledger = ordersToLedger(orders)
  const bank = transToBank(trans) // VYDAJ only; the adapter filters and reports why
  const { results, stats } = matchBerka(ledger, bank)
  const matchMs = Date.now() - matchStart

  const truth = deriveBerkaTruth(orders, trans)
  const report = scoreBerka(results, truth)

  const totalRecords = orders.length + trans.length
  const totalMs = loadMs + matchMs
  const recordsPerSecond = Math.round((totalRecords / totalMs) * 1000)

  console.log('THROUGHPUT')
  console.log(`  total records processed ${totalRecords.toLocaleString()}  (${orders.length.toLocaleString()} orders + ${trans.length.toLocaleString()} transactions)`)
  console.log(`  matching time           ${matchMs}ms`)
  console.log(`  end-to-end (parse+match)${totalMs}ms`)
  console.log(`  throughput              ${recordsPerSecond.toLocaleString()} rec/s`)
  console.log('')

  console.log('COVERAGE')
  console.log(`  outgoing (VYDAJ) txns   ${bank.length.toLocaleString()}  — the only type that can execute a standing order`)
  console.log(`  deposits/withdrawals    ${(trans.length - bank.length).toLocaleString()}  — correctly out of scope, not silently dropped`)
  console.log(`  txns on an account with no order at all   ${stats.transWithNoOrderOnAccount.toLocaleString()}`)
  console.log('')

  console.log('ACCURACY  (scale/correctness proof — see header note, not a difficulty benchmark)')
  console.log(`  precision               ${pctString(report.precision)}  (${report.correct} correct / ${report.correct + report.wrong} claimed)`)
  console.log(`  recall                  ${pctString(report.recall)}`)
  console.log(`  correctly declined       ${report.correctlyDeclined.toLocaleString()}`)
  console.log(`  wrong auto-approvals     ${report.wrong}`)
  console.log(`  missed (should've matched) ${report.missed}`)
  console.log('')

  const executedOrders = [...truth.orderExecuted.values()].filter(Boolean).length
  console.log('ORGANIC ORPHANS (real data, not injected)')
  console.log(
    `  standing orders never executed  ${orders.length - executedOrders} / ${orders.length}` +
      `  — issued but no matching transaction ever appears in the historical record`,
  )
  console.log('')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
