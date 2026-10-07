/** Cheapest first; the index is the rank. */
export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type Scope = 'quick' | 'task' | 'project'

/** Jev's answer: P(least capable tier that does the job), P(prompt describes the work), P(scope). */
export type Classification = {
  tier: Record<Tier, number>
  judgeable: number
  scope: Record<Scope, number>
}

/** A first prompt held back while the person chooses a model. */
export type Pending = { text: string; tier: Tier; note: string }

/** One decision, kept in the plugin store for /advisor. */
export type LogEntry = {
  ts: number
  model: string
  current: Tier | null
  suggest: Tier | null
  rule: string
  ms: number
  origin: string
  outcome?: 'switched' | 'kept' | 'relayed'
  head: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-advisor': { pending: Pending | null; decided: boolean }
  }
}
