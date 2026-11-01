import type { Register } from 'claude-code'

const SKILL = 'escalating-effort'
const LEVEL = 'xhigh'

// The turn the skill raised, and the effort the last main-loop request carried.
let raisedTurn: string | undefined
let currentTurn: string | undefined
let lastEffort: string | undefined

const show = ($: any) =>
  $.ui.status(
    lastEffort === undefined
      ? undefined
      : raisedTurn !== undefined
        ? `effort ${lastEffort} ↑ this turn`
        : `effort ${lastEffort}`,
  )

export const register: Register = on => {
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) currentTurn = undefined
    return next(e)
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    const name = String(e.skill ?? '').split(':').pop()
    if (name === SKILL && ran.deny === undefined && e.agentId === undefined) {
      raisedTurn = currentTurn ?? 'pending'
      $.ui.toast(`Effort raised to ${LEVEL} for the rest of this turn`)
      show($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    currentTurn = e.turnId
    if (raisedTurn === 'pending') raisedTurn = e.turnId
    const step = raisedTurn === e.turnId ? { ...e, effort: LEVEL } : e
    lastEffort = step.effort === undefined ? undefined : String(step.effort)
    show($)
    return yield* next(step)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && raisedTurn !== undefined) {
      raisedTurn = undefined
      show($)
      return { text: `effort-escalator: this turn ran at ${LEVEL}` }
    }
    return r
  })
}
