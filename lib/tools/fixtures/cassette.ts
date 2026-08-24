/**
 * The live-attempt-with-fallback primitive every connector shares.
 *
 * Every connector in this project targets a keyless public API
 * (api.frankfurter.app, date.nager.at, ifsc.razorpay.com). From THIS build
 * environment's egress proxy, all three return a 403 policy denial — confirmed
 * by hand during planning and again here, not assumed. That is exactly the
 * failure this function exists to survive: `attemptLive` never throws past its
 * caller, so a connector degrades to its fixture instead of crashing a run.
 * On an unrestricted machine (the user's laptop, a Vercel deploy) the same
 * code path genuinely reaches the network and reports `mode: 'live'` — nothing
 * here is faked to look offline, the fallback exists because it is required,
 * not performed for show.
 *
 * `live` is also never attempted unless a caller explicitly opts in
 * (`preferLive: true`). Default is fixture, even when a network happens to be
 * available — see the historical-rate reasoning in `lib/tools/enrich/fx.ts`:
 * a benchmark run must not silently change its own numbers depending on
 * whether the network was up that day.
 */

export type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: string }

export async function attemptLive<T>(
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<AttemptResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 5000

  // Promise.race rather than AbortController: `fn` is a plain zero-argument
  // thunk with no signal to hand it, so an AbortController here would create
  // and arm a controller nothing ever reads — dead code that looks like a
  // working timeout but isn't. Racing against a timeout promise bounds our own
  // wait correctly regardless of whether the underlying call cooperates; the
  // abandoned call is left to resolve or reject on its own in the background,
  // which is an acceptable cost for a benchmark/demo tool belt.
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    const value = await Promise.race([fn(), timeout])
    return { ok: true, value }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer!)
  }
}

/**
 * Cheap reachability probe. Not currently used — each connector's `status()`
 * instead calls its own real `attemptLive` fetch, which is a more honest signal
 * than a bare HEAD request (a host can accept a HEAD and still fail the actual
 * API call). Kept for a future connector where a full call is too expensive to
 * run just to answer "is this live right now".
 */
export async function isReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  const result = await attemptLive(() => fetch(url, { method: 'HEAD' }), { timeoutMs })
  return result.ok && (result.value.ok || result.value.status < 500)
}
