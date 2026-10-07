import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Classification, LogEntry, Pending, Tier } from '../types'
import {
  advice,
  jevCall,
  MODELS,
  OPT_OUT,
  parseJev,
  relayContext,
  suggest,
  TIMEOUT_MS,
  tierOf,
  verdict,
} from './advice'

const pending = atom({ plugin: 'model-advisor', key: 'pending' } as const, null)
const decided = atom({ plugin: 'model-advisor', key: 'decided' } as const, false)

const LOG = 'log'
const LOG_MAX = 200
const NO_HUMAN = /^(remote_trigger|sdk)/

async function log($: Engine, entry: LogEntry) {
  const all = ((await $.store.get(LOG)) ?? []) as LogEntry[]
  await $.store.set(LOG, [...all, entry].slice(-LOG_MAX))
}

async function settle($: Engine, outcome: LogEntry['outcome']) {
  const all = ((await $.store.get(LOG)) ?? []) as LogEntry[]
  const last = all.at(-1)
  if (last && !last.outcome) await $.store.set(LOG, [...all.slice(0, -1), { ...last, outcome }])
}

async function classify($: Engine, text: string): Promise<Classification> {
  const call = jevCall(
    {
      typesafeKey: await $.env.get('TYPESAFE_API_KEY'),
      cfAccount: await $.env.get('CF_ACCOUNT_ID'),
      cfToken: await $.env.get('CF_API_TOKEN'),
      cfGateway: await $.env.get('CF_GATEWAY_ID'),
    },
    text,
    (await $.session.repo())?.root.split('/').at(-1) ?? null,
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

/** Sends the held prompt, switching to `tier` first when one is given. */
async function send($: Engine, p: Pending, tier: Tier | null) {
  await update($, pending, () => null)
  await settle($, tier ? 'switched' : 'kept')
  if (tier) await $.command.run({ command: 'model', args: MODELS[tier].alias })
  await $.prompt.submit({ text: p.text, asUser: true })
}

export const register: Register = (on, options) => {
  const autoSwitch = Boolean(options.autoSwitch)
  const downgrade = Boolean(options.downgrade)
  const quiet = Boolean(options.quiet)

  on('session.start', async ($, e, next) => {
    // The hub's UserPromptSubmit hook (scripts/model_advisor.py) stands down on this.
    await $.env.set('MODEL_ADVISOR_MOD', '1')
    await $.command.register({
      name: 'advisor',
      description: 'Model advisor: the held prompt, and recent decisions',
      argumentHint: '[switch|send]',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only a person's own first prompt: the resend, a plugin's or a scheduled prompt pass.
    // The engine stamps every origin; an unstamped one (the test kit's) reads as the composer.
    const kind = e.origin?.kind ?? 'composer'
    if (kind !== 'composer' && kind !== 'bridge') return next(e)
    if (await read($, decided)) return next(e)
    const text = e.text
    if (!text.trim() || text.trimStart().startsWith('/') || text.includes(OPT_OUT)) return next(e)
    await update($, decided, () => true)
    // A resumed session already has a cache worth keeping on its model.
    let history: unknown = []
    try {
      history = await $.session.messages()
    } catch {
      // No transcript to read (a host without one): treat as a fresh session.
    }
    if (Array.isArray(history) && history.some(m => m?.role === 'assistant')) return next(e)
    const off = (await $.env.get('MODEL_ADVISOR'))?.toLowerCase()
    if (off === 'off' || off === '0' || off === 'false') return next(e)
    if (NO_HUMAN.test((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? '')) return next(e)

    const model = await $.session.model()
    const current = tierOf(model)
    const t0 = await $.clock.now()
    let cls: Classification
    try {
      cls = await classify($, text)
    } catch (err) {
      // Fail open: a broken advisor never eats a prompt.
      if (!quiet) $.ui.status(`advisor: classifier failed (${String(err).slice(0, 80)}); prompt sent unchanged`)

      return next(e)
    }
    const ms = (await $.clock.now()) - t0
    const { tier: rec, rule } = suggest(cls, current, downgrade)
    // A prompt that cannot be held and resent intact (a phone, an attachment) is relayed instead.
    const relay = kind === 'bridge' || (e.attachments?.length ?? 0) > 0
    await log($, {
      ts: t0,
      model,
      current,
      suggest: rec,
      rule,
      ms,
      origin: kind,
      outcome: rec && relay ? 'relayed' : undefined,
      head: text.slice(0, 120),
    })

    if (rec === null) {
      if (quiet) return next(e)
      const line = verdict(rule, current, cls)
      $.ui.status(line)
      if (kind !== 'bridge') return next(e)
      const note = `The model advisor plugin wrote a note this user's client does not display. Open your reply with it verbatim as a blockquote, then answer as usual:\n${line}`

      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    const line = advice(rec, rule, current, cls)
    if (relay) return next({ ...e, context: [...(e.context ?? []), relayContext(rec, current, line)] })

    const held: Pending = { text, tier: rec, note: line }
    if (autoSwitch) {
      $.ui.toast(`${line} Switching to ${MODELS[rec].name} and resending.`)
      // Commands queue until the session is idle, which it is once this prompt is dropped.
      $.clock.after(0, () => void send($, held, rec))
    } else {
      await update($, pending, () => held)
      $.ui.toast(line)
    }

    return { drop: line }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, pending)
    if (!p) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = tierOf(await $.session.model())
    const keep = now ? MODELS[now].name : 'this model'

    return (
      <Box>
        <Text>{p.note} </Text>
        <Button key="switch" label={`Switch to ${MODELS[p.tier].name} and send`} onPress={() => send($, p, p.tier)} />
        <Button key="keep" label={`Send on ${keep}`} onPress={() => send($, p, null)} />
        <Button
          key="edit"
          label="Edit"
          onPress={async () => {
            await update($, pending, () => null)
            await settle($, 'kept')
            await $.prompt.fill({ text: p.text })
          }}
        />
      </Box>
    )
  })

  on('command.run', { command: 'advisor' }, async ($, e) => {
    const p = await read($, pending)
    const arg = e.args.trim()
    if (p && (arg === 'switch' || arg === 'send')) {
      await send($, p, arg === 'switch' ? p.tier : null)

      return { text: arg === 'switch' ? `Switching to ${MODELS[p.tier].name} and sending.` : 'Sending unchanged.' }
    }
    const all = ((await $.store.get(LOG)) ?? []) as LogEntry[]
    const fired = all.filter(r => r.suggest)
    const lines = fired
      .slice(-10)
      .map(r => `  ${r.current ?? '?'} -> ${r.suggest} [${r.outcome ?? 'open'}] ${r.head.slice(0, 60)}`)
    const held = p ? `Held: ${p.note}\n/advisor switch or /advisor send.\n` : ''

    return {
      text: `${held}First prompts classified ${all.length}, advised ${fired.length}.${lines.length ? `\n${lines.join('\n')}` : ''}`,
    }
  })
}
