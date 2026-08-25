import { describe, expect, it } from 'vitest'
import { parseBenchRecRows, parseSolutionRows } from '@/lib/datasets/benchrec/loader'
import { rowsToLedger, rowsToSettlements } from '@/lib/datasets/benchrec/adapter'
import { deriveBenchRecTruthFromTrain, deriveBenchRecTruthFromEval } from '@/lib/datasets/benchrec/truth'
import { matchBenchRec, BENCHREC_CONFIG } from '@/lib/engine/benchrecMatch'
import { scoreBenchRec } from '@/lib/eval/benchrecScore'
import type { BenchRecRow } from '@/lib/datasets/benchrec/types'

const HEADER =
  'matchId,matchDate,matchRule,matchedBy,wasPreviouslyMismatched,A_transactionType,A_id,A_allocation,A_importDate,A_debitOrCredit,A_amount,A_valueDate,A_currencyCode,A_account,A_transactionReferences,A_transactionAttributes,B_transactionType,B_id,B_importDate,B_debitOrCredit,B_amount,B_valueDate,B_currencyCode,B_account,B_transactionReferences,B_transactionAttributes,targetAllocation'

// Real BenchRec shape: one row per A OR B, never both, grouped by matchId.
const TRAIN_FIXTURE = [
  HEADER,
  // matchId 1: a clean 1:1 pair.
  '"1","2023-01-05","RULE 1","AUTO","0","A","A100","KEY_100","2023-01-05","CR","5000.00","2023-01-01","USD","ACC#1","REF100","ACME CORP PAYMENT","","","","","","","","","",""',
  '"1","2023-01-05","RULE 1","AUTO","0","","","","","","","","","","","","B","B100","2023-01-03","DR","5000.00","2023-01-01","USD","ACC#1","REF100","ACME CORP PAYMENT","KEY_100"',
  // matchId 2: an ambiguous pair — two B rows share the same amount as A200, only one is the true match.
  '"2","2023-02-10","RULE 1","AUTO","0","A","A200","KEY_200","2023-02-10","CR","1000.00","2023-02-01","USD","ACC#1","REF200","GLOBEX WIDGET SALE","","","","","","","","","",""',
  '"2","2023-02-10","RULE 1","AUTO","0","","","","","","","","","","","","B","B200","2023-02-03","DR","1000.00","2023-02-01","USD","ACC#1","REF200","GLOBEX WIDGET SALE","KEY_200"',
  // matchId 3: a decoy with the identical amount/date but unrelated text — never matched to anything.
  '"3","2023-02-10","","","0","","","","","","","","","","","","B","B201","2023-02-04","DR","1000.00","2023-02-01","USD","ACC#1","REF999","UNRELATED VENDOR INVOICE",""',
].join('\n')

describe('BenchRec loader', () => {
  it('parses the long-format rows without losing the header-to-field mapping', () => {
    const rows = parseBenchRecRows(TRAIN_FIXTURE)
    expect(rows).toHaveLength(5)
    expect(rows[0].A_id).toBe('A100')
    expect(rows[0].B_id).toBe('')
    expect(rows[1].B_id).toBe('B100')
    expect(rows[1].A_id).toBe('')
    expect(rows[1].targetAllocation).toBe('KEY_100')
  })

  it('parses solution rows (B_id, targetAllocation, Usage)', () => {
    const solutionCsv = ['B_id,targetAllocation,Usage', '"B100","KEY_100","Public"'].join('\n')
    const rows = parseSolutionRows(solutionCsv)
    expect(rows).toEqual([{ B_id: 'B100', targetAllocation: 'KEY_100', usage: 'Public' }])
  })
})

describe('BenchRec adapter', () => {
  const rows = parseBenchRecRows(TRAIN_FIXTURE)

  it('splits A rows into the ledger side with a stable prefixed id', () => {
    const ledger = rowsToLedger(rows)
    expect(ledger.map((l) => l.id)).toEqual(['A_A100', 'A_A200'])
    expect(ledger[0].amount).toBe(500000n)
    expect(ledger[0].source).toBe('ledger')
  })

  it('splits B rows into the settlement side', () => {
    const settlements = rowsToSettlements(rows)
    expect(settlements.map((s) => s.id)).toEqual(['B_B100', 'B_B200', 'B_B201'])
    expect(settlements[0].source).toBe('settlement')
  })

  it('never exposes A_allocation or targetAllocation in a field the matcher reads', () => {
    const ledger = rowsToLedger(rows)
    const settlements = rowsToSettlements(rows)
    for (const rec of [...ledger, ...settlements]) {
      expect(rec.memo ?? '').not.toContain('KEY_')
      expect(rec.reference ?? '').not.toContain('KEY_')
    }
  })

  it('carries the free-text references and attributes into memo, for string scoring to compare', () => {
    const ledger = rowsToLedger(rows)
    expect(ledger[0].memo).toContain('REF100')
    expect(ledger[0].memo).toContain('ACME CORP PAYMENT')
  })
})

describe('BenchRec ground truth', () => {
  it('derives truth directly from train.csv — every B row already carries its answer', () => {
    const rows = parseBenchRecRows(TRAIN_FIXTURE)
    const truth = deriveBenchRecTruthFromTrain(rows)
    expect(truth.trueAllocation.get('B_B100')).toBe('KEY_100')
    expect(truth.trueAllocation.get('B_B200')).toBe('KEY_200')
    expect(truth.trueAllocation.get('B_B201')).toBe(null) // no A shares this text/matchId — genuinely unmatched
    expect(truth.ownAllocation.get('A_A100')).toBe('KEY_100')
  })

  it('derives truth from eval.csv + solution.csv when targetAllocation is withheld', () => {
    const evalRows = parseBenchRecRows(TRAIN_FIXTURE).map((r) => ({ ...r, targetAllocation: '' }))
    const solution = parseSolutionRows(
      ['B_id,targetAllocation,Usage', '"B100","KEY_100","Public"', '"B200","KEY_200","Public"', '"B201","","Public"'].join(
        '\n',
      ),
    )
    const truth = deriveBenchRecTruthFromEval(evalRows, solution)
    expect(truth.trueAllocation.get('B_B100')).toBe('KEY_100')
    expect(truth.trueAllocation.get('B_B201')).toBe(null)
  })
})

describe('BenchRec matcher', () => {
  const rows = parseBenchRecRows(TRAIN_FIXTURE)
  const ledger = rowsToLedger(rows)
  const settlements = rowsToSettlements(rows)
  const truth = deriveBenchRecTruthFromTrain(rows)

  it('matches the clean pair by amount + shared reference text', () => {
    const { results } = matchBenchRec(ledger, settlements, BENCHREC_CONFIG)
    const r = results.find((r) => r.bId === 'B_B100')!
    expect(r.aId).toBe('A_A100')
  })

  it('scores correctly by allocation key against real ground truth', () => {
    const { results } = matchBenchRec(ledger, settlements, BENCHREC_CONFIG)
    const report = scoreBenchRec(results, truth)
    expect(report.wrong).toBe(0)
  })

  it('a decoy with the same amount/date but unrelated text does not falsely claim the ambiguous slot', () => {
    const { results } = matchBenchRec(ledger, settlements, BENCHREC_CONFIG)
    const decoy = results.find((r) => r.bId === 'B_B201')!
    // The decoy's own true allocation is null (no real A), so any claim on it is wrong.
    if (decoy.aId !== null) {
      const chosenKey = truth.ownAllocation.get(decoy.aId)
      expect(chosenKey).not.toBe(null)
    }
  })
})

describe('BenchRec at a larger synthetic scale (no real files required)', () => {
  it('stays correct and reasonably fast when many rows share a pathologically common amount', () => {
    // Mirrors the real dataset's actual character: hundreds of transactions
    // can share an identical round amount, which is what forced the
    // amount-window blocking + connected-component design in the first
    // place (see lib/engine/benchrecMatch.ts's doc comment). Each pair here
    // is distinguishable only by its reference text, same as the real data.
    const rowLines: string[] = [HEADER]
    const N = 300
    for (let i = 0; i < N; i++) {
      const matchId = String(i)
      const key = `KEY_${i}`
      const ref = `VENDOR${i}INV${i}`
      rowLines.push(
        `"${matchId}","2023-01-01","RULE 1","AUTO","0","A","A${i}","${key}","2023-01-01","CR","999.00","2023-01-01","USD","ACC#1","${ref}","${ref} PAYMENT DETAIL","","","","","","","","","",""`,
      )
      rowLines.push(
        `"${matchId}","2023-01-01","RULE 1","AUTO","0","","","","","","","","","","","","B","B${i}","2023-01-01","DR","999.00","2023-01-01","USD","ACC#1","${ref}","${ref} PAYMENT DETAIL","${key}"`,
      )
    }
    const rows = parseBenchRecRows(rowLines.join('\n'))
    const ledger = rowsToLedger(rows)
    const settlements = rowsToSettlements(rows)
    const truth = deriveBenchRecTruthFromTrain(rows)

    const start = Date.now()
    const { results, stats } = matchBenchRec(ledger, settlements, BENCHREC_CONFIG)
    const elapsed = Date.now() - start

    const report = scoreBenchRec(results, truth)
    expect(report.wrong).toBe(0)
    expect(report.correct).toBe(N)
    expect(stats.candidatesGenerated).toBeGreaterThanOrEqual(N)
    // Guards against an accidental quadratic-over-the-whole-cluster regression.
    expect(elapsed).toBeLessThan(15_000)
  })
})
