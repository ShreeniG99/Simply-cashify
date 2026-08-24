'use client'

import { Check, Loader2 } from 'lucide-react'
import type { ProgressEvent } from '@/lib/engine/progress'

function labelFor(event: ProgressEvent): string {
  if (event.kind === 'agent-progress') {
    return `Agent reviewing record ${event.index} of ${event.total}`
  }
  return event.label
}

/**
 * Live log of the events lib/engine/progress.ts actually emitted, streamed
 * from /api/runs — not a simulated progress bar. Most tier-level events for
 * a normal-sized run resolve in low single-digit milliseconds (deterministic
 * matching is fast; see the module doc), so they can arrive and render
 * faster than they're individually readable — that's honest, not a bug. The
 * ablation sweep (six real sequential passes) and, when a live LLM key is
 * configured, the per-record agent-progress events are the parts genuinely
 * paced by real wall-clock time.
 */
export function TierProgress({ events, done }: { events: ProgressEvent[]; done: boolean }) {
  if (events.length === 0) return null

  return (
    <ul className="space-y-1.5">
      {events.map((e, i) => {
        const isLast = i === events.length - 1
        const active = isLast && !done
        return (
          <li
            key={i}
            className={`flex items-center gap-2 font-mono text-xs ${
              active ? 'text-text-primary' : 'text-text-secondary'
            }`}
          >
            {active ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
            ) : (
              <Check size={12} className="shrink-0 text-success" />
            )}
            <span className={e.kind === 'phase' ? '' : 'pl-3'}>{labelFor(e)}</span>
          </li>
        )
      })}
    </ul>
  )
}
