'use client'

import { useState } from 'react'
import { Play, AlertTriangle, Gauge, Coins, Layers, Info } from 'lucide-react'
import type { RunPayload } from '@/lib/api/run'
import type { DecisionRecord } from '@/lib/engine/types'
import type { ProgressEvent } from '@/lib/engine/progress'
import { ScoreRing } from '@/components/ScoreRing'
import { DecisionDrawer } from '@/components/DecisionDrawer'
import { CalibrationChart } from '@/components/CalibrationChart'
import { SettlementQA } from '@/components/SettlementQA'
import { CashPanel } from '@/components/CashPanel'
import { UploadPanel } from '@/components/UploadPanel'
import { IntegrationsPanel } from '@/components/IntegrationsPanel'
import { TierProgress } from '@/components/TierProgress'
import { Card, CardTitle, ReasonBadge, ScrollX, Stat, TierBadge, pct } from '@/components/ui'

export default function Page() {
  const [run, setRun] = useState<RunPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [seed, setSeed] = useState('42')
  const [invoiceCount, setInvoiceCount] = useState('180')
  const [drawer, setDrawer] = useState<DecisionRecord | null>(null)
  const [hasUploaded, setHasUploaded] = useState(false)
  const [progress, setProgress] = useState<ProgressEvent[]>([])

  async function go() {
    setBusy(true)
    setError(null)
    setProgress([])
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed: seed === '' ? undefined : Number(seed),
          invoiceCount: invoiceCount === '' ? undefined : Number(invoiceCount),
        }),
      })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Run failed')
      }

      // /api/runs streams newline-delimited JSON — zero or more progress
      // lines as the pipeline actually runs, then one result (or error) line.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result: RunPayload | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex)
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.trim()) continue
          const msg = JSON.parse(line)
          if (msg.type === 'progress') {
            setProgress((prev) => [...prev, msg.event as ProgressEvent])
          } else if (msg.type === 'result') {
            result = msg.payload as RunPayload
          } else if (msg.type === 'error') {
            throw new Error(msg.error ?? 'Run failed')
          }
        }
      }

      if (!result) throw new Error('The run ended without a result.')
      setRun(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy(false)
    }
  }

  const decisionsById = new Map((run?.decisions ?? []).map((d) => [d.subjectId, d]))
  const op = run?.report.operating

  return (
    <main className="mx-auto max-w-6xl space-y-10 p-6 sm:p-8">
      <header>
        <h1 className="font-serif text-3xl text-text-primary">Simply Cashify</h1>
        <p className="mt-1 font-mono text-sm text-text-secondary">
          AI Finance Controller — multi-source cash reconciliation
        </p>
      </header>

      {/* One primary action. Benchmarks live in the CLI, not here. */}
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={go}
            disabled={busy}
            className="flex items-center gap-2 rounded-xl border border-accent bg-accent/10 px-5 py-3 font-mono text-sm text-text-primary transition-all hover:scale-[1.02] active:scale-[0.99] disabled:opacity-50 disabled:hover:scale-100"
          >
            <Play size={18} />
            {busy ? 'Reconciling…' : 'Run reconciliation'}
          </button>
          <button
            onClick={() => setAdvanced((v) => !v)}
            className="font-mono text-xs text-text-secondary underline-offset-4 hover:underline"
          >
            {advanced ? 'hide' : 'advanced'}
          </button>
          {run && (
            <span className="tabular font-mono text-xs text-text-secondary">
              seed {run.seed} · {run.stats.recordCount} records
            </span>
          )}
        </div>

        {advanced && (
          <div className="mt-4 flex flex-wrap gap-4">
            <Field label="seed" value={seed} onChange={setSeed} />
            <Field label="invoices" value={invoiceCount} onChange={setInvoiceCount} />
          </div>
        )}

        {progress.length > 0 && (
          <div className="mt-4 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg p-3">
            <TierProgress events={progress} done={!busy} />
          </div>
        )}

        {error && <p className="mt-4 font-mono text-xs text-danger">{error}</p>}
      </Card>

      <Card>
        <UploadPanel onResult={() => setHasUploaded(true)} />
      </Card>

      {!run && !busy && !hasUploaded && (
        <Card>
          <p className="font-mono text-sm leading-relaxed text-text-secondary">
            Reconciles a bank statement against a Razorpay settlement report and an
            internal ledger — one UTR credit covering many payments, net of MDR and
            GST-on-MDR. Every claim is scored against ground truth the matching engine
            cannot see.
          </p>
        </Card>
      )}

      {run && op && (
        <>
          {/* Headline: coverage held at a precision target, not raw match rate. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={`auto-clear @ ${pct(run.report.precisionTarget, 1)} precision`}
              value={pct(op.autoClearRate)}
              tone={op.autoClearRate > 0.7 ? 'good' : 'warn'}
              hint={`ceiling ${pct(run.ceiling)} — orphans cannot be matched`}
            />
            <Stat
              label="precision"
              value={pct(op.precision)}
              tone={op.precision >= run.report.precisionTarget ? 'good' : 'bad'}
              hint={`${op.wrongMatches} wrong auto-approvals`}
            />
            <Stat
              label="exceptions"
              value={String(run.exceptions.length)}
              tone={run.exceptions.length === 0 ? 'bad' : 'default'}
              hint="routed to a human, each with a reason"
            />
            <Stat
              label="throughput"
              value={run.stats.recordsPerSecond.toLocaleString()}
              suffix="rec/s"
              hint={`${run.stats.wallClockMs}ms wall clock`}
            />
          </div>

          {run.report.targetMissed && (
            <Card className="border-danger/50">
              <p className="font-mono text-xs text-danger">
                No confidence threshold reached the {pct(run.report.precisionTarget)}{' '}
                precision target. Reporting the best available point instead of a
                number that misses the bar.
              </p>
            </Card>
          )}

          {/* The centrepiece: each rung is a real re-run with a capability off. */}
          <Card>
            <CardTitle hint="Each row re-runs the whole pipeline with one capability switched off. The deltas are measured, not asserted.">
              Ablation
            </CardTitle>
            <ScrollX>
              <table className="w-full min-w-[640px] border-collapse">
                <thead>
                  <tr className="border-b border-border text-left">
                    {['config', 'precision', 'recall', 'F1', 'auto-clear', 'false exc.'].map(
                      (h) => (
                        <th
                          key={h}
                          className="pb-2 font-mono text-xs font-normal text-text-secondary"
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {run.ablation.map((r, i) => {
                    const prev = i > 0 ? run.ablation[i - 1] : null
                    const gain = prev ? r.recall - prev.recall : 0
                    return (
                      <tr key={r.label} className="border-b border-border/50">
                        <td className="py-2 font-mono text-xs text-text-primary">{r.label}</td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {pct(r.precision)}
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {pct(r.recall)}
                          {gain > 0.001 && (
                            <span className="ml-2 text-success">
                              +{(gain * 100).toFixed(1)}
                            </span>
                          )}
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {pct(r.f1)}
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {pct(r.autoClearRate)}
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-secondary">
                          {r.falseExceptions}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollX>
          </Card>

          {/* The proof behind the headline number: why THIS threshold, not a
              higher or lower one. */}
          <Card>
            <CardTitle hint="Precision and auto-clear trade off as the threshold moves. The marked point is the lowest threshold whose precision still clears the target — where the headline auto-clear number above comes from.">
              Confidence / coverage curve
            </CardTitle>
            <CalibrationChart
              curve={run.report.curve}
              precisionTarget={run.report.precisionTarget}
              operatingThreshold={op.threshold}
            />
          </Card>

          <Card>
            <CardTitle hint="What the agent tier actually costs, when it runs. Not fabricated when it doesn't.">
              Unit economics
            </CardTitle>
            {run.stats.llmTouchRate > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="LLM touch rate" value={pct(run.stats.llmTouchRate)} />
                <Stat
                  label="cost per 1,000 records"
                  value={`$${((run.stats.estimatedCostUsd / run.stats.recordCount) * 1000).toFixed(3)}`}
                  hint={`$${run.stats.estimatedCostUsd.toFixed(4)} this run · ${run.stats.tokensUsed.toLocaleString()} tokens`}
                />
                <Stat label="p50 latency" value={`${run.stats.latencyP50Ms}`} suffix="ms" />
                <Stat label="p95 latency" value={`${run.stats.latencyP95Ms}`} suffix="ms" />
              </div>
            ) : (
              <p className="font-mono text-xs text-text-secondary">
                No agent activity this run —{' '}
                {run.agentTier === 'skipped_no_key'
                  ? 'no LLM key configured'
                  : run.agentTier === 'skipped_disabled'
                    ? 'agent tier disabled'
                    : 'tiers 1–3 resolved everything the agent would have touched'}
                . Cost and latency figures would be zero either way; this is why, not a hidden failure.
              </p>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="flex items-center justify-center">
              <ScoreRing
                value={op.autoClearRate * 100}
                ceiling={run.ceiling * 100}
                label={`auto-cleared · ceiling ${pct(run.ceiling)}`}
              />
            </Card>

            <Card className="lg:col-span-2">
              <CardTitle hint="Cheap deterministic tiers first; expensive tiers only see the residual.">
                Tier breakdown
              </CardTitle>
              <div className="space-y-2">
                {run.tierBreakdown.map((t) => (
                  <div key={t.tier} className="flex items-center gap-3">
                    <span className="w-28 shrink-0">
                      <TierBadge tier={t.tier} />
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full rounded-full bg-accent transition-all"
                        style={{
                          width: `${(t.count / Math.max(1, run.report.ledgerCount)) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="tabular w-10 text-right font-mono text-xs text-text-secondary">
                      {t.count}
                    </span>
                  </div>
                ))}
              </div>
              {run.agentTier !== 'ran' && (
                <p className="mt-4 flex items-start gap-2 font-mono text-xs text-warning">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  Agent tier{' '}
                  {run.agentTier === 'skipped_no_key'
                    ? 'skipped — no LLM key configured'
                    : 'disabled for this run'}
                  . Its rows are not fabricated.
                </p>
              )}
            </Card>
          </div>

          {/* Per-class diagnosis is what makes the exception list useful. */}
          <Card>
            <CardTitle hint="Where the engine is strong and where it still loses — by injected discrepancy class.">
              Accuracy by discrepancy class
            </CardTitle>
            {/* Generous column gap: without it the two columns read as one
                run-on row rather than as separate class/bar pairs. */}
            <div className="grid gap-y-2 sm:grid-cols-2 sm:gap-x-10">
              {run.report.byClass.map((b) => (
                <div key={b.class} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 truncate font-mono text-xs text-text-secondary">
                    {b.class.replace(/_/g, ' ')}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${b.accuracy * 100}%`,
                        background:
                          b.accuracy >= 0.9
                            ? '#22C55E'
                            : b.accuracy >= 0.6
                              ? '#F59E0B'
                              : '#FF4D4D',
                      }}
                    />
                  </div>
                  <span className="tabular w-14 text-right font-mono text-xs text-text-secondary">
                    {b.correct}/{b.total}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle hint="Every row the engine would not guess at, with a typed reason. A 100% match rate would mean it guessed. Click a row for the exact score, threshold, or paisa delta behind it.">
              Exceptions ({run.exceptions.length})
            </CardTitle>
            <ScrollX>
              <table className="w-full min-w-[720px] border-collapse">
                <thead>
                  <tr className="border-b border-border text-left">
                    {['record', 'reason', 'what happened', 'amount'].map((h) => (
                      <th
                        key={h}
                        className="pb-2 font-mono text-xs font-normal text-text-secondary"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.exceptions.map((e) => {
                    const d = decisionsById.get(e.id)
                    return (
                      <tr
                        key={e.id}
                        onClick={() => d && setDrawer(d)}
                        className={`border-b border-border/50 ${d ? 'cursor-pointer hover:bg-bg' : ''}`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs text-text-primary">{e.id}</td>
                        <td className="py-2 pr-4">
                          <ReasonBadge reason={e.reason} />
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-text-secondary">
                          {e.controllerSummary}
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {e.record?.amount ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollX>
          </Card>

          {/* RAG over the audit trail above — grounded by construction, since
              retrieval only ever resolves to an id that actually exists in
              this run. See lib/qa/answer.ts. */}
          <Card>
            <CardTitle hint="Ask about any invoice or payment in this run. Answers are grounded in the same decision records the drawer shows — an LLM only polishes the prose when a key is configured, never the facts.">
              Settlement Q&A
            </CardTitle>
            <SettlementQA run={run} />
          </Card>

          <Card>
            <CardTitle hint="Weekly buckets, not a calendar. Only possible because reconciliation already ran — see the panel for how confirmed cash and projected receivables are derived.">
              Cash position
            </CardTitle>
            <CashPanel forecast={run.cashForecast} />
          </Card>

          <details className="rounded-xl border border-border bg-surface p-5">
            <summary className="cursor-pointer font-serif text-lg text-text-primary">
              Matched records ({run.matches.length})
            </summary>
            <ScrollX>
              <table className="mt-4 w-full min-w-[720px] border-collapse">
                <thead>
                  <tr className="border-b border-border text-left">
                    {['invoice', 'payments', 'tier', 'confidence', 'amount', ''].map((h, i) => (
                      <th
                        key={i}
                        className="pb-2 font-mono text-xs font-normal text-text-secondary"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.matches.map((m) => {
                    const d = decisionsById.get(m.ledgerId)
                    return (
                      <tr
                        key={m.ledgerId}
                        onClick={() => d && setDrawer(d)}
                        className={`border-b border-border/50 ${d ? 'cursor-pointer hover:bg-bg' : ''}`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs text-text-primary">
                          {m.ledgerId}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-text-secondary">
                          {m.paymentIds.join(', ')}
                        </td>
                        <td className="py-2 pr-4">
                          <TierBadge tier={m.tier} />
                        </td>
                        <td className="tabular py-2 pr-4 font-mono text-xs text-text-primary">
                          {m.confidence.toFixed(3)}
                        </td>
                        <td className="tabular py-2 pr-4 font-mono text-xs text-text-primary">
                          {m.amount}
                        </td>
                        <td className="py-2 font-mono text-xs">
                          {m.autoCleared ? (
                            <span className="text-success">auto</span>
                          ) : (
                            <span className="text-warning">review</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollX>
          </details>
        </>
      )}

      <Card>
        <CardTitle hint="Every tool this app can call, self-reported — never fabricated. live means it just reached the real service; fixture means it fell back to a recorded cassette; unconfigured means no key or webhook is set at all.">
          Integrations
        </CardTitle>
        <IntegrationsPanel />
      </Card>

      <DecisionDrawer
        decision={drawer}
        open={drawer !== null}
        onOpenChange={(v) => !v && setDrawer(null)}
      />
    </main>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="font-mono text-xs text-text-secondary">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        className="tabular w-24 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
      />
    </label>
  )
}
