'use client'

import { useRef, useState } from 'react'
import { Upload, FileText } from 'lucide-react'
import { CSV_TEMPLATE_HEADER } from '@/lib/datasets/csvAdapter'
import type { UploadRunPayload } from '@/lib/api/run'
import { Card, CardTitle, ReasonBadge, ScrollX, Stat, TierBadge } from './ui'
import { CashPanel } from './CashPanel'

const TEMPLATE_ROW =
  'ledger,INV-1001,2026-09-01,9940.00,INR,INV-1001,ACME CORP PVT LTD,,,,,'
const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(
  `${CSV_TEMPLATE_HEADER}\n${TEMPLATE_ROW}\n`,
)}`

/**
 * BYO-CSV — a quiet drop zone beneath the primary run button, not a peer to
 * it. The generator is the demo path; this proves the engine is genuinely
 * dataset-blind (lib/datasets/csvAdapter.ts) rather than hardcoded to one
 * synthetic shape. An uploaded batch has no ground truth, so this never
 * shows a precision or auto-clear number — see UploadRunPayload's doc
 * comment for why that's a deliberate omission, not a missing feature.
 */
export function UploadPanel({ onResult }: { onResult?: () => void } = {}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UploadRunPayload | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const text = await file.text()
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Upload failed')
      setResult(data)
      onResult?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const decisionsById = new Map((result?.decisions ?? []).map((d) => [d.subjectId, d]))

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) handleFile(file)
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center transition-all ${
          dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'
        }`}
      >
        <Upload size={18} className="text-text-secondary" />
        <div>
          <p className="font-mono text-xs text-text-primary">
            {busy ? 'Reconciling upload…' : 'Drop a CSV, or click to choose one'}
          </p>
          <p className="mt-1 font-mono text-[11px] text-text-secondary">
            One row per record, a <span className="text-text-primary">source</span> column of
            bank/settlement/ledger —{' '}
            <a
              href={TEMPLATE_HREF}
              download="simply-cashify-template.csv"
              onClick={(e) => e.stopPropagation()}
              className="text-accent underline-offset-2 hover:underline"
            >
              download the template
            </a>
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {error && <p className="mt-3 font-mono text-xs text-danger">{error}</p>}

      {result && (
        <div className="mt-6 space-y-6">
          <p className="flex items-center gap-2 font-mono text-xs text-text-secondary">
            <FileText size={14} />
            {result.recordCounts.bank} bank · {result.recordCounts.settlements} settlement ·{' '}
            {result.recordCounts.ledger} ledger rows. No ground truth for uploaded data, so no
            precision or auto-clear number — only what the engine actually decided.
          </p>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="matched" value={String(result.matches.length)} tone="good" />
            <Stat
              label="exceptions"
              value={String(result.exceptions.length)}
              tone={result.exceptions.length === 0 ? 'bad' : 'default'}
              hint="routed to a human, each with a reason"
            />
            <Stat
              label="throughput"
              value={result.stats.recordsPerSecond.toLocaleString()}
              suffix="rec/s"
              hint={`${result.stats.wallClockMs}ms wall clock`}
            />
            <Stat
              label="agent tier"
              value={result.agentTier === 'ran' ? 'ran' : 'skipped'}
              hint={result.agentTier !== 'ran' ? 'no LLM key configured' : undefined}
            />
          </div>

          {result.exceptions.length > 0 && (
            <div>
              <CardTitle>Exceptions ({result.exceptions.length})</CardTitle>
              <ScrollX>
                <table className="w-full min-w-[640px] border-collapse">
                  <thead>
                    <tr className="border-b border-border text-left">
                      {['record', 'reason', 'detail'].map((h) => (
                        <th key={h} className="pb-2 font-mono text-xs font-normal text-text-secondary">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.exceptions.map((e) => (
                      <tr key={e.id} className="border-b border-border/50">
                        <td className="py-2 pr-4 font-mono text-xs text-text-primary">{e.id}</td>
                        <td className="py-2 pr-4">
                          <ReasonBadge reason={e.reason} />
                        </td>
                        <td className="py-2 font-mono text-xs text-text-secondary">{e.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            </div>
          )}

          {result.matches.length > 0 && (
            <div>
              <CardTitle>Matches ({result.matches.length})</CardTitle>
              <ScrollX>
                <table className="w-full min-w-[560px] border-collapse">
                  <thead>
                    <tr className="border-b border-border text-left">
                      {['invoice', 'payments', 'tier', 'confidence'].map((h) => (
                        <th key={h} className="pb-2 font-mono text-xs font-normal text-text-secondary">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.matches.map((m) => (
                      <tr key={m.ledgerId} className="border-b border-border/50">
                        <td className="py-2 pr-4 font-mono text-xs text-text-primary">{m.ledgerId}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-text-secondary">
                          {m.paymentIds.join(', ')}
                        </td>
                        <td className="py-2 pr-4">
                          <TierBadge tier={m.tier} />
                        </td>
                        <td className="tabular py-2 font-mono text-xs text-text-primary">
                          {m.confidence.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            </div>
          )}

          <div>
            <CardTitle>Cash position</CardTitle>
            <CashPanel forecast={result.cashForecast} />
          </div>
        </div>
      )}
    </div>
  )
}
