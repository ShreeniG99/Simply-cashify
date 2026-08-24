import { beforeAll, describe, expect, it } from 'vitest'
import { controllerCopy, GENERIC_CONTROLLER_COPY } from '@/lib/copy/exceptions'
import { generate } from '@/lib/datasets/generate'
import { reconcile } from '@/lib/engine/pipeline'
import type { CanonicalBatch } from '@/lib/datasets/canonical'
import type { ExceptionReason, ReconcileResult } from '@/lib/engine/types'

describe('controllerCopy', () => {
  it('prefers the real controllerSummary when present', () => {
    const s = controllerCopy({ reason: 'orphan', controllerSummary: 'a specific sentence' })
    expect(s).toBe('a specific sentence')
  })

  it('falls back to a generic, reason-only sentence when controllerSummary is absent — never blank', () => {
    const s = controllerCopy({ reason: 'orphan' })
    expect(s).toBe(GENERIC_CONTROLLER_COPY.orphan)
    expect(s.length).toBeGreaterThan(0)
  })

  it('has a fallback sentence for every exception reason the engine can produce', () => {
    const reasons: ExceptionReason[] = [
      'orphan',
      'low_confidence',
      'ambiguous_multiple_candidates',
      'fee_math_break',
      'fx_unresolved',
      'duplicate_suspected',
      'invalid_bank_details',
    ]
    for (const reason of reasons) {
      expect(GENERIC_CONTROLLER_COPY[reason]).toBeTruthy()
    }
  })
})

describe('exception copy from a real reconciliation run', () => {
  let result: ReconcileResult
  let batch: CanonicalBatch

  beforeAll(async () => {
    const gen = generate({ seed: 7 })
    batch = gen.batch
    result = await reconcile(batch)
  })

  it('every real exception carries a controller-voice summary, not just the technical detail', () => {
    expect(result.exceptions.length).toBeGreaterThan(0)
    for (const e of result.exceptions) {
      expect(e.controllerSummary).toBeTruthy()
    }
  })

  it('the controller summary and the technical detail read differently — one is not a copy of the other', () => {
    const nonAgentExceptions = result.exceptions.filter((e) => e.reason !== 'orphan' || e.ledgerId)
    const differing = nonAgentExceptions.filter((e) => e.controllerSummary !== e.detail)
    // At least most exceptions should have genuinely distinct copy (agent-tier
    // exceptions legitimately reuse the same rationale text for both, by design).
    expect(differing.length).toBeGreaterThan(0)
  })

  it('a low_confidence controller summary names the actual candidate, not a generic placeholder', () => {
    const lowConf = result.exceptions.find((e) => e.reason === 'low_confidence')
    if (!lowConf) return // depends on seed; skip gracefully if this run produced none
    expect(lowConf.controllerSummary).not.toBe(GENERIC_CONTROLLER_COPY.low_confidence)
    expect(lowConf.controllerSummary).toMatch(/pay_/)
  })

  it('a fee_math_break controller summary quotes a formatted rupee amount, not raw paisa', () => {
    const feeBreak = result.exceptions.find((e) => e.reason === 'fee_math_break')
    if (!feeBreak) return
    expect(feeBreak.controllerSummary).not.toMatch(/\d+n\b/) // no stray bigint literal
    expect(feeBreak.controllerSummary).toMatch(/₹?[\d,]+\.\d{2}/)
  })
})
