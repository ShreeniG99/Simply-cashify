/**
 * Tier 3 — optimal assignment.
 *
 * Matching invoices to payments is an assignment problem, not a sequence of
 * independent lookups. Greedy first-fit takes the highest-scoring pair, consumes
 * both sides, and moves on — which is wrong whenever taking the locally best
 * edge strands a record that had only one good counterpart:
 *
 *     invoice A ── 0.95 ─→ payment Y      greedy: A→Y (0.95), then B→X (0.50)
 *              ╲                                   total 1.45
 *               ── 0.90 ─→ payment X      optimal: A→X (0.90) + B→Y (0.94)
 *     invoice B ── 0.94 ─→ payment Y               total 1.84
 *              ── 0.50 ─→ payment X
 *
 * Greedy's first pick looks best in isolation and costs it the better global
 * pairing. This module solves for the lowest total cost across the whole matrix
 * instead, using the Jonker-Volgenant shortest-augmenting-path form of the
 * Hungarian algorithm (O(n²m)).
 */

/** Cost used for a pair that is not a viable candidate at all. */
const FORBIDDEN = 1e6

export type Assignment = {
  /** Index into rows; -1 where the row is left unassigned. */
  rowToCol: number[]
  /** Total cost of the chosen assignment. */
  totalCost: number
}

/**
 * Minimum-cost assignment over a rectangular cost matrix.
 *
 * Rows are assigned to distinct columns so total cost is minimised. Requires
 * `rows <= cols`; callers pad. Costs may be any finite number.
 */
export function solveAssignment(cost: number[][]): Assignment {
  const n = cost.length
  if (n === 0) return { rowToCol: [], totalCost: 0 }
  const m = cost[0].length
  if (m === 0) return { rowToCol: new Array(n).fill(-1), totalCost: 0 }
  if (n > m) {
    throw new Error(`solveAssignment requires rows <= cols, got ${n}x${m}`)
  }

  const INF = Infinity
  // 1-indexed potentials and column assignment, per the standard formulation.
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0) // p[j] = row currently matched to column j
  const way = new Array<number>(m + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(INF)
    const used = new Array<boolean>(m + 1).fill(false)

    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0

      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }

      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }

      j0 = j1
    } while (p[j0] !== 0)

    // Walk the augmenting path back, flipping assignments.
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  const rowToCol = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0) rowToCol[p[j] - 1] = j - 1
  }

  let totalCost = 0
  for (let i = 0; i < n; i++) {
    if (rowToCol[i] >= 0) totalCost += cost[i][rowToCol[i]]
  }

  return { rowToCol, totalCost }
}

/**
 * Maximise total score instead of minimising cost.
 *
 * Pairs absent from `score` are forbidden: they get a prohibitive cost so the
 * solver will only pick one if there is no alternative, and the caller drops
 * those afterwards.
 */
export function solveMaxScore(
  rowCount: number,
  colCount: number,
  score: (row: number, col: number) => number | undefined,
): Assignment {
  if (rowCount === 0 || colCount === 0) {
    return { rowToCol: new Array(rowCount).fill(-1), totalCost: 0 }
  }

  // The solver needs rows <= cols, so pad with dummy columns when there are
  // more invoices than payments. Dummy columns are forbidden everywhere, which
  // leaves the surplus rows unassigned — exactly what we want.
  const paddedCols = Math.max(colCount, rowCount)

  const cost: number[][] = []
  for (let i = 0; i < rowCount; i++) {
    const row = new Array<number>(paddedCols).fill(FORBIDDEN)
    for (let j = 0; j < colCount; j++) {
      const s = score(i, j)
      if (s !== undefined) row[j] = -s // maximise score == minimise negative
    }
    cost.push(row)
  }

  const result = solveAssignment(cost)

  // Drop anything the solver only took because it had to.
  for (let i = 0; i < rowCount; i++) {
    const j = result.rowToCol[i]
    if (j >= colCount || (j >= 0 && cost[i][j] >= FORBIDDEN)) {
      result.rowToCol[i] = -1
    }
  }

  return result
}
