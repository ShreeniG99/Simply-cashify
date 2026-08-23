/**
 * Date helpers over ISO `YYYY-MM-DD` strings, in UTC throughout.
 *
 * Settlement windows are expressed in *business* days, so a settlement that
 * looks two days late is often exactly on time once weekends and bank holidays
 * are accounted for. Getting this wrong manufactures a whole class of false
 * exceptions — see the `holiday_delayed` discrepancy class.
 */

/**
 * Fixed-date Indian national holidays. These three do not move year to year.
 * The full list (including the lunar-calendar holidays) comes from the
 * Nager.Date connector, which carries a recorded cassette; this constant is the
 * floor used by the generator and by tests so they never depend on the network.
 */
export const IN_FIXED_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Gandhi Jayanti
] as const

export function parseISO(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function toISO(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  const d = parseISO(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return toISO(d)
}

/** 0 = Sunday, 6 = Saturday. */
export function dayOfWeek(iso: string): number {
  return parseISO(iso).getUTCDay()
}

export function isWeekend(iso: string): boolean {
  const d = dayOfWeek(iso)
  return d === 0 || d === 6
}

export function isBusinessDay(iso: string, holidays: readonly string[]): boolean {
  return !isWeekend(iso) && !holidays.includes(iso)
}

/** Advance by N business days, skipping weekends and the given holidays. */
export function addBusinessDays(
  iso: string,
  days: number,
  holidays: readonly string[],
): string {
  let cur = iso
  let remaining = days
  while (remaining > 0) {
    cur = addDays(cur, 1)
    if (isBusinessDay(cur, holidays)) remaining--
  }
  return cur
}

/** Whole calendar days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = parseISO(b).getTime() - parseISO(a).getTime()
  return Math.round(ms / 86_400_000)
}

/**
 * Business days between two ISO dates, exclusive of `a` and inclusive of `b`.
 * This is the measure a date-window tolerance should use, not `daysBetween`.
 */
export function businessDaysBetween(
  a: string,
  b: string,
  holidays: readonly string[],
): number {
  if (a === b) return 0
  const forward = parseISO(a) < parseISO(b)
  const [from, to] = forward ? [a, b] : [b, a]
  let count = 0
  let cur = from
  while (cur !== to) {
    cur = addDays(cur, 1)
    if (isBusinessDay(cur, holidays)) count++
  }
  return forward ? count : -count
}
