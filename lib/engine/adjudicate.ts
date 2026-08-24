/**
 * Tier 4 — LLM adjudication.
 *
 * Only the genuinely ambiguous residual reaches here: whatever tiers 1-3
 * (exact, fuzzy, optimal assignment) could not resolve above the accept
 * threshold. The agent gets the same investigation tools a human controller
 * would reach for — `fx.convert`, `calendar.isBusinessDay`, `bank.lookupIFSC`,
 * `ledger.search` — and two decision tools it must eventually call:
 * `propose_match` or `flag_exception`. The system prompt is explicit that
 * refusing to guess is the correct outcome, not a failure — a wrong
 * auto-approved match is the expensive, invisible failure mode this whole
 * project exists to avoid.
 *
 * This module must NOT import `lib/datasets/truth` or `lib/datasets/berka/truth`
 * — enforced by `tests/truth-isolation.test.ts`, same rule as `pipeline.ts`.
 */

import type { CanonicalRecord } from '../datasets/canonical'
import { formatMinor } from '../datasets/canonical'
import type { Candidate } from './match'
import type { MatchConfig } from './config'
import type { ExceptionReason } from './types'
import type { LLMClient, LLMMessage, LLMToolDef } from '../llm/client'
import { estimateCostUsd } from '../llm/client'
import { GROQ_PRICING } from '../llm/groq'
import { getTool } from '../tools/registry'
import '../tools/index' // ensures fx.convert / calendar.isBusinessDay / bank.lookupIFSC are registered
import { LEDGER_SEARCH_TOOL_DEF, searchLedger, type LedgerSearchInput } from '../tools/enrich/ledgerSearch'
import type { OnProgress } from './progress'

export type ResidualCase = {
  ledger: CanonicalRecord
  /** Already scored and sorted by `buildCandidates`, highest confidence first. */
  candidates: Candidate[]
}

export type AgentResult =
  | {
      outcome: 'matched'
      ledgerId: string
      paymentId: string
      confidence: number
      rationale: string
      toolsCalled: string[]
      tokensUsed: number
      promptTokens: number
      completionTokens: number
      latencyMs: number
    }
  | {
      outcome: 'exception'
      ledgerId: string
      reason: ExceptionReason
      rationale: string
      toolsCalled: string[]
      tokensUsed: number
      promptTokens: number
      completionTokens: number
      latencyMs: number
    }
  | { outcome: 'not_reached'; ledgerId: string }

const EXCEPTION_REASONS: ExceptionReason[] = [
  'orphan',
  'low_confidence',
  'ambiguous_multiple_candidates',
  'fee_math_break',
  'fx_unresolved',
  'duplicate_suspected',
  'invalid_bank_details',
]

const PROPOSE_MATCH: LLMToolDef = {
  name: 'propose_match',
  description:
    'Conclude that this invoice matches a specific candidate payment. Only call this if you are genuinely confident — an incorrect match here is far worse than declining.',
  parameters: {
    type: 'object',
    required: ['paymentId', 'confidence', 'rationale'],
    properties: {
      paymentId: { type: 'string', description: 'The id of the payment you are matching to.' },
      confidence: { type: 'number', description: '0 to 1. Be honest, not optimistic.' },
      rationale: { type: 'string', description: 'One or two sentences a controller could audit.' },
    },
  },
}

const FLAG_EXCEPTION: LLMToolDef = {
  name: 'flag_exception',
  description:
    'Conclude that this invoice should NOT be auto-matched. This is the correct, expected outcome when you are not confident — call it rather than guessing.',
  parameters: {
    type: 'object',
    required: ['reason', 'rationale'],
    properties: {
      reason: { type: 'string', enum: EXCEPTION_REASONS },
      rationale: { type: 'string', description: 'What you checked and why it did not resolve.' },
    },
  },
}

function buildSystemPrompt(): string {
  return [
    'You are a reconciliation adjudicator for an AI Finance Controller. You review',
    'ONE unresolved invoice at a time against candidate settlement payments that',
    'automated matching could not confidently resolve on its own.',
    '',
    'Rules:',
    '1. A wrong auto-approved match is far more costly than an honest exception —',
    '   it is invisible until month-end close or an audit. An exception is checked',
    '   immediately. When in doubt, call flag_exception. That is success, not failure.',
    '2. Investigate before deciding. Use the tools available: check whether an',
    "   apparently-late settlement lands on a bank holiday, verify a counterparty's",
    '   IFSC, convert a foreign-currency amount, or search the ledger more broadly',
    '   than the pre-computed candidates.',
    '3. You must end by calling exactly one of propose_match or flag_exception.',
    '4. Never invent a payment id, a bank holiday, an exchange rate, or a fact you',
    '   have not actually retrieved from a tool call or the given data.',
  ].join('\n')
}

function describeCase(c: ResidualCase): string {
  const inv = c.ledger
  const lines = [
    `Invoice ${inv.id}: ${formatMinor(inv.amount, inv.currency)} ${inv.currency}, dated ${inv.date}`,
    `  counterparty: ${inv.counterparty ?? '(unknown)'}`,
    `  memo: ${inv.memo ?? '(none)'}`,
    `  ifsc: ${inv.ifsc ?? '(none)'}`,
    '',
    `Candidate payments (top ${Math.min(5, c.candidates.length)} by automated score):`,
  ]
  for (const cand of c.candidates.slice(0, 5)) {
    lines.push(
      `  - ${cand.payment.id}: ${formatMinor(cand.payment.amount, cand.payment.currency)}, ` +
        `${cand.payment.date}, memo "${cand.payment.memo ?? ''}" ` +
        `(automated confidence ${cand.confidence.toFixed(2)}: ${cand.evidence.join('; ')})`,
    )
  }
  if (c.candidates.length === 0) lines.push('  (none — no candidate cleared even the noise floor)')
  return lines.join('\n')
}

async function executeInvestigationTool(
  name: string,
  argsJson: string,
  payments: CanonicalRecord[],
): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson)
  } catch {
    return JSON.stringify({ error: 'malformed arguments JSON' })
  }

  if (name === 'ledger.search') {
    const hits = searchLedger(payments, args as LedgerSearchInput)
    return JSON.stringify({ mode: 'internal', results: hits })
  }

  const tool = getTool(name)
  if (!tool) return JSON.stringify({ error: `unknown tool ${name}` })

  // preferLive intentionally omitted (defaults false): the pipeline always
  // runs on fixture data, same reasoning as tier 0 normalization — a
  // benchmark run must not change its own numbers depending on network state.
  const result = await tool.handler(args)
  return JSON.stringify(result)
}

const MAX_TURNS = 4

async function adjudicateOne(
  residual: ResidualCase,
  payments: CanonicalRecord[],
  client: LLMClient,
): Promise<AgentResult> {
  const investigationTools: LLMToolDef[] = [
    getTool('fx.convert')?.schema && {
      name: 'fx.convert',
      description: getTool('fx.convert')!.description,
      parameters: getTool('fx.convert')!.schema,
    },
    getTool('calendar.isBusinessDay')?.schema && {
      name: 'calendar.isBusinessDay',
      description: getTool('calendar.isBusinessDay')!.description,
      parameters: getTool('calendar.isBusinessDay')!.schema,
    },
    getTool('bank.lookupIFSC')?.schema && {
      name: 'bank.lookupIFSC',
      description: getTool('bank.lookupIFSC')!.description,
      parameters: getTool('bank.lookupIFSC')!.schema,
    },
    LEDGER_SEARCH_TOOL_DEF,
  ].filter((t): t is LLMToolDef => Boolean(t))

  const allTools = [...investigationTools, PROPOSE_MATCH, FLAG_EXCEPTION]

  const messages: LLMMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: describeCase(residual) },
  ]

  const toolsCalled: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let latencyMs = 0
  // Bundles the running totals so every return site carries the same fields
  // without five copies of the same five-key object to keep in sync by hand.
  const meta = () => ({
    toolsCalled,
    tokensUsed: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    latencyMs,
  })

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let completion
    try {
      completion = await client.complete(messages, allTools)
    } catch (err) {
      // A network failure or API error mid-run must not take down the whole
      // reconciliation — decline this one record and let the rest proceed.
      return {
        outcome: 'exception',
        ledgerId: residual.ledger.id,
        reason: 'low_confidence',
        rationale: `Agent call failed: ${err instanceof Error ? err.message : String(err)}`,
        ...meta(),
      }
    }
    promptTokens += completion.usage.promptTokens
    completionTokens += completion.usage.completionTokens
    latencyMs += completion.latencyMs

    if (completion.toolCalls.length === 0) {
      // Model returned prose with no decision — nudge it once rather than
      // silently treating an empty turn as a match or an exception.
      messages.push({ role: 'assistant', content: completion.content })
      messages.push({
        role: 'user',
        content: 'You must call propose_match or flag_exception to conclude.',
      })
      continue
    }

    messages.push({ role: 'assistant', content: completion.content, toolCalls: completion.toolCalls })

    const decision = completion.toolCalls.find(
      (tc) => tc.name === 'propose_match' || tc.name === 'flag_exception',
    )

    if (decision) {
      let args: Record<string, unknown>
      try {
        args = JSON.parse(decision.argumentsJson)
      } catch {
        // Malformed decision arguments — treat as a declined match rather than
        // crash the run or guess at a payment id.
        return {
          outcome: 'exception',
          ledgerId: residual.ledger.id,
          reason: 'low_confidence',
          rationale: 'Agent returned malformed decision arguments.',
          ...meta(),
        }
      }

      if (decision.name === 'propose_match') {
        const paymentId = String(args.paymentId ?? '')
        const exists = residual.candidates.some((c) => c.payment.id === paymentId)
        if (!exists) {
          // The model named a payment that was never offered to it — refuse
          // rather than trust an unverifiable id.
          return {
            outcome: 'exception',
            ledgerId: residual.ledger.id,
            reason: 'low_confidence',
            rationale: `Agent proposed ${paymentId}, which was not among the candidates shown to it.`,
            ...meta(),
          }
        }
        return {
          outcome: 'matched',
          ledgerId: residual.ledger.id,
          paymentId,
          confidence: Math.max(0, Math.min(1, Number(args.confidence) || 0)),
          rationale: String(args.rationale ?? ''),
          ...meta(),
        }
      }

      const reason = EXCEPTION_REASONS.includes(args.reason as ExceptionReason)
        ? (args.reason as ExceptionReason)
        : 'low_confidence'
      return {
        outcome: 'exception',
        ledgerId: residual.ledger.id,
        reason,
        rationale: String(args.rationale ?? ''),
        ...meta(),
      }
    }

    // Investigation calls only — execute each and feed results back.
    for (const tc of completion.toolCalls) {
      toolsCalled.push(tc.name)
      const result = await executeInvestigationTool(tc.name, tc.argumentsJson, payments)
      messages.push({ role: 'tool', toolCallId: tc.id, content: result })
    }
  }

  // Exhausted MAX_TURNS without a decision — decline rather than guess.
  return {
    outcome: 'exception',
    ledgerId: residual.ledger.id,
    reason: 'low_confidence',
    rationale: `Agent did not reach a decision within ${MAX_TURNS} tool-calling turns.`,
    ...meta(),
  }
}

export type AdjudicationSummary = {
  results: AgentResult[]
  totalTokens: number
  estimatedCostUsd: number
  latencies: number[]
}

/**
 * Runs the agent over up to `maxRecords` residual cases, highest automated
 * confidence first — the cases closest to the threshold are both the cheapest
 * to resolve and the most valuable to escalate. Anything beyond the cap comes
 * back `not_reached` and falls through to ordinary exception classification,
 * same as if the agent tier did not exist for that record.
 */
export async function runAdjudication(
  residuals: ResidualCase[],
  payments: CanonicalRecord[],
  client: LLMClient,
  cfg: Pick<MatchConfig, 'maxAgentRecords'>,
  onProgress?: OnProgress,
): Promise<AdjudicationSummary> {
  const ordered = [...residuals].sort(
    (a, b) => (b.candidates[0]?.confidence ?? 0) - (a.candidates[0]?.confidence ?? 0),
  )
  const cap = cfg.maxAgentRecords ?? 20
  const toProcess = ordered.slice(0, cap)
  const notReached = ordered.slice(cap)

  const results: AgentResult[] = []
  // Sequential, not Promise.all: free-tier rate limits (~30 RPM) make
  // concurrent calls counterproductive, and it keeps the touch order the
  // audit trail reports deterministic. That sequencing is also what makes
  // agent-progress events meaningful — each one reflects a real completed
  // network round-trip, not a simulated tick.
  for (let i = 0; i < toProcess.length; i++) {
    results.push(await adjudicateOne(toProcess[i], payments, client))
    onProgress?.({ kind: 'agent-progress', index: i + 1, total: toProcess.length })
  }
  for (const r of notReached) {
    results.push({ outcome: 'not_reached', ledgerId: r.ledger.id })
  }

  const withUsage = results.filter(
    (r): r is Extract<AgentResult, { outcome: 'matched' | 'exception' }> => r.outcome !== 'not_reached',
  )
  const promptTokens = withUsage.reduce((s, r) => s + r.promptTokens, 0)
  const completionTokens = withUsage.reduce((s, r) => s + r.completionTokens, 0)
  const totalTokens = promptTokens + completionTokens
  const latencies = withUsage.map((r) => r.latencyMs)

  return {
    results,
    totalTokens,
    // Input and output tokens priced separately — output runs 4x input at the
    // verified Groq rate, so collapsing both into one bucket would understate
    // cost by roughly that factor whenever a run leans on longer rationales.
    estimatedCostUsd: estimateCostUsd({ promptTokens, completionTokens, totalTokens }, GROQ_PRICING),
    latencies,
  }
}
