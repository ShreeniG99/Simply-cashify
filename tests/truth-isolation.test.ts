/**
 * The accuracy claim rests on the matching pipeline never seeing the answer key.
 * That guarantee is worth nothing as a convention, so it is enforced here: walk
 * the engine's transitive import graph and fail if it can reach `truth`.
 *
 * When a judge asks "how do we know you didn't leak the labels?", the answer is
 * to run this test.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const TRUTH_MODULE = path.join(ROOT, 'lib/datasets/truth.ts')

/** Entry points that must never reach ground truth. */
const BLIND_ENTRYPOINTS = ['lib/engine/pipeline.ts']

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null // package
  const base = spec.startsWith('@/')
    ? path.join(ROOT, spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(file, m[1])
      if (resolved && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

describe('ground-truth isolation', () => {
  it('has a truth module to isolate', () => {
    expect(existsSync(TRUTH_MODULE)).toBe(true)
  })

  for (const entry of BLIND_ENTRYPOINTS) {
    it(`${entry} cannot reach lib/datasets/truth`, () => {
      const reachable = transitiveImports(path.join(ROOT, entry))
      expect(reachable.has(TRUTH_MODULE)).toBe(false)
    })
  }

  it('the import walker actually works (guards against a vacuous pass)', () => {
    // The generator legitimately writes ground truth, so it MUST reach it.
    // If this fails, the walker is broken and the assertions above prove nothing.
    const reachable = transitiveImports(path.join(ROOT, 'lib/datasets/generate.ts'))
    expect(reachable.has(TRUTH_MODULE)).toBe(true)
  })
})
