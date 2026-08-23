'use client'

import { clsx } from 'clsx'

export function Card({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={clsx('rounded-xl border border-border bg-surface p-5', className)}>
      {children}
    </section>
  )
}

export function CardTitle({
  children,
  hint,
}: {
  children: React.ReactNode
  hint?: string
}) {
  return (
    <header className="mb-4">
      <h2 className="font-serif text-lg text-text-primary">{children}</h2>
      {hint && <p className="mt-1 font-mono text-xs leading-relaxed text-text-secondary">{hint}</p>}
    </header>
  )
}

export function Stat({
  label,
  value,
  suffix,
  tone = 'default',
  hint,
}: {
  label: string
  value: string
  suffix?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
  hint?: string
}) {
  const toneClass = {
    default: 'text-text-primary',
    good: 'text-success',
    warn: 'text-warning',
    bad: 'text-danger',
  }[tone]

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <p className="font-mono text-xs text-text-secondary">{label}</p>
      <p className={clsx('tabular mt-2 font-mono text-3xl', toneClass)}>
        {value}
        {suffix && <span className="ml-1 text-base text-text-secondary">{suffix}</span>}
      </p>
      {hint && <p className="mt-2 font-mono text-xs text-text-secondary">{hint}</p>}
    </div>
  )
}

/** Wide content must scroll inside its own box; the page never scrolls sideways. */
export function ScrollX({ children }: { children: React.ReactNode }) {
  return <div className="-mx-5 overflow-x-auto px-5">{children}</div>
}

const REASON_TONE: Record<string, string> = {
  orphan: 'border-text-secondary/40 text-text-secondary',
  low_confidence: 'border-warning/50 text-warning',
  ambiguous_multiple_candidates: 'border-warning/50 text-warning',
  fee_math_break: 'border-danger/50 text-danger',
  fx_unresolved: 'border-accent/50 text-accent',
  duplicate_suspected: 'border-accent/50 text-accent',
  invalid_bank_details: 'border-danger/50 text-danger',
}

export function ReasonBadge({ reason }: { reason: string }) {
  return (
    <span
      className={clsx(
        'inline-block whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-xs',
        REASON_TONE[reason] ?? 'border-border text-text-secondary',
      )}
    >
      {reason.replace(/_/g, ' ')}
    </span>
  )
}

const TIER_TONE: Record<string, string> = {
  exact: 'border-success/50 text-success',
  fuzzy: 'border-accent/50 text-accent',
  assignment: 'border-warning/50 text-warning',
  agent: 'border-danger/50 text-danger',
}

export function TierBadge({ tier }: { tier: string }) {
  return (
    <span
      className={clsx(
        'inline-block whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-xs',
        TIER_TONE[tier] ?? 'border-border text-text-secondary',
      )}
    >
      {tier}
    </span>
  )
}

export function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`
}
