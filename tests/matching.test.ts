import { describe, expect, it } from 'vitest'
import {
  extractIdentifiers,
  isValidIfsc,
  jaroWinkler,
  normalizeRef,
  scoreStrings,
} from '@/lib/engine/strings'
import { scoreAmount, scoreDate } from '@/lib/engine/match'
import { DEFAULT_CONFIG } from '@/lib/engine/config'
import {
  addBusinessDays,
  businessDaysBetween,
  daysBetween,
  IN_FIXED_HOLIDAYS_2026,
  isBusinessDay,
} from '@/lib/util/dates'
import { convertToInr } from '@/lib/tools/enrich/fx'

const HOLIDAYS = [...IN_FIXED_HOLIDAYS_2026]

describe('identifier extraction', () => {
  it('pulls UTR, IFSC and invoice ref out of a real-shaped narration', () => {
    const id = extractIdentifiers('NEFT-HDFC0001234-ACME CORP PVT LTD-INV2841-PAYMENT')
    expect(id.ifscs).toEqual(['HDFC0001234'])
    expect(id.invoiceRefs).toEqual(['INV2841'])
    expect(id.residual).toContain('ACME CORP PVT LTD')
    // Noise words are stripped so they cannot inflate the token-set score.
    expect(id.residual).not.toContain('PAYMENT')
  })

  it('extracts a UTR', () => {
    expect(extractIdentifiers('N452683498705921 SETTLEMENT').utrs).toEqual([
      'N452683498705921',
    ])
  })

  it('normalizes reference separators', () => {
    expect(normalizeRef('INV-2841')).toBe('INV2841')
    expect(normalizeRef('inv 2841')).toBe('INV2841')
  })

  it('rejects a malformed IFSC — the 5th character must be a zero', () => {
    expect(isValidIfsc('HDFC0000001')).toBe(true)
    expect(isValidIfsc('KKBKX000789')).toBe(false)
    expect(isValidIfsc(undefined)).toBe(false)
  })
})

describe('jaro-winkler', () => {
  it('scores identical strings 1', () => {
    expect(jaroWinkler('RAMESH', 'RAMESH')).toBe(1)
  })

  it('tolerates a transposition', () => {
    expect(jaroWinkler('RAMESH', 'RAMSEH')).toBeGreaterThan(0.9)
  })

  it('rewards a shared prefix over a shared suffix', () => {
    expect(jaroWinkler('INV2841', 'INV2814')).toBeGreaterThan(jaroWinkler('INV2841', 'XYZ2841'))
  })

  it('scores unrelated strings low', () => {
    expect(jaroWinkler('ACME', 'ZZZZZZ')).toBeLessThan(0.5)
  })
})

describe('three-stage string scoring', () => {
  it('scores a reordered narration highly — token order must not matter', () => {
    const a = { memo: 'NEFT-HDFC0000001-ACME CORP PVT LTD-INV2841' }
    const b = { memo: 'NEFT-INV2841-PAYMENT-ACME CORP PVT LTD-HDFC0000001' }
    expect(scoreStrings(a, b).total).toBeGreaterThan(0.9)
  })

  it('still scores well when a reference is typo\'d on one side', () => {
    const a = { reference: 'INV-2133', counterparty: 'KAVERI FOODS PVT LTD' }
    const b = { reference: 'INV-1233', counterparty: 'KAVERI FOODS PVT LTD' }
    const s = scoreStrings(a, b)
    expect(s.identifier).toBeGreaterThan(0.8)
    expect(s.identifier).toBeLessThan(1)
  })

  it('does not penalise a record for a reference nobody quoted', () => {
    // Absent evidence is not contradicting evidence: with no reference on
    // either side, a perfect counterparty match should still score highly.
    const a = { counterparty: 'ORION SOFTWARE LABS', memo: 'ORION SOFTWARE LABS' }
    const b = { counterparty: 'ORION SOFTWARE LABS', memo: 'N123456789012345 SETTLEMENT ORION SOFTWARE LABS' }
    expect(scoreStrings(a, b).total).toBeGreaterThan(0.9)
  })

  it('scores different counterparties low', () => {
    const a = { counterparty: 'ACME CORP', memo: 'ACME CORP' }
    const b = { counterparty: 'NIMBUS RETAIL', memo: 'NIMBUS RETAIL' }
    expect(scoreStrings(a, b).total).toBeLessThan(0.6)
  })
})

describe('amount scoring', () => {
  it('scores an exact amount 1', () => {
    expect(scoreAmount(15000000n, 15000000n, 0.5).score).toBe(1)
  })

  it('tolerates FX rounding of a few paisa', () => {
    expect(scoreAmount(15000000n, 14999960n, 0.5).score).toBeGreaterThan(0.99)
  })

  it('scores 0 beyond tolerance, so the candidate can be gated out', () => {
    expect(scoreAmount(15000000n, 12000000n, 0.5).score).toBe(0)
  })
})

describe('holiday-aware date maths', () => {
  it('knows 2026-10-02 (Gandhi Jayanti) is a Friday holiday', () => {
    // A weekday holiday is required for this class to do any work at all:
    // Independence Day 2026 falls on a Saturday and adds no delay beyond the
    // weekend, which would make the holiday-aware ablation row show no gain.
    expect(new Date('2026-10-02T00:00:00Z').getUTCDay()).toBe(5)
    expect(isBusinessDay('2026-10-02', HOLIDAYS)).toBe(false)
  })

  it('skips the holiday and the weekend when adding business days', () => {
    // Thu 2026-10-01 + 2 business days: Fri is the holiday, Sat/Sun weekend,
    // so it lands on Tue 2026-10-06.
    expect(addBusinessDays('2026-10-01', 2, HOLIDAYS)).toBe('2026-10-06')
  })

  it('is the difference between a false exception and an on-time settlement', () => {
    const invoice = '2026-10-01'
    const settled = '2026-10-06'
    expect(daysBetween(invoice, settled)).toBe(5)
    // Naive (weekends only) sees 3 business days — outside a T+2 window.
    expect(businessDaysBetween(invoice, settled, [])).toBe(3)
    // Holiday-aware sees exactly 2 — on time.
    expect(businessDaysBetween(invoice, settled, HOLIDAYS)).toBe(2)
  })

  it('scores an on-time settlement 1 with awareness on, and lower with it off', () => {
    const aware = scoreDate('2026-10-01', '2026-10-06', {
      ...DEFAULT_CONFIG,
      enableHolidayAwareness: true,
    })
    const naive = scoreDate('2026-10-01', '2026-10-06', {
      ...DEFAULT_CONFIG,
      enableHolidayAwareness: false,
    })
    expect(aware.score).toBe(1)
    expect(naive.score).toBeLessThan(1)
  })

  it('rejects a settlement dated before its invoice', () => {
    expect(scoreDate('2026-10-06', '2026-10-01', DEFAULT_CONFIG).score).toBe(0)
  })
})

describe('fx conversion', () => {
  it('is a no-op for the base currency', () => {
    const r = convertToInr(15000000n, 'INR', '2026-10-01')
    expect(r.amount).toBe(15000000n)
    expect(r.resolved).toBe(true)
  })

  it('round-trips within a fraction of a percent', () => {
    const inr = 15000000n
    const usd = BigInt(Math.round(Number(inr) / 87.42))
    const back = convertToInr(usd, 'USD', '2026-10-01')
    const driftPct = (Math.abs(Number(back.amount - inr)) / Number(inr)) * 100
    expect(driftPct).toBeLessThan(0.01)
  })

  it('reports an unknown pair as unresolved rather than inventing a rate', () => {
    const r = convertToInr(1000n, 'XYZ', '2026-10-01')
    expect(r.resolved).toBe(false)
    expect(r.rate).toBe(0)
  })
})
