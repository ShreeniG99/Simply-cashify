'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { DecisionRecord } from '@/lib/engine/types'
import { narrateTools } from '@/lib/qa/answer'
import { TierBadge } from './ui'

/**
 * The audit trail, made visible. An unexplainable match is worthless to a
 * controller, so every claim can be opened to show what decided it, which tools
 * it consulted, and what it rejected along the way.
 */
export function DecisionDrawer({
  decision,
  open,
  onOpenChange,
}: {
  decision: DecisionRecord | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 h-full w-full max-w-lg overflow-y-auto border-l border-border bg-surface p-6 focus:outline-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-serif text-xl text-text-primary">
                {decision?.subjectId ?? 'Decision'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 font-mono text-xs text-text-secondary">
                How this row was resolved
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="rounded-md border border-border p-1 text-text-secondary transition-all hover:text-text-primary"
              aria-label="Close"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          {decision && (
            <div className="mt-6 space-y-6">
              <div className="flex items-center gap-3">
                <TierBadge tier={decision.tier} />
                <span className="tabular font-mono text-sm text-text-secondary">
                  confidence {decision.confidence.toFixed(3)}
                </span>
                <span className="font-mono text-sm text-text-secondary">
                  {decision.outcome}
                </span>
              </div>

              <Section title="Evidence">
                {decision.evidence.length === 0 ? (
                  <Empty>No signals cleared the noise floor.</Empty>
                ) : (
                  <ul className="space-y-1">
                    {decision.evidence.map((e, i) => (
                      <li key={i} className="font-mono text-xs text-text-primary">
                        · {e}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Tools called">
                {decision.toolsCalled.length === 0 ? (
                  <Empty>None — resolved deterministically.</Empty>
                ) : (
                  <>
                    <ul className="space-y-1">
                      {decision.toolsCalled.map((t, i) => (
                        <li key={i} className="font-mono text-xs text-accent">
                          {t}()
                        </li>
                      ))}
                    </ul>
                    {/* Plain-language narration of the same tool calls above —
                        data vs. what the investigation actually did. */}
                    <p className="mt-2 font-mono text-xs leading-relaxed text-text-secondary">
                      {narrateTools(decision.toolsCalled, decision.tier)}
                    </p>
                  </>
                )}
              </Section>

              <Section title="Alternatives rejected">
                {decision.alternatives.length === 0 ? (
                  <Empty>No other candidate came close.</Empty>
                ) : (
                  <ul className="space-y-2">
                    {decision.alternatives.map((a, i) => (
                      <li key={i} className="rounded-md border border-border p-2">
                        <p className="tabular font-mono text-xs text-text-primary">
                          {a.paymentIds.join(', ')} — {a.score}
                        </p>
                        <p className="mt-1 font-mono text-xs text-text-secondary">
                          {a.rejectedBecause}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {decision.tokensUsed !== undefined && (
                <Section title="Cost">
                  <p className="tabular font-mono text-xs text-text-secondary">
                    {decision.tokensUsed} tokens · {decision.latencyMs}ms
                  </p>
                </Section>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-text-secondary">
        {title}
      </h3>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs italic text-text-secondary">{children}</p>
}
