import { NextResponse } from 'next/server'
import { runReconciliation } from '@/lib/api/run'

export const dynamic = 'force-dynamic'

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

  try {
    const payload = runReconciliation({ seed, invoiceCount })
    return NextResponse.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reconciliation failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
