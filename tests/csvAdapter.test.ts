import { describe, expect, it } from 'vitest'
import { parseCsvBatch } from '@/lib/datasets/csvAdapter'
import { reconcile } from '@/lib/engine/pipeline'

const VALID_CSV = [
  'source,id,date,amount,currency,reference,counterparty,memo,parentId,fees,tax,ifsc',
  'bank,bank_1,2026-09-05,9704.00,INR,UTR100,,NEFT credit,,,,',
  'settlement,pay_1,2026-09-05,9704.00,INR,INV-1,ACME CORP,settlement for INV-1,UTR100,200.00,36.00,',
  'ledger,INV-1,2026-09-01,9940.00,INR,INV-1,ACME CORP,,,,,',
].join('\n')

describe('parseCsvBatch', () => {
  it('parses a well-formed canonical CSV into the three sources without loss', () => {
    const result = parseCsvBatch(VALID_CSV)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.batch.bank).toHaveLength(1)
    expect(result.batch.settlements).toHaveLength(1)
    expect(result.batch.ledger).toHaveLength(1)

    const ledgerRow = result.batch.ledger[0]
    expect(ledgerRow.id).toBe('INV-1')
    expect(ledgerRow.amount).toBe(994000n) // 9940.00 -> paisa, exact bigint
    expect(ledgerRow.currency).toBe('INR')
    expect(ledgerRow.reference).toBe('INV-1')
    expect(ledgerRow.counterparty).toBe('ACME CORP')

    const settlementRow = result.batch.settlements[0]
    expect(settlementRow.fees).toBe(20000n)
    expect(settlementRow.tax).toBe(3600n)
    expect(settlementRow.parentId).toBe('UTR100')
  })

  it('retains the original row in raw, for the audit trail', () => {
    const result = parseCsvBatch(VALID_CSV)
    if (!result.ok) throw new Error('expected ok')
    expect(result.batch.ledger[0].raw.id).toBe('INV-1')
    expect(result.batch.ledger[0].raw.amount).toBe('9940.00')
  })

  it('a parsed batch runs through the real pipeline unchanged — the engine is dataset-blind', async () => {
    const result = parseCsvBatch(VALID_CSV)
    if (!result.ok) throw new Error('expected ok')
    const recon = await reconcile(result.batch)
    expect(recon.matches.length + recon.exceptions.length).toBeGreaterThan(0)
  })

  it('rejects a file missing a required column, with a specific message', () => {
    const csv = 'id,date,amount,currency\nx,2026-09-01,10.00,INR'
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('source')
  })

  it('rejects an unknown source value rather than guessing', () => {
    const csv = 'source,id,date,amount,currency\nwallet,x,2026-09-01,10.00,INR'
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('source')
  })

  it('rejects a non-ISO date rather than guessing the format', () => {
    const csv = 'source,id,date,amount,currency\nbank,x,09/01/2026,10.00,INR'
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('date')
  })

  it('rejects a malformed amount rather than silently truncating it', () => {
    const csv = 'source,id,date,amount,currency\nbank,x,2026-09-01,not-a-number,INR'
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('amount')
  })

  it('rejects a duplicate id within the same source', () => {
    const csv = [
      'source,id,date,amount,currency',
      'ledger,INV-1,2026-09-01,10.00,INR',
      'ledger,INV-1,2026-09-02,20.00,INR',
    ].join('\n')
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('duplicate')
  })

  it('rejects an empty file', () => {
    expect(parseCsvBatch('').ok).toBe(false)
  })

  it('rejects a header-only file with no data rows', () => {
    const result = parseCsvBatch('source,id,date,amount,currency')
    expect(result.ok).toBe(false)
  })

  it('handles a quoted field containing a comma', () => {
    const csv = [
      'source,id,date,amount,currency,memo',
      'bank,b1,2026-09-01,10.00,INR,"NEFT, ref 123"',
    ].join('\n')
    const result = parseCsvBatch(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.batch.bank[0].memo).toBe('NEFT, ref 123')
  })
})
