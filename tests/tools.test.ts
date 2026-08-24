import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/lib/tools/index' // registers fx.convert, calendar.isBusinessDay, bank.lookupIFSC, slack.notify
import { getTool, listTools, toolStatusReport } from '@/lib/tools/registry'
import type { FxToolInput, FxToolOutput } from '@/lib/tools/enrich/fx'
import type { CalendarToolInput, CalendarToolOutput } from '@/lib/tools/enrich/calendar'
import type { IfscToolInput, IfscInfo } from '@/lib/tools/enrich/ifsc'
import type { SlackNotifyInput, SlackNotifyOutput } from '@/lib/tools/actions/slack'
import type { RazorpaySettlementsInput, RazorpaySettlementsOutput } from '@/lib/tools/actions/razorpay'
import { convertToInr, FX_FIXTURE } from '@/lib/tools/enrich/fx'
import { CALENDAR_FIXTURE_IN_2026 } from '@/lib/tools/enrich/calendar'
import { IN_FIXED_HOLIDAYS_2026, isBusinessDay } from '@/lib/util/dates'
import { IFSC_FIXTURE } from '@/lib/tools/enrich/ifsc'
import { attemptLive } from '@/lib/tools/fixtures/cassette'

const originalFetch = global.fetch
const originalSlackWebhook = process.env.SLACK_WEBHOOK_URL
const originalRazorpayKeyId = process.env.RAZORPAY_KEY_ID
const originalRazorpayKeySecret = process.env.RAZORPAY_KEY_SECRET

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
  if (originalSlackWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL
  else process.env.SLACK_WEBHOOK_URL = originalSlackWebhook
  if (originalRazorpayKeyId === undefined) delete process.env.RAZORPAY_KEY_ID
  else process.env.RAZORPAY_KEY_ID = originalRazorpayKeyId
  if (originalRazorpayKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET
  else process.env.RAZORPAY_KEY_SECRET = originalRazorpayKeySecret
})

describe('registry', () => {
  it('registers all three step-3 connectors plus the step-7/8 action tools', () => {
    const names = listTools().map((t) => t.name)
    expect(names).toContain('fx.convert')
    expect(names).toContain('calendar.isBusinessDay')
    expect(names).toContain('bank.lookupIFSC')
    expect(names).toContain('slack.notify')
    expect(names).toContain('razorpay.settlements.list')
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

describe('slack.notify', () => {
  it('reports unconfigured, not a failed attempt, when no webhook URL is set', async () => {
    delete process.env.SLACK_WEBHOOK_URL
    const tool = getTool<SlackNotifyInput, SlackNotifyOutput>('slack.notify')!
    const result = await tool.handler({ text: 'run finished' })
    expect(result.mode).toBe('unconfigured')
    expect(result.data).toBeNull()
    // Never even attempts a network call when there is nowhere configured to send it.
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    await tool.handler({ text: 'run finished' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts for real when a webhook URL is configured, and reports mode "live"', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/T000/B000/xxx'
    const fetchSpy = vi.fn(async () => ({ ok: true }))
    global.fetch = fetchSpy as unknown as typeof fetch

    const tool = getTool<SlackNotifyInput, SlackNotifyOutput>('slack.notify')!
    const result = await tool.handler({ text: 'INV-2841 flagged as an exception' })

    expect(result.mode).toBe('live')
    expect(result.data).toEqual({ posted: true })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://hooks.slack.test/T000/B000/xxx',
      expect.objectContaining({ method: 'POST' }),
    )
    const calls = fetchSpy.mock.calls as unknown as [string, RequestInit][]
    const body = JSON.parse(calls[0][1].body as string)
    expect(body.text).toBe('INV-2841 flagged as an exception')
  })

  it('reports the failure honestly, still labeled live (a real attempt was made), when the POST fails', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/T000/B000/xxx'
    global.fetch = vi.fn(async () => {
      throw new Error('CONNECT tunnel failed, response 403')
    }) as unknown as typeof fetch

    const tool = getTool<SlackNotifyInput, SlackNotifyOutput>('slack.notify')!
    const result = await tool.handler({ text: 'x' })
    expect(result.mode).toBe('live')
    expect(result.data).toBeNull()
    expect(result.reason).toContain('403')
  })

  it('status() never fires a live POST just to check — it would spam a real channel', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/T000/B000/xxx'
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    const tool = getTool<SlackNotifyInput, SlackNotifyOutput>('slack.notify')!
    const mode = await tool.status()
    expect(mode).toBe('live')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('razorpay.settlements.list', () => {
  const SAMPLE = {
    id: 'setl_ExxjcAzUYVzTz3',
    entity: 'settlement' as const,
    amount: 900000,
    fees: 41300,
    tax: 6300,
    utr: '1234567890',
    status: 'processed',
    created_at: 1534594421,
  }

  it('reports unconfigured, and never even attempts a call, when no credentials are set', async () => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch

    const tool = getTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>('razorpay.settlements.list')!
    const result = await tool.handler({})
    expect(result.mode).toBe('unconfigured')
    expect(result.data).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches for real when both credentials are set, and adapts the response to the canonical schema', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc'
    process.env.RAZORPAY_KEY_SECRET = 'shh'
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entity: 'collection', count: 1, items: [SAMPLE] }),
    }))
    global.fetch = fetchSpy as unknown as typeof fetch

    const tool = getTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>('razorpay.settlements.list')!
    const result = await tool.handler({ count: 5 })

    expect(result.mode).toBe('live')
    expect(result.data!.records).toHaveLength(1)
    const rec = result.data!.records[0]
    expect(rec.id).toBe('setl_ExxjcAzUYVzTz3')
    expect(rec.source).toBe('settlement')
    expect(rec.amount).toBe(900000n) // Razorpay's amount is already minor units
    expect(rec.fees).toBe(41300n)
    expect(rec.tax).toBe(6300n)
    expect(rec.reference).toBe('1234567890')
    expect(rec.currency).toBe('INR')

    // Sends Basic Auth built from the two env vars, not a bare key.
    const calls = fetchSpy.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0][0]).toContain('count=5')
    const authHeader = (calls[0][1].headers as Record<string, string>).Authorization
    expect(authHeader).toBe(`Basic ${Buffer.from('rzp_test_abc:shh').toString('base64')}`)
  })

  it('reports the failure honestly, still labeled live (credentials were configured), when the call fails', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc'
    process.env.RAZORPAY_KEY_SECRET = 'shh'
    global.fetch = vi.fn(async () => {
      throw new Error('CONNECT tunnel failed, response 403')
    }) as unknown as typeof fetch

    const tool = getTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>('razorpay.settlements.list')!
    const result = await tool.handler({})
    expect(result.mode).toBe('live')
    expect(result.data).toBeNull()
    expect(result.reason).toContain('403')
  })

  it('has no fixture mode at all — every result is live or unconfigured, never a fabricated settlement', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc'
    process.env.RAZORPAY_KEY_SECRET = 'shh'
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entity: 'collection', count: 1, items: [SAMPLE] }),
    })) as unknown as typeof fetch

    const tool = getTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>('razorpay.settlements.list')!
    const configured = await tool.handler({})
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    const unconfigured = await tool.handler({})
    expect([configured.mode, unconfigured.mode].sort()).toEqual(['live', 'unconfigured'])
  })

  it('status() reflects whether credentials are configured, without making a network call', async () => {
    delete process.env.RAZORPAY_KEY_ID
    delete process.env.RAZORPAY_KEY_SECRET
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as unknown as typeof fetch
    const tool = getTool<RazorpaySettlementsInput, RazorpaySettlementsOutput>('razorpay.settlements.list')!

    expect(await tool.status()).toBe('unconfigured')
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc'
    process.env.RAZORPAY_KEY_SECRET = 'shh'
    expect(await tool.status()).toBe('live')
    expect(fetchSpy).not.toHaveBeenCalled()
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
