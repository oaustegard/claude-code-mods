export type BgTask = { id: string; label: string; startedAt: number; isAuto: boolean }

/** Keyed by trip name: findRoot, pollLoop, maskedError, hint, autoBg, bgAtEnd. */
export type Counts = { [trip: string]: number }

declare module 'claude-code' {
  interface PluginState {
    tripwire: { bg: BgTask[]; counts: Counts }
  }
}
