/**
 * Progress events for a running reconciliation — what makes the dashboard
 * show the pipeline actually working instead of a static spinner for the
 * ~1-2 seconds a run takes.
 *
 * These are genuinely emitted at the real point in the pipeline they name,
 * not simulated on a timer: tiers 0-3 are synchronous and typically resolve
 * in low single-digit milliseconds for a few hundred records, so their
 * events can legitimately arrive faster than a browser paints a frame — that
 * is real information (deterministic matching is not where a run's time
 * goes), not a bug to be disguised with an artificial delay. The one place
 * with genuine per-step wall-clock time is the agent tier when a live LLM
 * key is configured (`agent-progress`, paced by real network latency) and
 * the ablation sweep at the run level (`lib/api/run.ts`), which really does
 * run the whole pipeline six more times sequentially.
 */

export type ProgressEvent =
  | { kind: 'phase'; label: string }
  | { kind: 'tier'; tier: string; label: string }
  | { kind: 'agent-progress'; index: number; total: number }

export type OnProgress = (event: ProgressEvent) => void
