import { NextResponse } from 'next/server'
import { toolStatusReport } from '@/lib/tools'

export const dynamic = 'force-dynamic'

export async function GET() {
  const tools = await toolStatusReport()
  return NextResponse.json({ tools })
}
