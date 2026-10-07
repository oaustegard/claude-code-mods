import { expect, test } from 'claude-code/testing'

import type { Classification, Tier } from '../types'
import { advice, jevCall, MODELS, parseJev, suggest, tierOf, verdict } from './advice'

const cls = (tier: Tier, p = 0.9, judgeable = 1, scope: 'quick' | 'task' | 'project' = 'task'): Classification => {
  const rest = (1 - p) / 3
  return {
    tier: { haiku: rest, sonnet: rest, opus: rest, fable: rest, [tier]: p },
    judgeable,
    scope: { quick: 0, task: 0, project: 0, [scope]: 1 },
  }
}

test('tierOf reads full ids and aliases', () => {
  expect(tierOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(tierOf('claude-opus-5-5[1m]')).toBe('opus')
  expect(tierOf('haiku')).toBe('haiku')
  expect(tierOf('')).toBe(null)
})

test('a confident upgrade fires; agreement, doubt and downgrades stay silent', () => {
  expect(suggest(cls('opus'), 'sonnet')).toEqual({ tier: 'opus', rule: 'tier' })
  expect(suggest(cls('sonnet'), 'sonnet')).toEqual({ tier: null, rule: 'agrees' })
  expect(suggest(cls('opus', 0.5), 'sonnet').tier).toBe(null)
  expect(suggest(cls('haiku'), 'opus')).toEqual({ tier: null, rule: 'cheaper' })
  expect(suggest(cls('haiku'), 'opus', true)).toEqual({ tier: 'haiku', rule: 'tier' })
})

test('an opaque prompt or a quick downgrade makes no call', () => {
  expect(suggest(cls('opus', 0.9, 0.1), 'sonnet')).toEqual({ tier: null, rule: 'opaque' })
  expect(suggest(cls('haiku', 0.9, 1, 'quick'), 'opus', true)).toEqual({ tier: null, rule: 'quick' })
  expect(suggest(cls('sonnet', 0.9, 0.1), 'fable', true)).toEqual({ tier: 'opus', rule: 'opaque-fable-prior' })
})

test('an unknown model never gets an upgrade', () => {
  expect(suggest(cls('fable'), null)).toEqual({ tier: null, rule: 'unknown-model' })
})

test('Jev transport prefers TypeSafe, falls back to the gateway, else none', () => {
  expect(jevCall({ typesafeKey: 'k', cfAccount: 'a', cfToken: 't' }, 'x', 'r')?.url).toBe('https://api.typesafe.ai/v1/systemone')
  const gw = jevCall({ cfAccount: 'a', cfToken: 't', cfGateway: 'g' }, 'x', null)
  expect(gw?.gateway).toBe(true)
  expect(gw?.headers['cf-aig-gateway-id']).toBe('g')
  expect(jevCall({}, 'x', null)).toBe(null)
})

test('parseJev reads both shapes and refuses a broken one', () => {
  const answers = {
    tier: { probabilities: { haiku: 0.1, sonnet: 0.2, opus: 0.6, fable: 0.1 } },
    judgeable: { noul: 0.8 },
    scope: { probabilities: { quick: 0.1, task: 0.8, project: 0.1 } },
  }
  expect(parseJev(JSON.stringify({ answers }), false).tier.opus).toBe(0.6)
  expect(parseJev(JSON.stringify({ result: { result: { answers } } }), true).judgeable).toBe(0.8)
  expect(() => parseJev('{"answers":{}}', false)).toThrow()
  expect(() => parseJev('not json', false)).toThrow()
})

test('messages name the tier, the confidence and the price ratio', () => {
  expect(advice('opus', 'tier', 'sonnet', cls('opus'))).toContain('Opus 5.5 costs about 2.0x more')
  expect(advice('haiku', 'tier', 'sonnet', cls('haiku'))).toContain('20.0x less')
  expect(verdict('agrees', 'sonnet', cls('sonnet'))).toContain("agrees with the session's model")
  expect(MODELS.haiku.name).toBe('Haiku 5.5')
})
