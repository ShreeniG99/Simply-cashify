'use client'

import { useEffect, useState } from 'react'
import type { ToolStatusReport } from '@/lib/tools/registry'

const DOT: Record<string, string> = {
  live: 'bg-success',
  fixture: 'bg-warning',
  unconfigured: 'bg-text-secondary/40',
}

const LABEL: Record<string, string> = {
  live: 'live — reached the real service just now',
  fixture: 'fixture — recorded cassette, no network reachable',
  unconfigured: 'unconfigured — no key or webhook set',
}

/**
 * Every registered tool, honestly labeled. Reads `toolStatusReport()` — the
 * same three-mode discipline (`live | fixture | unconfigured`, never
 * fabricated) every connector already carries in `lib/tools/`. This panel
 * adds no new logic, it just makes the existing self-report visible.
 */
export function IntegrationsPanel() {
  const [report, setReport] = useState<ToolStatusReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/tools')
      .then((res) => res.json())
      .then((data) => setReport(data.tools))
      .catch(() => setError('Could not load tool status.'))
  }, [])

  if (error) return <p className="font-mono text-xs text-danger">{error}</p>
  if (!report) return <p className="font-mono text-xs text-text-secondary">Loading…</p>

  return (
    <div className="space-y-2">
      {report.map((t) => (
        <div key={t.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[t.mode] ?? 'bg-border'}`}
            title={t.mode}
          />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-text-primary">{t.name}</p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary">
              {t.description}
            </p>
          </div>
          <span className="font-mono text-[11px] text-text-secondary">
            {LABEL[t.mode] ?? t.mode}
          </span>
        </div>
      ))}
    </div>
  )
}
