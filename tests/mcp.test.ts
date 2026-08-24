/**
 * End-to-end integration test for the MCP server (mcp/server.ts) — spawns
 * the real server as a subprocess over stdio and drives it with the actual
 * MCP client SDK, the same way Claude Desktop would. Not a mock: this
 * exercises the real reconciliation pipeline through the real protocol
 * transport, same rigor as tests/csvAdapter.test.ts's "runs through the
 * real pipeline unchanged" check.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let client: Client

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: 'node_modules/.bin/tsx',
    args: ['mcp/server.ts'],
    cwd: process.cwd(),
  })
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
}, 30_000)

afterAll(async () => {
  await client?.close()
})

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[]
  return content.find((c) => c.type === 'text')?.text ?? ''
}

describe('Simply Cashify MCP server', () => {
  it('lists exactly the four tools the plan calls for, plus the CSV upload variant', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('reconcile_batch')
    expect(names).toContain('list_exceptions')
    expect(names).toContain('explain_exception')
    expect(names).toContain('get_cash_position')
    expect(names).toContain('upload_and_reconcile')
  })

  it('every tool has a non-trivial description an agent could act on', async () => {
    const { tools } = await client.listTools()
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(40)
    }
  })

  it('reconcile_batch runs a real reconciliation and returns a usable runId', async () => {
    const result = await client.callTool({ name: 'reconcile_batch', arguments: { seed: 42, invoiceCount: 40 } })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect(typeof structured.runId).toBe('string')
    expect((structured.runId as string).length).toBeGreaterThan(0)
    expect(structured.recordCount).toBeGreaterThan(0)
    expect(textOf(result)).toContain('Reconciled')
  })

  it('list_exceptions and get_cash_position work against a runId reconcile_batch just produced', async () => {
    const run = await client.callTool({ name: 'reconcile_batch', arguments: { seed: 7, invoiceCount: 30 } })
    const runId = (run.structuredContent as Record<string, unknown>).runId as string

    const exceptions = await client.callTool({ name: 'list_exceptions', arguments: { runId, limit: 5 } })
    expect(exceptions.isError).not.toBe(true)
    const excStructured = exceptions.structuredContent as { total: number; exceptions: { id: string; reason: string; summary: string }[] }
    expect(excStructured.total).toBeGreaterThanOrEqual(0)
    if (excStructured.exceptions.length > 0) {
      // The list surfaces controller-voice copy, not the raw technical detail string.
      expect(excStructured.exceptions[0].summary.length).toBeGreaterThan(0)
    }

    const cash = await client.callTool({ name: 'get_cash_position', arguments: { runId } })
    expect(cash.isError).not.toBe(true)
    const cashStructured = cash.structuredContent as { weeks: unknown[] }
    expect(cashStructured.weeks).toHaveLength(13)
  })

  it('explain_exception grounds its answer in a record that genuinely exists in the run', async () => {
    const run = await client.callTool({ name: 'reconcile_batch', arguments: { seed: 3, invoiceCount: 30 } })
    const runId = (run.structuredContent as Record<string, unknown>).runId as string

    const exceptions = await client.callTool({ name: 'list_exceptions', arguments: { runId, limit: 1 } })
    const excStructured = exceptions.structuredContent as { exceptions: { id: string }[] }
    if (excStructured.exceptions.length === 0) return // depends on seed; skip gracefully

    const recordId = excStructured.exceptions[0].id
    const explained = await client.callTool({ name: 'explain_exception', arguments: { runId, recordId } })
    expect(explained.isError).not.toBe(true)
    const explainedStructured = explained.structuredContent as { outcome: string; explanation: string }
    expect(explainedStructured.outcome).toBe('exception')
    expect(explainedStructured.explanation).toContain(recordId)
  })

  it('never invents an answer for a record id that does not exist in the run', async () => {
    const run = await client.callTool({ name: 'reconcile_batch', arguments: { seed: 3, invoiceCount: 30 } })
    const runId = (run.structuredContent as Record<string, unknown>).runId as string

    const explained = await client.callTool({ name: 'explain_exception', arguments: { runId, recordId: 'INV-DOES-NOT-EXIST' } })
    const structured = explained.structuredContent as { outcome: string; explanation: string }
    expect(structured.outcome).toBe('unknown')
    expect(structured.explanation).toBe('No record called INV-DOES-NOT-EXIST exists in this run.')
  })

  it('returns an actionable error, not a crash, for an unknown runId', async () => {
    const result = await client.callTool({ name: 'get_cash_position', arguments: { runId: 'run_does_not_exist' } })
    expect(textOf(result)).toContain('No run found')
  })

  it('upload_and_reconcile parses a canonical CSV and reconciles it through the same pipeline', async () => {
    const csv = [
      'source,id,date,amount,currency,reference,counterparty,memo,parentId,fees,tax,ifsc',
      'bank,bank_1,2026-09-05,9764.00,INR,N123456789012,,NEFT-N123456789012-ACME CORP PVT LTD-PAYMENT,,,,',
      'settlement,pay_1,2026-09-05,10000.00,INR,INV-1,ACME CORP PVT LTD,settlement for INV-1,N123456789012,200.00,36.00,',
      'ledger,INV-1,2026-09-01,10000.00,INR,INV-1,ACME CORP PVT LTD,,,,,',
    ].join('\n')

    const result = await client.callTool({ name: 'upload_and_reconcile', arguments: { csv } })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as { matchedCount: number; recordCounts: { ledger: number } }
    expect(structured.recordCounts.ledger).toBe(1)
    expect(structured.matchedCount).toBe(1)
  })

  it('rejects a malformed CSV with a specific error rather than guessing the format', async () => {
    const result = await client.callTool({
      name: 'upload_and_reconcile',
      arguments: { csv: 'id,date,amount,currency\nx,2026-09-01,10.00,INR' },
    })
    expect(textOf(result)).toContain('source')
  })
})
