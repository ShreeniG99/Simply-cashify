/**
 * The tool registry.
 *
 * Every external capability the app or the agent can call is registered here
 * once, with a name, a JSON schema, a handler, and a mode. The registry is the
 * single place that answers "is this real, replayed, or absent" — a dashboard
 * integrations panel (step 7) and an LLM tool-calling agent (step 4) both read
 * from it rather than each inventing their own status logic.
 *
 * The commitment threading through every tool here: NEVER FABRICATE. A tool
 * either returns a real live value, a recorded value that is honestly labeled
 * as replayed, or it declines — it never silently invents a number. `mode`
 * on every result makes that check possible after the fact, not just at
 * design time.
 */

export type ToolMode = 'live' | 'fixture' | 'unconfigured'

export type ToolResult<T> = {
  mode: ToolMode
  data: T | null
  /** Present when `data` is null — why the tool declined rather than guessed. */
  reason?: string
}

export type ToolSpec<Input = unknown, Output = unknown> = {
  name: string
  description: string
  /** JSON-schema-shaped parameter description, for LLM tool-calling in step 4. */
  schema: Record<string, unknown>
  /** Env var name this tool needs for `live` mode, if any. Keyless tools omit this. */
  requiredEnv?: string
  handler: (input: Input) => Promise<ToolResult<Output>>
  /**
   * Best-effort status without actually invoking the tool — used by the
   * registry listing and the integrations panel. May itself attempt a cheap
   * reachability check; must never throw.
   */
  status: () => Promise<ToolMode>
}

const tools = new Map<string, ToolSpec<any, any>>()

export function registerTool<I, O>(spec: ToolSpec<I, O>): void {
  if (tools.has(spec.name)) {
    throw new Error(`Tool "${spec.name}" is already registered`)
  }
  tools.set(spec.name, spec)
}

export function getTool<I = unknown, O = unknown>(name: string): ToolSpec<I, O> | undefined {
  return tools.get(name)
}

export function listTools(): ToolSpec<any, any>[] {
  return [...tools.values()]
}

/** For tests only — lets a suite start from a clean registry. */
export function _resetRegistryForTests(): void {
  tools.clear()
}

export type ToolStatusReport = { name: string; description: string; mode: ToolMode }

export async function toolStatusReport(): Promise<ToolStatusReport[]> {
  return Promise.all(
    listTools().map(async (t) => ({
      name: t.name,
      description: t.description,
      mode: await t.status(),
    })),
  )
}
