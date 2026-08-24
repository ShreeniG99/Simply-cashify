/**
 * Settlement Q&A — RAG over the audit trail the pipeline already produces.
 *
 * "Why didn't INV-2841 settle?" should have a grounded answer built from the
 * DecisionRecord that record already carries, not a generic chatbot response.
 * So retrieval is literal and closed-world: the only record ids this can ever
 * answer about are ones that actually exist in the run just fetched. There is
 * no separate persistence layer — the client already holds the full
 * `RunPayload` after a run, and hands the relevant slice back.
 *
 * Same discipline as tier 4: an LLM polishes the answer's prose when a key is
 * configured, but the underlying facts come from `templateAnswer`, computed
 * without any model call, and used verbatim as the fallback whenever no key
 * exists or the live call fails. The LLM is told explicitly to use ONLY the
 * given context — this module structurally cannot answer with a fact that
 * isn't already in the record.
 */

import type { RunPayload } from '../api/run'
import type { DecisionRecord } from '../engine/types'
import type { LLMClient } from '../llm/client'

export type QAOutcome = 'matched' | 'exception' | 'unknown'

export type QAContext = {
  recordId: string
  outcome: QAOutcome
  match?: RunPayload['matches'][number]
  exception?: RunPayload['exceptions'][number]
  decision?: DecisionRecord
}

export type QAResult = {
  answer: string
  recordId: string | null
  mode: 'template' | 'llm'
}

/**
 * Finds a record id actually present in this run, by substring match against
 * the question — never a regex guess at what an id "should" look like. If the
 * question names nothing that exists in the run, this returns null rather
 * than answering about an invented id.
 */
export function findRecordId(question: string, run: RunPayload): string | null {
  const ids = new Set<string>()
  for (const m of run.matches) {
    ids.add(m.ledgerId)
    for (const p of m.paymentIds) ids.add(p)
  }
  for (const e of run.exceptions) ids.add(e.id)
  for (const d of run.decisions) {
    ids.add(d.subjectId)
    for (const alt of d.alternatives) for (const p of alt.paymentIds) ids.add(p)
  }

  const q = question.toLowerCase()
  let best: string | null = null
  for (const id of ids) {
    if (!id) continue
    if (q.includes(id.toLowerCase())) {
      // Prefer the longest match, so "INV-2093-DUP" wins over the "INV-2093"
      // it contains, when both are genuinely present in the run.
      if (!best || id.length > best.length) best = id
    }
  }
  return best
}

export function buildContext(run: RunPayload, recordId: string): QAContext {
  const match = run.matches.find((m) => m.ledgerId === recordId || m.paymentIds.includes(recordId))
  const exception = run.exceptions.find((e) => e.id === recordId)
  const decision = run.decisions.find((d) => d.subjectId === recordId)
  const outcome: QAOutcome = match ? 'matched' : exception ? 'exception' : 'unknown'
  return { recordId, outcome, match, exception, decision }
}

/**
 * Turns tool names into plain language — but the two tiers this can describe
 * are not the same kind of claim, and conflating them would overclaim.
 *
 * Tier 4's `toolsCalled` is a real per-record log: the agent invoked that
 * exact tool for that exact record, and `adjudicate.ts` recorded it after the
 * call returned. "It checked whether this date was a holiday" is true there.
 *
 * Tiers 1-3's `toolsCalled` (from `pipeline.ts`'s `toolsFor`) is a coarse
 * capability flag: it's set whenever holiday-awareness or FX normalization is
 * globally enabled for the run, regardless of whether THIS record's
 * comparison actually crossed a holiday or needed conversion — there is no
 * discrete call to log, since tiers 1-3 compute synchronously in-process.
 * Phrasing that as a specific, provable action ("it checked...") would be the
 * exact kind of fabrication this project exists to refuse elsewhere. So
 * `tier` selects between an event-level sentence (agent) and a capability-
 * level one (everything else).
 */
export function narrateTools(tools: string[], tier?: string): string | null {
  if (tools.length === 0) return null

  if (tier === 'agent') {
    const known: Record<string, string> = {
      'fx.convert': 'converted the amount at the historical exchange rate',
      'calendar.isBusinessDay': 'checked whether the settlement date fell on a bank holiday',
      'bank.lookupIFSC': "verified the counterparty's bank branch",
      'ledger.search': 'searched more broadly across the ledger than the automatic candidates',
    }
    const parts = tools.map((t) => known[t] ?? t)
    const verb = parts.length === 1 ? 'it' : 'it, in order,'
    return `To reach this conclusion, ${verb} ${parts.join('; then ')}.`
  }

  const capability: Record<string, string> = {
    'fx.convert': 'live FX normalization',
    'calendar.isBusinessDay': 'holiday-aware date scoring',
    'bank.lookupIFSC': 'IFSC validation',
    'ledger.search': 'broader ledger search',
  }
  const parts = [...new Set(tools.map((t) => capability[t] ?? t))]
  return `This tier runs with ${parts.join(' and ')} enabled for the batch — not a per-record lookup, since this decision was computed deterministically, not via a discrete tool call.`
}

/** The grounded answer, computed with no model call — the honest floor every answer can fall back to. */
export function templateAnswer(ctx: QAContext): string {
  if (ctx.outcome === 'unknown') {
    return `No record called ${ctx.recordId} exists in this run.`
  }

  const lines: string[] = []

  if (ctx.outcome === 'matched' && ctx.match) {
    const m = ctx.match
    lines.push(
      `${m.ledgerId} matched ${m.paymentIds.join(', ')} (${m.amount}) via the ${m.tier} tier ` +
        `at confidence ${m.confidence.toFixed(2)}.`,
    )
    lines.push(
      m.autoCleared
        ? 'It was auto-cleared — no human review needed.'
        : 'It scored below the auto-clear threshold, so it is routed for review despite being matched.',
    )
  } else if (ctx.outcome === 'exception' && ctx.exception) {
    const e = ctx.exception
    lines.push(`${e.id} is unresolved — reason: ${e.reason.replace(/_/g, ' ')}. ${e.detail}`)
    if (e.rationale && e.rationale !== e.detail) {
      lines.push(`Agent rationale: ${e.rationale}`)
    }
  }

  if (ctx.decision) {
    const d = ctx.decision
    if (d.evidence.length > 0) lines.push(`Evidence: ${d.evidence.join('; ')}.`)
    const toolNarration = narrateTools(d.toolsCalled, d.tier)
    if (toolNarration) lines.push(toolNarration)
    if (d.alternatives.length > 0) {
      const alts = d.alternatives
        .map((a) => `${a.paymentIds.join(', ')} (scored ${a.score} — ${a.rejectedBecause})`)
        .join('; ')
      lines.push(`Alternatives considered and rejected: ${alts}.`)
    }
  }

  return lines.join(' ')
}

const NO_ID_ANSWER =
  'I can only answer about a specific invoice or payment id from this run — ' +
  'mention one, for example "why didn\'t INV-2841 settle?"'

const SYSTEM_PROMPT = [
  'You explain reconciliation decisions to a finance controller. Answer the',
  'question using ONLY the JSON context provided — never invent an id, date,',
  'amount, or fact that is not already present in it. If the context does not',
  'answer the question, say so plainly rather than guessing. Two to four',
  'sentences, plain prose, no markdown.',
].join('\n')

/**
 * Full pipeline: find the record, build its context, answer from it.
 * `client` is optional — pass `null` to force the template path (used when no
 * key is configured), matching every other tier's degrade-honestly behavior.
 */
export async function answerQuestion(
  question: string,
  run: RunPayload,
  client: LLMClient | null,
): Promise<QAResult> {
  const recordId = findRecordId(question, run)
  if (!recordId) {
    return { answer: NO_ID_ANSWER, recordId: null, mode: 'template' }
  }

  const ctx = buildContext(run, recordId)
  const template = templateAnswer(ctx)

  if (!client) {
    return { answer: template, recordId, mode: 'template' }
  }

  try {
    const completion = await client.complete(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Question: ${question}\n\nContext: ${JSON.stringify(ctx)}` },
      ],
      [],
    )
    return { answer: completion.content ?? template, recordId, mode: completion.content ? 'llm' : 'template' }
  } catch {
    // A network failure here must not break the Q&A card — degrade to the
    // grounded template answer, same resilience pattern as tier 4.
    return { answer: template, recordId, mode: 'template' }
  }
}
