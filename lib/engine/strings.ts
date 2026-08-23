/**
 * Three-stage string matching for bank narrations.
 *
 * Real memos look like:
 *   NEFT-HDFC0001234-ACME CORP PVT LTD-INV2841-PAYMENT
 * i.e. reordered tokens, embedded identifiers, and noise. Character-level
 * similarity alone does badly on that — a reordered narration scores terribly on
 * Jaro-Winkler while being a perfect match. So:
 *
 *   1. Regex-extract identifiers (UTR / IFSC / invoice ref). Deterministic,
 *      highest signal, free — and if these agree the rest hardly matters.
 *   2. token_set_ratio on the remaining free text. Handles reordering and
 *      extra tokens, which is the dominant failure mode here.
 *   3. Jaro-Winkler as a tiebreaker on short counterparty names, where
 *      character transpositions ("Ramesh" / "Ramseh") are what actually differ.
 *
 * The weighting between stages is configurable so the ablation can measure which
 * combination wins rather than us asserting one.
 */

import { token_set_ratio } from 'fuzzball'

/** Real IFSC: 4 letters, a literal '0', then 6 alphanumerics. */
const IFSC_RE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g
/** Razorpay-style UTR: a letter followed by 12-20 digits. */
const UTR_RE = /\b[A-Z]\d{12,20}\b/g
/** Invoice references, tolerating a missing or odd separator. */
const INVOICE_RE = /\bINV[-_\s]?\d{2,6}\b/gi

export type Identifiers = {
  utrs: string[]
  ifscs: string[]
  invoiceRefs: string[]
  /** Whatever text is left once identifiers are removed. */
  residual: string
}

export function extractIdentifiers(text: string | undefined): Identifiers {
  if (!text) return { utrs: [], ifscs: [], invoiceRefs: [], residual: '' }
  const upper = text.toUpperCase()
  const utrs = [...upper.matchAll(UTR_RE)].map((m) => m[0])
  const ifscs = [...upper.matchAll(IFSC_RE)].map((m) => m[0])
  const invoiceRefs = [...upper.matchAll(INVOICE_RE)].map((m) => normalizeRef(m[0]))

  let residual = upper
  for (const token of [...utrs, ...ifscs]) residual = residual.split(token).join(' ')
  residual = residual.replace(INVOICE_RE, ' ')
  residual = residual.replace(/\b(NEFT|IMPS|RTGS|UPI|PAYMENT|SETTLEMENT|CREDIT)\b/g, ' ')
  residual = residual.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim()

  return { utrs, ifscs, invoiceRefs, residual }
}

/** `INV-2841`, `INV 2841`, `inv2841` all collapse to `INV2841`. */
export function normalizeRef(ref: string): string {
  return ref.toUpperCase().replace(/[-_\s]/g, '')
}

/** Is this a structurally valid IFSC? Catches the `wrong_ifsc` class. */
export function isValidIfsc(ifsc: string | undefined): boolean {
  if (!ifsc) return false
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())
}

// ------------------------------------------------------------ Jaro-Winkler

export function jaro(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aFlags = new Array<boolean>(a.length).fill(false)
  const bFlags = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window)
    const end = Math.min(i + window + 1, b.length)
    for (let j = start; j < end; j++) {
      if (bFlags[j] || a[i] !== b[j]) continue
      aFlags[i] = true
      bFlags[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aFlags[i]) continue
    while (!bFlags[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  transpositions /= 2

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3
}

/** Jaro with a bonus for a shared prefix — tuned for names, not sentences. */
export function jaroWinkler(a: string, b: string, scalingFactor = 0.1): number {
  const j = jaro(a, b)
  if (j === 0) return 0
  let prefix = 0
  const max = Math.min(4, a.length, b.length)
  while (prefix < max && a[prefix] === b[prefix]) prefix++
  return j + prefix * scalingFactor * (1 - j)
}

// ------------------------------------------------------------- combined

export type StringWeights = {
  identifier: number
  tokenSet: number
  jaroWinkler: number
}

export const DEFAULT_STRING_WEIGHTS: StringWeights = {
  identifier: 0.6,
  tokenSet: 0.3,
  jaroWinkler: 0.1,
}

export type StringScore = {
  total: number
  identifier: number
  tokenSet: number
  jaroWinkler: number
  /** Signals worth surfacing in the audit trail. */
  evidence: string[]
}

/**
 * Score how well two records' text agrees. `aRef`/`bRef` are the structured
 * reference fields (invoice no, payment id) which are checked alongside anything
 * found inside the free-text memo.
 */
export function scoreStrings(
  a: { reference?: string; counterparty?: string; memo?: string },
  b: { reference?: string; counterparty?: string; memo?: string },
  weights: StringWeights = DEFAULT_STRING_WEIGHTS,
): StringScore {
  const evidence: string[] = []

  const idA = extractIdentifiers([a.memo, a.reference].filter(Boolean).join(' '))
  const idB = extractIdentifiers([b.memo, b.reference].filter(Boolean).join(' '))

  // Stage 1 — identifiers.
  let identifier = 0
  const refsA = new Set(idA.invoiceRefs)
  const refsB = new Set(idB.invoiceRefs)
  const sharedRef = [...refsA].filter((r) => refsB.has(r))
  if (sharedRef.length > 0) {
    identifier = 1
    evidence.push(`invoice ref exact (${sharedRef[0]})`)
  } else if (refsA.size > 0 && refsB.size > 0) {
    // Both sides carry a reference but they disagree — could be a typo, so fall
    // back to character similarity between the best pair rather than scoring 0.
    let best = 0
    let bestPair = ''
    for (const ra of refsA) {
      for (const rb of refsB) {
        const s = jaroWinkler(ra, rb)
        if (s > best) {
          best = s
          bestPair = `${ra}~${rb}`
        }
      }
    }
    identifier = best
    if (best > 0.85) evidence.push(`invoice ref near-match (${bestPair})`)
  }

  const sharedUtr = idA.utrs.filter((u) => idB.utrs.includes(u))
  if (sharedUtr.length > 0) {
    identifier = Math.max(identifier, 1)
    evidence.push(`UTR exact (${sharedUtr[0]})`)
  }

  // Stage 2 — token set over residual free text plus counterparty.
  const textA = [idA.residual, a.counterparty ?? ''].join(' ').trim()
  const textB = [idB.residual, b.counterparty ?? ''].join(' ').trim()
  const tokenSet = textA && textB ? token_set_ratio(textA, textB) / 100 : 0
  if (tokenSet >= 0.9) evidence.push(`token set ${(tokenSet * 100).toFixed(0)}%`)

  // Stage 3 — Jaro-Winkler tiebreak on the counterparty name only.
  const jw =
    a.counterparty && b.counterparty
      ? jaroWinkler(a.counterparty.toUpperCase(), b.counterparty.toUpperCase())
      : 0
  if (jw >= 0.95) evidence.push(`counterparty ${(jw * 100).toFixed(0)}%`)

  // Absent evidence is not contradicting evidence.
  //
  // A signal only votes when both sides actually carry the field it reads.
  // Scoring an absent field as 0 would quietly penalise a record for something
  // nobody filled in: a payment quoting only a UTR and a counterparty could
  // never clear the accept threshold, and two narrations that agree perfectly
  // but carry no counterparty would lose the Jaro-Winkler weight outright.
  // So score across the applicable signals and renormalize by their weights.
  const applicable: { value: number; weight: number }[] = []
  if (refsA.size > 0 && refsB.size > 0) {
    applicable.push({ value: identifier, weight: weights.identifier })
  }
  if (textA && textB) {
    applicable.push({ value: tokenSet, weight: weights.tokenSet })
  }
  if (a.counterparty && b.counterparty) {
    applicable.push({ value: jw, weight: weights.jaroWinkler })
  }

  const totalWeight = applicable.reduce((s, x) => s + x.weight, 0)
  let total =
    totalWeight === 0
      ? 0
      : applicable.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight

  // A shared UTR is conclusive on its own regardless of what else is missing.
  if (sharedUtr.length > 0) total = Math.max(total, 1)

  if (refsA.size === 0 || refsB.size === 0) {
    evidence.push('no invoice reference on both sides; scored on text and timing')
  }

  return { total, identifier, tokenSet, jaroWinkler: jw, evidence }
}
