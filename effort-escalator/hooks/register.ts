import type { EngineInterface as Engine, Register } from 'claude-code'

import { above, decide, FAIL_MAX, failNote, jevCall, OPT_OUT, parseJev, showNote, TIMEOUT_MS } from './policy'
import type { Level } from './policy'

const SKILL = 'escalating-effort'
const LOG = '/tmp/effort-escalator.log'

// Module state for the main loop only; a reload mid-turn drops a raise.
let pending: { level: Level; why: string } | undefined // decided at prompt.submit, applied at the next step
let raised: { turnId: string; level: string; why: string } | undefined
let currentTurn: string | undefined
let failures = 0
let nudged = false
let lastEffort: string | undefined
const lines: string[] = []

async function log($: Engine, msg: string) {
  lines.push(`${new Date().toISOString()} ${msg}`)
  try {
    await $.fs.write(LOG, lines.slice(-500).join('\n') + '\n')
  } catch {
    /* the log is for checking; its failure changes nothing */
  }
}

const show = ($: Engine) =>
  $.ui.status(
    lastEffort === undefined ? undefined : raised ? `effort ${lastEffort} ↑ this turn` : `effort ${lastEffort}`,
  )

async function rate($: Engine, text: string): Promise<Record<Level, number>> {
  const msgs = await $.session.messages()
  const reply = [...msgs].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? null
  const call = jevCall(
    {
      typesafeKey: await $.env.get('TYPESAFE_API_KEY'),
      cfAccount: await $.env.get('CF_ACCOUNT_ID'),
      cfToken: await $.env.get('CF_API_TOKEN'),
      cfGateway: await $.env.get('CF_GATEWAY_ID'),
    },
    text,
    reply,
  )
  if (!call) throw new Error('no Jev transport (TYPESAFE_API_KEY or CF_ACCOUNT_ID+CF_API_TOKEN)')
  const res = await Promise.race([
    $.http.fetch(call.url, { method: 'POST', headers: call.headers, body: call.body }),
    $.clock.sleep(TIMEOUT_MS).then(() => {
      throw new Error(`timeout after ${TIMEOUT_MS} ms`)
    }),
  ])
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 120)}`)
  return parseJev(res.text, call.gateway)
}

export const register: Register = on => {
  // Rate each prompt that starts a turn; a raise lands only on a request that carries new input.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.turnId !== undefined || e.text.includes(OPT_OUT)) return next(e)
    if ((await $.env.get('EFFORT_ESCALATOR'))?.toLowerCase() === 'off') return next(e)
    try {
      const t0 = Date.now()
      const p = await rate($, e.text)
      const level = decide(p)
      const ps = Object.entries(p).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')
      await log($, `jev ${ps} -> ${level ?? 'stay'} (${Date.now() - t0} ms) prompt=${JSON.stringify(e.text.slice(0, 60))}`)
      if (!level) return next(e)
      const why = `Jev ${p[level].toFixed(2)}`
      pending = { level, why }
      return next({ ...e, context: [...(e.context ?? []), showNote(level, why)] })
    } catch (err) {
      await log($, `jev failed: ${err}`)
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (currentTurn !== e.turnId) {
      currentTurn = e.turnId
      failures = 0
      nudged = false
    }
    if (pending) {
      raised = { turnId: e.turnId, ...pending }
      pending = undefined
    }
    const want = raised?.turnId === e.turnId ? raised.level : undefined
    const step = want && above(want, e.effort) ? { ...e, effort: want as Level } : e
    lastEffort = step.effort === undefined ? undefined : String(step.effort)
    show($)
    if (raised?.turnId === e.turnId) await log($, `step ${e.index} turn=${e.turnId} in=${e.effort} out=${lastEffort}`)
    return yield* next(step)
  })

  // The skill raises a turn mid-way (its text is new input); mark it and ask for the visible line.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    const name = String(e.skill ?? '').split(':').pop()
    if (name !== SKILL || ran.deny !== undefined || e.agentId !== undefined || !currentTurn) return ran
    raised = { turnId: currentTurn, level: 'xhigh', why: 'skill' }
    $.ui.toast('Effort raised to xhigh for the rest of this turn')
    show($)
    await log($, `skill ${name} raised turn=${currentTurn}`)
    return { ...ran, context: [...(ran.context ?? []), showNote('xhigh', 'skill')] }
  }).catch(($, e, next) => next(e))

  // Count failed tool calls; past FAIL_MAX in a turn still at the default, tell the model to escalate.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === 'Skill') return ran
    if (ran.deny === undefined && ran.isError !== true) return ran
    failures += 1
    if (failures < FAIL_MAX || nudged || raised?.turnId === currentTurn) return ran
    nudged = true
    await log($, `nudge after ${failures} failures turn=${currentTurn} last=${e.tool}`)
    return { ...ran, context: [...(ran.context ?? []), failNote(failures)] }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && raised) {
      await log($, `turn.complete turn=${raised.turnId} level=${raised.level} why=${raised.why}`)
      raised = undefined
      show($)
    }
    return r
  })
}
