#!/usr/bin/env node
/**
 * Simply Cashify as an MCP server — so Claude Desktop (or any MCP client)
 * can run and inspect a reconciliation the same way the dashboard does.
 *
 * Reuses the exact same engine and API-layer code the Next.js app calls —
 * `runReconciliation` (lib/api/run.ts), `runReconciliationFromBatch` for
 * BYO-CSV, `buildContext`/`templateAnswer` (lib/qa/answer.ts) — rather than
 * reimplementing any of it. A dashboard run, a CLI benchmark run
 * (scripts/bench.ts), and an MCP tool call all go through the identical
 * reconciliation logic; only the presentation layer differs.
 *
 * stdio transport: this is a local server Claude Desktop spawns as a
 * subprocess, not a hosted remote service — see the MCP TypeScript SDK docs
 * on transport selection.
 *
 * Runs are held in memory, keyed by runId, for the lifetime of this server
 * process — `reconcile_batch` creates one, the other three tools read it.
 * There is no persistence across server restarts, same as the dashboard has
 * no persistence across page reloads: a run is a snapshot of one
 * reconciliation, not a database record.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { runReconciliation, runReconciliationFromBatch, type RunPayload, type UploadRunPayload } from '../lib/api/run'
import { parseCsvBatch } from '../lib/datasets/csvAdapter'
import { buildContext, templateAnswer } from '../lib/qa/answer'

type StoredRun =
  | { kind: 'generated'; payload: RunPayload }
  | { kind: 'uploaded'; payload: UploadRunPayload }

const runs = new Map<string, StoredRun>()

function getRun(runId: string): StoredRun {
  const run = runs.get(runId)
  if (!run) {
    throw new Error(
      `No run found with id "${runId}". Call reconcile_batch (or upload_and_reconcile) first — it returns the runId this tool needs.`,
    )
  }
  return run
}

const server = new McpServer({ name: 'simply-cashify-mcp-server', version: '1.0.0' })

// ---------------------------------------------------------------- reconcile_batch

const ReconcileBatchInput = z
  .object({
    seed: z
      .number()
      .int()
      .optional()
      .describe('Seed for the synthetic generator. Omit for a random batch each call.'),
    invoiceCount: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe('Roughly how many invoices to generate (default ~180). Capped at 2000.'),
  })
  .strict()
type ReconcileBatchInput = z.infer<typeof ReconcileBatchInput>

server.registerTool(
  'reconcile_batch',
  {
    title: 'Reconcile a batch',
    description: `Generate a synthetic Razorpay-shaped batch (bank statement + settlement report + internal ledger) and run the full reconciliation pipeline against it — exact match, fuzzy match, optimal assignment, and LLM adjudication if GROQ_API_KEY is set, plus a 6-rung ablation sweep and a precision-gated auto-clear score.

This is the same generator and pipeline the dashboard's "Run reconciliation" button uses (lib/api/run.ts) — not a separate implementation.

Args:
  - seed (number, optional): reproducible batch seed. Omit for a random batch.
  - invoiceCount (number, optional): roughly how many invoices, 1-2000. Default ~180.

Returns a summary and a runId. Pass that runId to list_exceptions, explain_exception, or get_cash_position to inspect this specific run — the full per-record detail is not returned here to keep the response small; ask for it by runId instead.

Error Handling:
  - Returns an error message (not a thrown exception the client can't read) if the pipeline itself fails.`,
    inputSchema: ReconcileBatchInput.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params: ReconcileBatchInput) => {
    try {
      const payload = await runReconciliation({ seed: params.seed, invoiceCount: params.invoiceCount })
      runs.set(payload.runId, { kind: 'generated', payload })

      const op = payload.report.operating
      const output = {
        runId: payload.runId,
        seed: payload.seed,
        recordCount: payload.stats.recordCount,
        matchedCount: payload.matches.length,
        exceptionCount: payload.exceptions.length,
        autoClearRate: op.autoClearRate,
        precision: op.precision,
        precisionTarget: payload.report.precisionTarget,
        ceiling: payload.ceiling,
        agentTier: payload.agentTier,
        throughputRecordsPerSec: payload.stats.recordsPerSecond,
      }
      const text =
        `Reconciled ${output.recordCount} records (seed ${output.seed}, run ${output.runId}).\n` +
        `${output.matchedCount} matched, ${output.exceptionCount} exceptions.\n` +
        `Auto-clears ${(output.autoClearRate * 100).toFixed(1)}% at ${(output.precision * 100).toFixed(1)}% precision ` +
        `(target ${(output.precisionTarget * 100).toFixed(1)}%; honest ceiling ${(output.ceiling * 100).toFixed(1)}% — true orphans can never be matched).\n` +
        `Agent tier: ${output.agentTier}.\n` +
        `Use runId "${output.runId}" with list_exceptions, explain_exception, or get_cash_position.`

      return { content: [{ type: 'text' as const, text }], structuredContent: output }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: reconciliation failed — ${error instanceof Error ? error.message : String(error)}` }] }
    }
  },
)

// ---------------------------------------------------------- upload_and_reconcile

const UploadInput = z
  .object({
    csv: z
      .string()
      .min(1)
      .describe(
        'Full CSV content, one row per record, with a header including source,id,date,amount,currency (source is bank/settlement/ledger). See lib/datasets/csvAdapter.ts.',
      ),
  })
  .strict()
type UploadInput = z.infer<typeof UploadInput>

server.registerTool(
  'upload_and_reconcile',
  {
    title: 'Reconcile an uploaded CSV batch',
    description: `Parse a hand-supplied CSV (same canonical format the dashboard's drop zone accepts) and run it through the identical reconciliation pipeline as reconcile_batch.

An uploaded batch has no ground truth, so there is no precision/auto-clear score for it — only what the engine actually decided (matches, exceptions, a cash forecast). Fabricating an accuracy number against an unknown answer key would be dishonest; see UploadRunPayload's doc comment in lib/api/run.ts.

Args:
  - csv (string): full CSV text, header row required: source,id,date,amount,currency,... (source is bank/settlement/ledger).

Returns a summary and a runId — same follow-up tools as reconcile_batch.

Error Handling:
  - Returns a specific, actionable error (e.g. "row 4: 'date' must be ISO 8601") rather than a generic failure when the CSV is malformed — never guesses at a format it wasn't given.`,
    inputSchema: UploadInput.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params: UploadInput) => {
    const parsed = parseCsvBatch(params.csv)
    if (!parsed.ok) {
      return { content: [{ type: 'text' as const, text: `Error: ${parsed.error}` }] }
    }
    try {
      const payload = await runReconciliationFromBatch(parsed.batch)
      runs.set(payload.runId, { kind: 'uploaded', payload })

      const output = {
        runId: payload.runId,
        recordCounts: payload.recordCounts,
        matchedCount: payload.matches.length,
        exceptionCount: payload.exceptions.length,
        agentTier: payload.agentTier,
      }
      const text =
        `Reconciled the uploaded batch (${output.recordCounts.bank} bank, ${output.recordCounts.settlements} settlement, ` +
        `${output.recordCounts.ledger} ledger rows; run ${output.runId}).\n` +
        `${output.matchedCount} matched, ${output.exceptionCount} exceptions. No ground truth for uploaded data, so no accuracy score.\n` +
        `Use runId "${output.runId}" with list_exceptions, explain_exception, or get_cash_position.`

      return { content: [{ type: 'text' as const, text }], structuredContent: output }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: reconciliation failed — ${error instanceof Error ? error.message : String(error)}` }] }
    }
  },
)

// -------------------------------------------------------------- list_exceptions

const ListExceptionsInput = z
  .object({
    runId: z.string().min(1).describe('A runId returned by reconcile_batch or upload_and_reconcile.'),
    reason: z
      .enum([
        'orphan',
        'low_confidence',
        'ambiguous_multiple_candidates',
        'fee_math_break',
        'fx_unresolved',
        'duplicate_suspected',
        'invalid_bank_details',
      ])
      .optional()
      .describe('Filter to one exception reason. Omit to list all.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max exceptions to return.'),
    offset: z.number().int().min(0).default(0).describe('Number to skip, for pagination.'),
  })
  .strict()
type ListExceptionsInput = z.infer<typeof ListExceptionsInput>

server.registerTool(
  'list_exceptions',
  {
    title: 'List exceptions from a run',
    description: `List the exceptions from a reconciliation run — every row the engine would not auto-approve, each with a typed reason and a plain-language explanation.

Args:
  - runId (string, required): from reconcile_batch or upload_and_reconcile.
  - reason (string, optional): filter to one of orphan / low_confidence / ambiguous_multiple_candidates / fee_math_break / fx_unresolved / duplicate_suspected / invalid_bank_details.
  - limit (number, optional): max results, 1-200, default 50.
  - offset (number, optional): pagination offset, default 0.

Returns:
  { total, count, offset, exceptions: [{ id, reason, summary, amount }], has_more, next_offset }

Error Handling:
  - Returns "No run found with id ..." if runId is unknown or expired (this server holds runs in memory only for its own process lifetime).`,
    inputSchema: ListExceptionsInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params: ListExceptionsInput) => {
    try {
      const run = getRun(params.runId)
      let exceptions = run.payload.exceptions
      if (params.reason) exceptions = exceptions.filter((e) => e.reason === params.reason)

      const total = exceptions.length
      const page = exceptions.slice(params.offset, params.offset + params.limit)
      const output = {
        total,
        count: page.length,
        offset: params.offset,
        exceptions: page.map((e) => ({
          id: e.id,
          reason: e.reason,
          summary: e.controllerSummary,
          amount: e.record?.amount ?? null,
        })),
        has_more: total > params.offset + page.length,
        ...(total > params.offset + page.length ? { next_offset: params.offset + page.length } : {}),
      }

      const lines = [`${total} exception(s)${params.reason ? ` (reason: ${params.reason})` : ''}, showing ${page.length}:`]
      for (const e of output.exceptions) lines.push(`- ${e.id} [${e.reason}]: ${e.summary}`)
      if (output.has_more) lines.push(`(more available — call again with offset ${output.next_offset})`)

      return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: output }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
    }
  },
)

// ------------------------------------------------------------ explain_exception

const ExplainExceptionInput = z
  .object({
    runId: z.string().min(1).describe('A runId returned by reconcile_batch or upload_and_reconcile.'),
    recordId: z.string().min(1).describe('An invoice or payment id from that run, e.g. "INV-2841" or "pay_2841".'),
  })
  .strict()
type ExplainExceptionInput = z.infer<typeof ExplainExceptionInput>

server.registerTool(
  'explain_exception',
  {
    title: 'Explain one record\'s decision',
    description: `Explain exactly how one record (matched or exception) was resolved — same grounded answer the dashboard's Settlement Q&A card and decision drawer give, built from the actual audit trail, never invented.

Args:
  - runId (string, required): from reconcile_batch or upload_and_reconcile.
  - recordId (string, required): an invoice or payment id that actually exists in that run.

Returns:
  { recordId, outcome: "matched"|"exception"|"unknown", explanation }

Error Handling:
  - If recordId does not exist in this run, explanation says so plainly rather than guessing — this tool structurally cannot answer about a record that isn't in the run.`,
    inputSchema: ExplainExceptionInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params: ExplainExceptionInput) => {
    try {
      const run = getRun(params.runId)
      // RunPayload and UploadRunPayload share the same shape for the fields
      // buildContext/templateAnswer need (matches, exceptions, decisions), so
      // both branches can reuse the exact dashboard Q&A logic unmodified.
      const ctx = buildContext(run.payload as RunPayload, params.recordId)
      const explanation = templateAnswer(ctx)
      const output = { recordId: params.recordId, outcome: ctx.outcome, explanation }
      const text = [explanation.headline, ...explanation.points.map((p) => `- ${p}`)].join('\n')
      return { content: [{ type: 'text' as const, text }], structuredContent: output }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
    }
  },
)

// ----------------------------------------------------------- get_cash_position

const GetCashPositionInput = z
  .object({ runId: z.string().min(1).describe('A runId returned by reconcile_batch or upload_and_reconcile.') })
  .strict()
type GetCashPositionInput = z.infer<typeof GetCashPositionInput>

server.registerTool(
  'get_cash_position',
  {
    title: 'Get the 13-week cash forecast',
    description: `Get the cash position forecast for a reconciled run — 13 weekly buckets, not a calendar. Week 0 is confirmed cash from matched invoices; later weeks project the run's own unresolved exceptions forward using a collection lag learned from that run's matches. See lib/forecast/cash.ts for the stated honesty limits (this is a linear-band heuristic, not a fitted model, and "today" is the latest date the batch saw, not a real wall clock).

Args:
  - runId (string, required): from reconcile_batch or upload_and_reconcile.

Returns:
  { asOf, collectionLagDays, lagSampleSize, confirmed, openReceivables, weeks: [{ weekIndex, weekStart, confirmed, projected, cumulative, bandLow, bandHigh }] }`,
    inputSchema: GetCashPositionInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params: GetCashPositionInput) => {
    try {
      const run = getRun(params.runId)
      const f = run.payload.cashForecast
      const output = {
        asOf: f.asOf,
        collectionLagDays: f.collectionLagDays,
        lagSampleSize: f.lagSampleSize,
        confirmed: f.confirmedMinor,
        openReceivables: f.openReceivablesMinor,
        weeks: f.weeks.map((w) => ({
          weekIndex: w.weekIndex,
          weekStart: w.weekStart,
          confirmed: w.confirmed,
          projected: w.projected,
          cumulative: w.cumulative,
          bandLow: w.bandLow,
          bandHigh: w.bandHigh,
        })),
      }
      const lines = [
        `As of ${f.asOf} — confirmed ${f.confirmedMinor}, open receivables ${f.openReceivablesMinor} ` +
          `(lag ${f.collectionLagDays}d from ${f.lagSampleSize} matched invoices).`,
      ]
      for (const w of output.weeks) {
        lines.push(`wk ${w.weekIndex} (${w.weekStart}): cumulative ${w.cumulative} [${w.bandLow} – ${w.bandHigh}]`)
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: output }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Simply Cashify MCP server running on stdio')
}

main().catch((error) => {
  console.error('MCP server error:', error)
  process.exit(1)
})
