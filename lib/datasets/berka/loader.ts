/**
 * Parser for the real Berka / PKDD'99 Czech bank dataset.
 *
 * Files are `;`-delimited, quoted, CRLF-terminated. Not committed to the repo —
 * `data/raw/` is gitignored — so `npm run fetch:berka` downloads them first
 * (see `scripts/fetch-berka.ts`).
 */

import { toMinor } from '../canonical'
import type { OrderRow, TransRow } from './types'

/** Split one line on `;`, stripping the surrounding quotes each field carries. */
function splitFields(line: string): string[] {
  return line.split(';').map((f) => f.replace(/^"|"$/g, '').trim())
}

/** Berka dates are YYMMDD with a two-digit year, all falling in 1993-1999. */
export function parseBerkaDate(yymmdd: string): string {
  const s = yymmdd.trim()
  const yy = Number(s.slice(0, 2))
  const mm = s.slice(2, 4)
  const dd = s.slice(4, 6)
  const year = 1900 + yy
  return `${year}-${mm}-${dd}`
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

export function parseOrders(text: string): OrderRow[] {
  const rows = lines(text)
  rows.shift() // header
  return rows.map((line) => {
    const [orderId, accountId, bankTo, accountTo, amount, kSymbol] = splitFields(line)
    return { orderId, accountId, bankTo, accountTo, amount: toMinor(amount), kSymbol }
  })
}

export function parseTrans(text: string): TransRow[] {
  const rows = lines(text)
  rows.shift() // header
  return rows.map((line) => {
    const [transId, accountId, date, type, operation, amount, balance, kSymbol, bank, account] =
      splitFields(line)
    return {
      transId,
      accountId,
      date: parseBerkaDate(date),
      type: type as TransRow['type'],
      operation,
      amount: toMinor(amount),
      balance: toMinor(balance),
      kSymbol,
      bank,
      account,
    }
  })
}

/** Reads and parses both files from `data/raw/berka/`, throwing a clear error if absent. */
export async function loadBerkaFromDisk(dir: string): Promise<{ orders: OrderRow[]; trans: TransRow[] }> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const read = async (name: string) => {
    const p = path.join(dir, name)
    try {
      return await fs.readFile(p, 'utf8')
    } catch {
      throw new Error(
        `Berka data not found at ${p}. Run "npm run fetch:berka" first (downloads ~67MB).`,
      )
    }
  }

  const [orderText, transText] = await Promise.all([read('order.asc'), read('trans.asc')])
  return { orders: parseOrders(orderText), trans: parseTrans(transText) }
}
