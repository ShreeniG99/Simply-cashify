/**
 * Bank-holiday / business-day connector — the Nager.Date-shaped counterpart to
 * `lib/util/dates.ts`'s synchronous business-day math.
 *
 * The fixture here is `IN_FIXED_HOLIDAYS_2026`, imported directly rather than
 * duplicated, so the sync engine (tier 2's date scoring, tier A's tie-out
 * window) and this async tool (which step 4's agent calls to investigate an
 * apparently-late settlement) are PROVABLY the same three dates, not just
 * hopefully consistent. `tests/tools.test.ts` asserts the shared reference.
 *
 * Deliberately not extended with additional Indian holidays. India's
 * lunar-calendar holidays (Diwali, Holi, etc.) shift every year and I cannot
 * verify their 2026 dates without live access to the Nager.Date API or another
 * authoritative calendar from this build session. Inventing a plausible-looking
 * date and labeling it a real holiday would itself be exactly the kind of
 * fabrication this module exists to refuse, so the fixture only contains the
 * three fixed-date holidays that are verifiable by the Gregorian calendar
 * alone (checked directly against the day-of-week, not asserted on faith).
 */

import { IN_FIXED_HOLIDAYS_2026, isBusinessDay, isWeekend } from '../../util/dates'
import { registerTool, type ToolResult } from '../registry'
import { attemptLive } from '../fixtures/cassette'

export const CALENDAR_FIXTURE_IN_2026: readonly string[] = IN_FIXED_HOLIDAYS_2026

type NagerHoliday = { date: string; types?: string[] }

async function fetchLiveHolidays(year: number, countryCode: string): Promise<string[]> {
  const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`)
  if (!res.ok) throw new Error(`Nager.Date ${res.status}`)
  const body = (await res.json()) as NagerHoliday[]
  return body.map((h) => h.date)
}

export type CalendarToolInput = {
  date: string
  countryCode?: string
  preferLive?: boolean
}
export type CalendarToolOutput = {
  isBusinessDay: boolean
  isWeekend: boolean
  isHoliday: boolean
}

async function handleIsBusinessDay(input: CalendarToolInput): Promise<ToolResult<CalendarToolOutput>> {
  const country = input.countryCode ?? 'IN'
  const weekend = isWeekend(input.date)

  if (input.preferLive) {
    const year = Number(input.date.slice(0, 4))
    const attempt = await attemptLive(() => fetchLiveHolidays(year, country))
    if (attempt.ok) {
      const holiday = attempt.value.includes(input.date)
      return {
        mode: 'live',
        data: { isBusinessDay: !weekend && !holiday, isWeekend: weekend, isHoliday: holiday },
      }
    }
    // Fall through to the fixture.
  }

  if (country !== 'IN') {
    return { mode: 'fixture', data: null, reason: `No fixture holiday calendar recorded for ${country}` }
  }

  const holiday = CALENDAR_FIXTURE_IN_2026.includes(input.date)
  return {
    mode: 'fixture',
    data: {
      isBusinessDay: isBusinessDay(input.date, CALENDAR_FIXTURE_IN_2026),
      isWeekend: weekend,
      isHoliday: holiday,
    },
  }
}

registerTool<CalendarToolInput, CalendarToolOutput>({
  name: 'calendar.isBusinessDay',
  description:
    'Check whether a date is a bank business day in a given country — accounts for weekends and public holidays. Use this before flagging a settlement as late.',
  schema: {
    type: 'object',
    required: ['date'],
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      countryCode: { type: 'string', description: 'ISO 3166-1 alpha-2, defaults to IN.' },
    },
  },
  handler: handleIsBusinessDay,
  status: async () => {
    const attempt = await attemptLive(() => fetchLiveHolidays(2026, 'IN'))
    return attempt.ok ? 'live' : 'fixture' // keyless: never unconfigured
  },
})
