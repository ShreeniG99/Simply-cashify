/**
 * Deterministic PRNG (mulberry32). Same seed always yields the same stream —
 * this is what makes a run replayable and the benchmark reproducible.
 */
export type Rng = {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Uniform pick. */
  pick<T>(items: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
  /** Fisher-Yates copy. */
  shuffle<T>(items: readonly T[]): T[]
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
  }
  return rng
}
