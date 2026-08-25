/**
 * BYO-CSV adapter — the proof that "adding a dataset means writing one
 * adapter, not touching the engine" is a real architectural claim, not a
 * slide bullet.
 *
 * A single CSV, one row per record, three sources distinguished by a
 * `source` column: `bank`, `settlement`, `ledger`. Anyone can hand this app
 * their own batch without touching a line of matching code — the pipeline
 * only ever sees `CanonicalRecord[]`, however it arrived.
 *
 * What this deliberately is NOT: a bank-statement-format detector. Real bank
 * exports vary wildly (NEFT vs IMPS narration shapes, different column
 * orders per bank) and guessing a raw export's layout is exactly the kind of
 * silent-fabrication this project refuses elsewhere. This adapter requires
 * the canonical column names; malformed input is a typed error shown to the
 * uploader, never a best-effort guess.
 *
 * Honesty limit worth stating plainly: an uploaded batch has no ground
 * truth. There is no answer key to score matches against, so a run built
 * from this adapter reports what the engine decided — matches, exceptions,
 * tier breakdown, decisions — but never a precision/recall claim. See
 * `runReconciliationFromCsv` in `lib/api/run.ts`.
 */

import { toMinor, type CanonicalBatch, type CanonicalRecord, type SourceKind } from './canonical'
import { splitCsvLine } from '../util/csv'

const REQUIRED_COLUMNS = ['source', 'id', 'date', 'amount', 'currency'] as const
const OPTIONAL_COLUMNS = [
  'reference',
  'counterparty',
  'memo',
  'parentId',
  'fees',
  'tax',
  'ifsc',
] as const
const SOURCES: SourceKind[] = ['bank', 'settlement', 'ledger']

export type CsvParseResult = { ok: true; batch: CanonicalBatch } | { ok: false; error: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseCsvBatch(csvText: string, datasetId = 'uploaded'): CsvParseResult {
  const lines = csvText.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) {
    return { ok: false, error: 'The file is empty.' }
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length > 0) {
    return { ok: false, error: `Missing required column(s): ${missing.join(', ')}.` }
  }
  const colIndex = new Map(header.map((h, i) => [h, i]))

  const bank: CanonicalRecord[] = []
  const settlements: CanonicalRecord[] = []
  const ledger: CanonicalRecord[] = []
  const seenIds = new Set<string>()
  let baseCurrency: string | null = null

  for (let lineNo = 1; lineNo < lines.length; lineNo++) {
    const fields = splitCsvLine(lines[lineNo])
    const get = (col: string): string | undefined => {
      const idx = colIndex.get(col)
      if (idx === undefined) return undefined
      const v = fields[idx]
      return v === undefined || v === '' ? undefined : v
    }
    const where = `row ${lineNo + 1}`

    const source = get('source')
    if (!source || !SOURCES.includes(source as SourceKind)) {
      return { ok: false, error: `${where}: "source" must be one of ${SOURCES.join('/')}, got "${source ?? ''}".` }
    }
    const id = get('id')
    if (!id) return { ok: false, error: `${where}: "id" is required.` }
    if (seenIds.has(`${source}:${id}`)) {
      return { ok: false, error: `${where}: duplicate id "${id}" for source "${source}".` }
    }
    seenIds.add(`${source}:${id}`)

    const date = get('date')
    if (!date || !ISO_DATE.test(date)) {
      return { ok: false, error: `${where}: "date" must be ISO 8601 (YYYY-MM-DD), got "${date ?? ''}".` }
    }

    const amountRaw = get('amount')
    if (amountRaw === undefined || !/^-?\d+(\.\d{1,2})?$/.test(amountRaw)) {
      return { ok: false, error: `${where}: "amount" must be a plain number like 1234.56, got "${amountRaw ?? ''}".` }
    }
    const amount = toMinor(amountRaw)

    const currency = get('currency')
    if (!currency) return { ok: false, error: `${where}: "currency" is required.` }
    if (baseCurrency === null) baseCurrency = currency.toUpperCase()

    const feesRaw = get('fees')
    const taxRaw = get('tax')
    if (feesRaw !== undefined && !/^\d+(\.\d{1,2})?$/.test(feesRaw)) {
      return { ok: false, error: `${where}: "fees" must be a non-negative number, got "${feesRaw}".` }
    }
    if (taxRaw !== undefined && !/^\d+(\.\d{1,2})?$/.test(taxRaw)) {
      return { ok: false, error: `${where}: "tax" must be a non-negative number, got "${taxRaw}".` }
    }

    const record: CanonicalRecord = {
      id,
      source: source as SourceKind,
      date,
      amount,
      currency: currency.toUpperCase(),
      reference: get('reference'),
      counterparty: get('counterparty'),
      memo: get('memo'),
      parentId: get('parentId'),
      fees: feesRaw !== undefined ? toMinor(feesRaw) : undefined,
      tax: taxRaw !== undefined ? toMinor(taxRaw) : undefined,
      ifsc: get('ifsc'),
      raw: Object.fromEntries(header.map((h, i) => [h, fields[i]])),
    }

    if (source === 'bank') bank.push(record)
    else if (source === 'settlement') settlements.push(record)
    else ledger.push(record)
  }

  if (bank.length === 0 && settlements.length === 0 && ledger.length === 0) {
    return { ok: false, error: 'No data rows found.' }
  }

  return {
    ok: true,
    batch: { datasetId, baseCurrency: baseCurrency ?? 'INR', bank, settlements, ledger },
  }
}

export const CSV_TEMPLATE_HEADER = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(',')
