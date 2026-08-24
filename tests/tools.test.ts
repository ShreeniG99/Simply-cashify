import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/lib/tools/index' // registers fx.convert, calendar.isBusinessDay, bank.lookupIFSC
import { getTool, listTools, toolStatusReport } from '@/lib/tools/registry'
import type { FxToolInput, FxToolOutput } from '@/lib/tools/enrich/fx'
import type { CalendarToolInput, CalendarToolOutput } from '@/lib/tools/enrich/calendar'
import type { IfscToolInput, IfscInfo } from '@/lib/tools/enrich/ifsc'
import { convertToInr, FX_FIXTURE } from '@/lib/tools/enrich/fx'
import { CALENDAR_FIXTURE_IN_2026 } from '@/lib/tools/enrich/calendar'
import { IN_FIXED_HOLIDAYS_2026, isBusinessDay } from '@/lib/util/dates'
import { IFSC_FIXTURE } from '@/lib/tools/enrich/ifsc'
import { attemptLive } from '@/lib/tools/fixtures/cassette'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('registry', () => {
  it('registers all three step-3 connectors', () => {
    const names = listTools().map((t) => t.name)
    expect(names).toContain('fx.convert')
    expect(names).toContain('calendar.isBusinessDay')
    expect(names).toContain('bank.lookupIFSC')
  })

  it('every tool exposes a JSON-schema-shaped input description', () => {
    for (const tool of listTools()) {
      expect(tool.schema.type).toBe('object')
      expect(Array.isArray(tool.schema.required)).toBe(true)
    }
  })

  it('a duplicate registration is rejected rather than silently overwritten', async () => {
    const { registerTool } = await import('@/lib/tools/registry')
    expect(() =>
      registerTool({
        name: 'fx.convert',
        description: 'dup',
        schema: { type: 'object' },
        handler: async () => ({ mode: 'fixture', data: null }),
        status: async () => 'fixture',
      }),
    ).toThrow(/already registered/)
  })
})

describe('attemptLive — the shared fallback primitive', () => {
  it('reports success when the underlying call succeeds', async () => {
    const r = await attemptLive(async () => 42)
    expect(r).toEqual({ ok: true, value: 42 })
  })

  it('reports failure rather than throwing when the call rejects', async () => {
    const r = await attemptLive(async () => {
      throw new Error('CONNECT tunnel failed, response 403')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('403')
  })
})

describe('fx.convert', () => {
  it('the sync fast-path and the async tool read the same fixture', async () => {
    const sync = convertToInr(100000n, 'USD', '2026-10-01')
    const tool = getTool<FxToolInput, FxToolOutput>('fx.convert')!
    const result = await tool.handler({ amountMinor: '100000', currency: 'USD', date: '2026-10-01' })
    expect(result.mode).toBe('fixture')
    expect(result.data!.amountMinor).toBe(sync.amount.toString())
    expect(result.data!.rate).toBe(FX_FIXTURE.USD)
  })

  it('declines an unknown currency rather than inventing a rate', async () => {
    const tool = getTool<FxToolInput, FxToolOutput>('fx.convert')!
    const result = await tool.handler({ amountMinor: '1000', currency: 'XYZ', date: '2026-10-01' })
    expect(result.data).toBeNull()
    expect(result.reason).toMatch(/no fixture rate/i)
  })

  it('is a no-op for INR at 1:1', async () => {
    const tool = getTool<FxToolInput, FxToolOutput>('fx.convert')!
    const result = await tool.handler({ amountMinor: '5000', currency: 'INR', date: '2026-10-01' })
    expect(result.data!.rate).toBe(1)
    expect(result.data!.amountMinor).toBe('5000')
  })

  it('reports mode "live" and uses the live rate when preferLive succeeds', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rates: { INR: 99.99 } }),
    })) as unknown as typeof fetch

    const tool = getTool<FxToolInput, FxToolOutput>('fx.convert')!
    const result = await tool.handler({
      amountMinor: '100000',
      currency: 'USD',
      date: '2026-10-01',
      preferLive: true,
    })
    expect(result.mode).toBe('live')
    expect(result.data!.rate).toBe(99.99)
  })

  it('falls back to fixture, honestly labeled, when the live call fails', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('CONNECT tunnel failed, response 403')
    }) as unknown as typeof fetch

    const tool = getTool<FxToolInput, FxToolOutput>('fx.convert')!
    const result = await tool.handler({
      amountMinor: '100000',
      currency: 'USD',
      date: '2026-10-01',
      preferLive: true,
    })
    expect(result.mode).toBe('fixture')
    expect(result.data!.rate).toBe(FX_FIXTURE.USD)
  })
})

describe('calendar.isBusinessDay', () => {
  it('shares the exact holiday array the sync engine uses — not merely equal values', () => {
    // Same reference, not a copy: an edit to one is guaranteed to reach the
    // other rather than silently drifting apart.
    expect(CALENDAR_FIXTURE_IN_2026).toBe(IN_FIXED_HOLIDAYS_2026)
  })

  it('agrees with the sync fast-path on the Gandhi Jayanti weekday holiday', async () => {
    const tool = getTool<CalendarToolInput, CalendarToolOutput>('calendar.isBusinessDay')!
    const result = await tool.handler({ date: '2026-10-02' })
    expect(result.data!.isBusinessDay).toBe(false)
    expect(result.data!.isHoliday).toBe(true)
    expect(result.data!.isBusinessDay).toBe(isBusinessDay('2026-10-02', IN_FIXED_HOLIDAYS_2026))
  })

  it('agrees on an ordinary weekday', async () => {
    const tool = getTool<CalendarToolInput, CalendarToolOutput>('calendar.isBusinessDay')!
    const result = await tool.handler({ date: '2026-09-30' }) // Wednesday
    expect(result.data!.isBusinessDay).toBe(true)
  })

  it('correctly identifies a weekend as non-business without calling it a holiday', async () => {
    const tool = getTool<CalendarToolInput, CalendarToolOutput>('calendar.isBusinessDay')!
    // 2026-10-03 is a Saturday.
    const result = await tool.handler({ date: '2026-10-03' })
    expect(result.data!.isWeekend).toBe(true)
    expect(result.data!.isHoliday).toBe(false)
    expect(result.data!.isBusinessDay).toBe(false)
  })

  it('declines a country it has no fixture for, rather than assuming no holidays', async () => {
    const tool = getTool<CalendarToolInput, CalendarToolOutput>('calendar.isBusinessDay')!
    const result = await tool.handler({ date: '2026-10-02', countryCode: 'FR' })
    expect(result.data).toBeNull()
  })

  it('uses the live holiday list when preferLive succeeds', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{ date: '2026-12-25', types: ['Public'] }],
    })) as unknown as typeof fetch

    const tool = getTool<CalendarToolInput, CalendarToolOutput>('calendar.isBusinessDay')!
    const result = await tool.handler({ date: '2026-12-25', preferLive: true })
    expect(result.mode).toBe('live')
    expect(result.data!.isHoliday).toBe(true)
  })
})

describe('bank.lookupIFSC', () => {
  it('finds every code the generator uses', async () => {
    const tool = getTool<IfscToolInput, IfscInfo>('bank.lookupIFSC')!
    for (const code of Object.keys(IFSC_FIXTURE)) {
      const result = await tool.handler({ ifsc: code })
      expect(result.data, code).not.toBeNull()
      expect(result.data!.bank.length).toBeGreaterThan(0)
    }
  })

  it('declines a structurally malformed code before even checking the fixture', async () => {
    const tool = getTool<IfscToolInput, IfscInfo>('bank.lookupIFSC')!
    const result = await tool.handler({ ifsc: 'KKBKX000789' }) // the wrong_ifsc class shape
    expect(result.data).toBeNull()
    expect(result.reason).toMatch(/not a structurally valid/i)
  })

  it('declines a well-formed but unrecorded code rather than guessing a bank', async () => {
    const tool = getTool<IfscToolInput, IfscInfo>('bank.lookupIFSC')!
    const result = await tool.handler({ ifsc: 'ABCD0999999' })
    expect(result.data).toBeNull()
  })

  it('is honestly labeled fixture, not upgraded to live, even for a successful fixture hit', async () => {
    const tool = getTool<IfscToolInput, IfscInfo>('bank.lookupIFSC')!
    const result = await tool.handler({ ifsc: 'HDFC0000001' })
    expect(result.mode).toBe('fixture')
  })
})

describe('toolStatusReport', () => {
  it('reports every registered tool without throwing, using real (blocked) egress', async () => {
    // No fetch mock here — exercises the actual attemptLive() -> real network
    // path in this sandboxed session, which is expected to fail and fall back.
    const report = await toolStatusReport()
    expect(report.length).toBeGreaterThanOrEqual(3)
    for (const r of report) {
      expect(['live', 'fixture', 'unconfigured']).toContain(r.mode)
    }
  })
})
