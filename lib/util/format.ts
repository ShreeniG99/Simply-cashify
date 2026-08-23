/** Shared percentage formatting so the CLI and the dashboard agree. */
export function pctString(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}
