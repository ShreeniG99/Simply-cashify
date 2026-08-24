import { runReconciliation } from '@/lib/api/run'

export const dynamic = 'force-dynamic'

/**
 * Streams newline-delimited JSON: zero or more `{type:'progress', event}`
 * lines as the run actually executes (see lib/engine/progress.ts), then
 * exactly one `{type:'result', payload}` or `{type:'error', error}` line,
 * then the stream closes. A plain JSON response could only ever show a
 * static spinner for the run's full duration; this lets the dashboard show
 * which tier is running right now instead.
 */
export async function POST(request: Request) {
  let body: { seed?: number; invoiceCount?: number } = {}
  try {
    body = await request.json()
  } catch {
    // An empty body is fine — the seed is then chosen at random.
  }

  const seed =
    typeof body.seed === 'number' && Number.isFinite(body.seed)
      ? Math.floor(body.seed)
      : undefined
  const invoiceCount =
    typeof body.invoiceCount === 'number' && body.invoiceCount > 0
      ? Math.min(Math.floor(body.invoiceCount), 2000)
      : undefined

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'))
      try {
        const payload = await runReconciliation({ seed, invoiceCount }, (event) =>
          send({ type: 'progress', event }),
        )
        send({ type: 'result', payload })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reconciliation failed'
        send({ type: 'error', error: message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Disables buffering on the dev/proxy path so progress lines actually
      // arrive incrementally instead of all at once when the stream closes.
      'X-Accel-Buffering': 'no',
    },
  })
}
