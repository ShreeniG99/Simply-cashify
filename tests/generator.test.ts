import { describe, expect, it } from 'vitest'
import { generate } from '@/lib/datasets/generate'
import { groupByBatch } from '@/lib/engine/types'
import { matchableCeiling } from '@/lib/datasets/truth'
import { recordCount, toMinor, formatMinor } from '@/lib/datasets/canonical'

const serialize = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val))

describe('generator', () => {
  it('is deterministic in both the data and the truth', () => {
    const a = generate({ seed: 7 })
    const b = generate({ seed: 7 })
    expect(serialize(a.batch)).toBe(serialize(b.batch))
    expect(serialize(a.truth)).toBe(serialize(b.truth))
  })

  it('produces different data for a different seed', () => {
    const a = generate({ seed: 7 })
    const b = generate({ seed: 8 })
    expect(serialize(a.batch)).not.toBe(serialize(b.batch))
  })

  it('clears the 50+ record bar comfortably', () => {
    const { batch } = generate({ seed: 1 })
    expect(recordCount(batch)).toBeGreaterThan(50)
    expect(batch.bank.length).toBeGreaterThan(0)
    expect(batch.settlements.length).toBeGreaterThan(0)
    expect(batch.ledger.length).toBeGreaterThan(0)
  })

  it('fee arithmetic reconciles exactly, in integer paisa', () => {
    const { batch } = generate({ seed: 3 })
    const batches = groupByBatch(batch.settlements)

    for (const [batchId, rows] of batches) {
      const gross = rows.filter((r) => r.amount > 0n).reduce((s, r) => s + r.amount, 0n)
      const refunds = rows.filter((r) => r.amount < 0n).reduce((s, r) => s + r.amount, 0n)
      const fees = rows.reduce((s, r) => s + (r.fees ?? 0n), 0n)
      const tax = rows.reduce((s, r) => s + (r.tax ?? 0n), 0n)

      const credit = batch.bank.find((b) => b.id === `bank_${batchId}`)
      expect(credit, `no bank credit for ${batchId}`).toBeDefined()
      // gross − fees − tax ± refunds = net credited, to the paisa.
      expect(gross + refunds - fees - tax).toBe(credit!.amount)
    }
  })

  it('leaves an honest ceiling below 100% — true orphans must stay unmatched', () => {
    const { truth } = generate({ seed: 5 })
    const ceiling = matchableCeiling(truth.pairs)
    expect(ceiling).toBeLessThan(1)
    expect(ceiling).toBeGreaterThan(0.7)
    expect(truth.classCounts.true_orphan).toBeGreaterThan(0)
  })

  it('injects every discrepancy class it claims to', () => {
    const { truth } = generate({ seed: 11 })
    for (const [cls, n] of Object.entries(truth.classCounts)) {
      expect(n, `class ${cls} was never injected`).toBeGreaterThan(0)
    }
  })

  it('does not leak the injected class into the records the pipeline sees', () => {
    const { batch } = generate({ seed: 13 })
    const all = [...batch.bank, ...batch.settlements, ...batch.ledger]
    const blob = serialize(all)
    for (const leak of ['injected_class', 'true_orphan', 'ambiguous_near_duplicate']) {
      expect(blob).not.toContain(leak)
    }
  })

  it('corrupts the reference FIELD for typo_reference, not just the memo', () => {
    // Corrupting only the narration would be inert: the matcher reads both, and
    // would find the pristine field.
    const { batch, truth } = generate({ seed: 17 })
    const byId = new Map(batch.ledger.map((l) => [l.id, l]))
    const typos = truth.pairs.filter((p) => p.class === 'typo_reference')
    expect(typos.length).toBeGreaterThan(0)
    const corrupted = typos.filter((p) => byId.get(p.ledgerId)!.reference !== p.ledgerId)
    expect(corrupted.length).toBe(typos.length)
  })

  it('withholds the invoice reference from hard classes on the settlement side', () => {
    // If every payment quoted its invoice number the task would be a dictionary
    // lookup, and the ambiguous class would not be ambiguous at all.
    const { batch, truth } = generate({ seed: 19 })
    const hard = truth.pairs.filter(
      (p) => p.class === 'ambiguous_near_duplicate' || p.class === 'holiday_delayed',
    )
    expect(hard.length).toBeGreaterThan(0)
    for (const p of hard) {
      for (const payId of p.paymentIds) {
        const pay = batch.settlements.find((s) => s.id === payId)!
        expect(pay.memo ?? '').not.toContain(p.ledgerId)
      }
    }
  })
})

describe('money formatting', () => {
  it('parses to minor units without going through a float', () => {
    expect(toMinor('1234.56')).toBe(123456n)
    expect(toMinor('1234')).toBe(123400n)
    expect(toMinor('-10.05')).toBe(-1005n)
    // The case that breaks naive float maths: 0.1 + 0.2
    expect(toMinor('0.1') + toMinor('0.2')).toBe(toMinor('0.3'))
  })

  it('groups Indian digits correctly', () => {
    expect(formatMinor(14646000n)).toBe('1,46,460.00')
    expect(formatMinor(100n)).toBe('1.00')
    expect(formatMinor(-50050n)).toBe('-500.50')
  })
})
