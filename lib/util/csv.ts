/**
 * Shared quote-aware CSV line splitter — used by both the user-facing BYO-CSV
 * adapter (`lib/datasets/csvAdapter.ts`) and the BenchRec loader
 * (`lib/datasets/benchrec/loader.ts`), which is comma-delimited with the same
 * double-quote-escaping convention despite being a completely different
 * dataset. One parser, not two copies to keep in sync.
 */

/** Splits one CSV line respecting double-quoted fields that may contain commas. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  fields.push(cur)
  return fields.map((f) => f.trim())
}
