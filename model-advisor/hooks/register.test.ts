import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const answers = (opus: number) => ({
  tier: { probabilities: { haiku: 0, sonnet: 1 - opus, opus, fable: 0 } },
  judgeable: { noul: 0.9 },
  scope: { probabilities: { quick: 0.1, task: 0.8, project: 0.1 } },
})

const typed = (text: string, kind: 'composer' | 'bridge' = 'composer') => ({ text, wait: false, origin: { kind } }) as const

/** The world beneath the plugin: a Sonnet session with no assistant turn yet, and Jev answering `opus`. */
function world(on: On, opus: number, env: Record<string, string> = { TYPESAFE_API_KEY: 'k' }) {
  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on)
  const sent: string[] = []
  const commands: string[] = []
  // The kit takes a query hook's primitive answer boxed as { value } (2.1.293).
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: answers(opus) }) } }) as never)
  on('command.run', ($, e) => {
    commands.push(`${e.command} ${e.args}`)
    return {}
  })
  const context: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    context.push(...(e.context ?? []))
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  return { sent, commands, clock, context }
}

test('a confident upgrade holds the first prompt', async ($, on) => {
  const w = world(on, 0.95)
  const r = await $.prompt.submit(typed('audit every skill that picks a model and update them'))
  expect('drop' in r).toBe(true)
  expect(w.sent).toEqual([])
})

test('a Sonnet-shaped prompt passes untouched', async ($, on) => {
  const w = world(on, 0.05)
  const r = await $.prompt.submit(typed('rename foo to bar in utils.py'))
  expect('drop' in r).toBe(false)
  expect(w.sent).toEqual(['rename foo to bar in utils.py'])
})

test('only the first prompt is classified', async ($, on) => {
  const w = world(on, 0.95)
  await $.prompt.submit(typed('first'))
  const r = await $.prompt.submit(typed('second'))
  expect('drop' in r).toBe(false)
  expect(w.sent).toEqual(['second'])
})

test('no transport fails open', async ($, on) => {
  const w = world(on, 0.95, {})
  await $.prompt.submit(typed('audit everything'))
  expect(w.sent).toEqual(['audit everything'])
})

test('opt-out and slash commands pass', async ($, on) => {
  const w = world(on, 0.95)
  await $.prompt.submit(typed('audit everything #no-advice'))
  expect(w.sent).toEqual(['audit everything #no-advice'])
})

test('autoSwitch runs /model and resends', { options: { autoSwitch: true } }, async ($, on) => {
  const w = world(on, 0.95)
  const r = await $.prompt.submit(typed('audit every skill'))
  expect('drop' in r).toBe(true)
  await w.clock.advance(1)
  await w.clock.settle()
  expect(w.commands).toEqual(['model opus'])
  expect(w.sent).toEqual(['audit every skill'])
})

test('a session that already has an assistant turn keeps its model', async ($, on) => {
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'hi', toolUses: [] }] }) as never)
  const w = world(on, 0.95)
  await $.prompt.submit(typed('audit everything'))
  expect(w.sent).toEqual(['audit everything'])
})

test('from a phone the prompt runs and the model is told to delegate', async ($, on) => {
  const w = world(on, 0.95)
  const r = await $.prompt.submit(typed('audit every skill', 'bridge'))
  expect('drop' in r).toBe(false)
  expect(w.context.join('\n')).toContain('model "opus"')
  expect(w.sent).toEqual(['audit every skill'])
})
