/**
 * Scores a real competition submission against the same BenchRec eval split
 * our own engine is benchmarked on, using our own `scoreBenchRec` — so the
 * comparison is apples-to-apples: identical scorer, identical held-out
 * solution file, only the predictions differ.
 *
 * The submission is a real ICAIF'23 BenchRec Benchmark Competition entry
 * (`MatcherByChatGPT_submission.csv`, supplied by the project owner
 * alongside the dataset itself — not fetched, not synthesized). It predicts
 * a B row's match by naming an A row's id directly; scoring deliberately
 * looks up that A row's OWN allocation key from `truth.ownAllocation` rather
 * than trusting the submission's self-reported `targetAllocation` column —
 * the same non-negotiable rule `scoreBenchRec` already applies to our own
 * engine's results, so a submission can't inflate its score by simply
 * echoing a guess back into that column.
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { splitCsvLine } from '../lib/util/csv'
import { loadBenchRecFromDisk } from '../lib/datasets/benchrec/loader'
import { deriveBenchRecTruthFromEval } from '../lib/datasets/benchrec/truth'
import { scoreBenchRec } from '../lib/eval/benchrecScore'
import type { BenchRecMatchResult } from '../lib/engine/benchrecMatch'
import { pctString } from '../lib/util/format'

function parseSubmission(text: string): BenchRecMatchResult[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const header = splitCsvLine(lines.shift() ?? '')
  const idx = new Map(header.map((h, i) => [h, i]))
  const bCol = idx.get('B_id')
  const aCol = idx.get('A_id')
  const confCol = idx.get('confidence')
  if (bCol === undefined || aCol === undefined) {
    throw new Error(`Submission CSV missing B_id/A_id columns — found: ${header.join(', ')}`)
  }

  return lines.map((line) => {
    const fields = splitCsvLine(line)
    const bId = fields[bCol] ?? ''
    const aRaw = (fields[aCol] ?? '').trim()
    const confidence = confCol !== undefined ? Number(fields[confCol]) || 0 : 0
    return {
      bId: `B_${bId}`,
      aId: aRaw.length > 0 ? `A_${aRaw}` : null,
      tier: null,
      confidence,
    }
  })
}

async function main() {
  console.log('\nSimply Cashify — BenchRec baseline comparison')
  console.log('  scoring a real ICAIF\'23 competition submission against the same eval')
  console.log('  split + scorer our own engine is benchmarked on. See DATA.md.\n')

  const dir = path.join(process.cwd(), 'data/raw/benchrec')
  const { evalRows, solution } = await loadBenchRecFromDisk(dir)
  const truth = deriveBenchRecTruthFromEval(evalRows, solution)

  const submissionPath = path.join(dir, 'MatcherByChatGPT_submission.csv')
  const submissionText = await readFile(submissionPath, 'utf-8')
  const results = parseSubmission(submissionText)

  console.log('LOADED')
  console.log(`  submission rows         ${results.length.toLocaleString()}`)
  console.log(`  solution rows           ${solution.length.toLocaleString()}`)
  console.log('')

  const report = scoreBenchRec(results, truth)

  console.log('ACCURACY  (allocation-key scoring — lib/eval/benchrecScore.ts, unchanged from our own run)')
  console.log(`  ceiling                 ${pctString(report.ceiling)}`)
  console.log(`  precision               ${pctString(report.precision)}  (${report.correct} correct / ${report.correct + report.wrong} claimed)`)
  console.log(`  recall                  ${pctString(report.recall)}`)
  console.log(`  correctly declined      ${report.correctlyDeclined.toLocaleString()}`)
  console.log(`  wrong auto-approvals    ${report.wrong.toLocaleString()}`)
  console.log(`  missed (should've matched) ${report.missed.toLocaleString()}`)
  console.log('')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
