/**
 * Regression coverage for a real bug a user caught via Settlement Q&A: for
 * INV-2090-DUP (a duplicate_suspected exception), the decision drawer said
 * "pay_2090 (scored 1 — confidence 1 below accept threshold 0.72)" — a
 * self-contradiction, since 1 is not below 0.72. The exceptions loop in
 * pipeline.ts applied one hardcoded rejection sentence
 * ("confidence X below accept threshold Y") to every alternative regardless
 * of whether that was actually why the candidate was rejected. A duplicate
 * ledger row's best candidate can score a perfect match against the payment
 * its twin already claimed; the real reason is "already matched to the
 * twin," not "too low-scoring." See rejectedBecauseFor in pipeline.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { generate } from '@/lib/datasets/generate'
import { reconcile } from '@/lib/engine/pipeline'
import { DEFAULT_CONFIG } from '@/lib/engine/config'
import type { ReconcileResult } from '@/lib/engine/types'

describe('decision alternatives never claim a false threshold comparison', () => {
  const threshold = DEFAULT_CONFIG.fuzzyAcceptThreshold

  function checkRun(result: ReconcileResult) {
    for (const d of result.decisions) {
      for (const alt of d.alternatives) {
        const claimsBelow = /below accept threshold/.test(alt.rejectedBecause)
        if (claimsBelow) {
          // The one thing this sentence must never do: assert "below" for a
          // score that is actually at or above the threshold.
          expect(
            alt.score,
            `${d.subjectId}: alternative ${alt.paymentIds.join(',')} scored ${alt.score} but rejectedBecause claims it's below ${threshold} — "${alt.rejectedBecause}"`,
          ).toBeLessThan(threshold)
        }
      }
    }
  }

  it('holds across many seeds, not just one lucky run', async () => {
    for (const seed of [1, 2, 3, 5, 7, 11, 13, 17, 19, 23]) {
      const { batch } = generate({ seed })
      const result = await reconcile(batch)
      checkRun(result)
    }
  })

  it('reproduces the reported case: a duplicate-suspected exception with a perfect-scoring rejected candidate', async () => {
    // Search a range of seeds for the exact shape the user hit — a
    // duplicate_suspected exception whose top alternative scores at or
    // above threshold — so this test fails loudly if the fix regresses,
    // not just on average across seeds.
    let found = false
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const { batch } = generate({ seed })
      const result = await reconcile(batch)
      const dupException = result.exceptions.find((e) => e.reason === 'duplicate_suspected')
      if (!dupException) continue
      const decision = result.decisions.find((d) => d.subjectId === dupException.ledgerId)
      const highScoringAlt = decision?.alternatives.find((a) => a.score >= threshold)
      if (!highScoringAlt) continue

      found = true
      // The honest fix: it must say the payment was already claimed, never
      // that a threshold-clearing score was "below" the threshold.
      expect(highScoringAlt.rejectedBecause).not.toContain('below accept threshold')
      expect(highScoringAlt.rejectedBecause).toMatch(/already matched to/)
    }
    expect(found, 'no seed in range 1-40 reproduced a duplicate_suspected exception with a high-scoring alternative — widen the range if the generator changed').toBe(true)
  })

  it('a high-scoring alternative not claimed by anyone names the row\'s own exception reason instead of blaming the score', async () => {
    // Covers the third branch of rejectedBecauseFor: candidate clears the
    // threshold, nobody else claimed it, but the row itself was excluded for
    // an unrelated reason (e.g. invalid IFSC) — never blame the score there either.
    for (const seed of [1, 2, 3, 5, 7, 11, 13, 17, 19, 23]) {
      const { batch } = generate({ seed })
      const result = await reconcile(batch)
      for (const d of result.decisions) {
        if (d.outcome !== 'exception') continue
        for (const alt of d.alternatives) {
          if (alt.score >= threshold && !alt.rejectedBecause.includes('already matched to')) {
            expect(alt.rejectedBecause).not.toContain('below accept threshold')
            expect(alt.rejectedBecause).toContain('not used because')
          }
        }
      }
    }
  })
})
