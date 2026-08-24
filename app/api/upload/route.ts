import { NextResponse } from 'next/server'
import { parseCsvBatch } from '@/lib/datasets/csvAdapter'
import { runReconciliationFromBatch } from '@/lib/api/run'

export const dynamic = 'force-dynamic'

const MAX_CSV_BYTES = 5 * 1024 * 1024

export async function POST(request: Request) {
  let body: { csv?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request body.' }, { status: 400 })
  }

  if (typeof body.csv !== 'string' || body.csv.length === 0) {
    return NextResponse.json({ error: 'No CSV content received.' }, { status: 400 })
  }
  if (body.csv.length > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'File too large (5MB limit).' }, { status: 400 })
  }

  const parsed = parseCsvBatch(body.csv)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  try {
    const payload = await runReconciliationFromBatch(parsed.batch)
    return NextResponse.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reconciliation failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
