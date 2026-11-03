import { expect, test } from 'claude-code/testing'

import { above, decide, failNote, jevCall, parseJev, showNote, visibleLine } from './policy'

const p = (low: number, high: number, xhigh: number) => ({ low, high, xhigh })

test('a confident level raises; low and doubt stay', () => {
  expect(decide(p(0.05, 0.1, 0.85))).toBe('xhigh')
  expect(decide(p(0.1, 0.85, 0.05))).toBe('high')
  expect(decide(p(0.8, 0.1, 0.1))).toBe(null)
  expect(decide(p(0.45, 0.3, 0.25))).toBe(null)
})

test('a split between high and xhigh stays at the default', () => {
  // From a sample of real prompts: "Could we use it to play doom?" and similar discussion split this way.
  expect(decide(p(0.3, 0.3, 0.4))).toBe(null)
  expect(decide(p(0.05, 0.5, 0.45))).toBe(null)
})

test('the bar is 0.8', () => {
  expect(decide(p(0.16, 0.8, 0.04))).toBe('high')
  expect(decide(p(0.1, 0.12, 0.78))).toBe(null)
})

test('above ranks levels and never lowers', () => {
  expect(above('xhigh', 'low')).toBe(true)
  expect(above('high', 'xhigh')).toBe(false)
  expect(above('xhigh', 'xhigh')).toBe(false)
  expect(above('xhigh', undefined)).toBe(true)
})

test('jevCall prefers TypeSafe, falls back to the gateway, else null', () => {
  const ts = jevCall({ typesafeKey: 'k', cfAccount: 'a', cfToken: 't' }, 'fix it', 'prior')!
  expect(ts.gateway).toBe(false)
  expect(JSON.parse(ts.body).state.previous_assistant_reply).toBe('prior')
  const gw = jevCall({ cfAccount: 'a', cfToken: 't', cfGateway: 'g' }, 'fix it', null)!
  expect(gw.gateway).toBe(true)
  expect(gw.headers['cf-aig-gateway-id']).toBe('g')
  expect(jevCall({}, 'fix it', null)).toBe(null)
})

test('parseJev reads both transports and refuses a bad shape', () => {
  const answers = { effort: { probabilities: { low: 0.1, high: 0.2, xhigh: 0.7 } } }
  expect(parseJev(JSON.stringify({ answers }), false).xhigh).toBe(0.7)
  expect(parseJev(JSON.stringify({ result: { result: { answers } } }), true).low).toBe(0.1)
  expect(() => parseJev('{"answers":{}}', false)).toThrow()
  expect(() => parseJev('not json', false)).toThrow()
})

test('the notes name the line the model is to show', () => {
  expect(showNote('xhigh', 'Jev 0.81')).toContain(visibleLine('xhigh', 'Jev 0.81'))
  expect(failNote(2)).toContain('escalating-effort')
})
