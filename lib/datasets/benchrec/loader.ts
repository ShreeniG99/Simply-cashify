/**
 * Parser for the real BenchRec (ICAIF'23 Benchmark Competition) dataset.
 *
 * Comma-delimited, double-quoted, header row present — same convention as
 * the BYO-CSV upload, so this reuses the same `splitCsvLine`. Not committed
 * to the repo — `data/raw/` is gitignored — because Kaggle (the only known
 * distribution point) is unreachable from every build session this project
 * has run in, so there is no `fetch:benchrec` script the way there is for
 * Berka; the files were supplied directly by the project owner. See
 * `DATA.md`.
 */

import { splitCsvLine } from '../../util/csv'
import type { BenchRecRow, SolutionRow } from './types'

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/** Maps a header row to field-indexed row objects — robust to column reordering. */
function parseWithHeader<T extends Record<string, string>>(text: string, fieldNames: (keyof T)[]): T[] {
  const rows = lines(text)
  const header = splitCsvLine(rows.shift() ?? '')
  const indexOf = new Map(header.map((h, i) => [h, i]))

  return rows.map((line) => {
    const fields = splitCsvLine(line)
    const row = {} as T
    for (const name of fieldNames) {
      const idx = indexOf.get(name as string)
      row[name] = (idx !== undefined ? (fields[idx] ?? '') : '') as T[keyof T]
    }
    return row
  })
}

const BENCHREC_FIELDS: (keyof BenchRecRow)[] = [
  'matchId',
  'matchDate',
  'matchRule',
  'matchedBy',
  'wasPreviouslyMismatched',
  'A_transactionType',
  'A_id',
  'A_allocation',
  'A_importDate',
  'A_debitOrCredit',
  'A_amount',
  'A_valueDate',
  'A_currencyCode',
  'A_account',
  'A_transactionReferences',
  'A_transactionAttributes',
  'B_transactionType',
  'B_id',
  'B_importDate',
  'B_debitOrCredit',
  'B_amount',
  'B_valueDate',
  'B_currencyCode',
  'B_account',
  'B_transactionReferences',
  'B_transactionAttributes',
  'targetAllocation',
]

export function parseBenchRecRows(text: string): BenchRecRow[] {
  return parseWithHeader<BenchRecRow>(text, BENCHREC_FIELDS)
}

export function parseSolutionRows(text: string): SolutionRow[] {
  const rows = lines(text)
  const header = splitCsvLine(rows.shift() ?? '')
  const indexOf = new Map(header.map((h, i) => [h, i]))
  return rows.map((line) => {
    const fields = splitCsvLine(line)
    return {
      B_id: fields[indexOf.get('B_id') ?? 0] ?? '',
      targetAllocation: fields[indexOf.get('targetAllocation') ?? 1] ?? '',
      usage: fields[indexOf.get('Usage') ?? 2] ?? '',
    }
  })
}

/**
 * Reads and parses `train.csv`, `eval.csv`, and `solution.csv` from
 * `data/raw/benchrec/`, throwing a clear error if they're absent. Unlike
 * Berka there is no automated fetch step — see the module doc.
 */
export async function loadBenchRecFromDisk(
  dir: string,
): Promise<{ train: BenchRecRow[]; evalRows: BenchRecRow[]; solution: SolutionRow[] }> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const read = async (name: string) => {
    const p = path.join(dir, name)
    try {
      return await fs.readFile(p, 'utf8')
    } catch {
      throw new Error(
        `BenchRec data not found at ${p}. Place the Kaggle download's CSVs in data/raw/benchrec/ ` +
          `(BenchRec_cash_v1.0_train.csv, BenchRec_cash_v1.0_eval.csv, BenchRec_cash_v1.0_solution.csv) — ` +
          `there is no automated fetch for this one, see DATA.md.`,
      )
    }
  }

  const [trainText, evalText, solutionText] = await Promise.all([
    read('BenchRec_cash_v1.0_train.csv'),
    read('BenchRec_cash_v1.0_eval.csv'),
    read('BenchRec_cash_v1.0_solution.csv'),
  ])

  return {
    train: parseBenchRecRows(trainText),
    evalRows: parseBenchRecRows(evalText),
    solution: parseSolutionRows(solutionText),
  }
}
