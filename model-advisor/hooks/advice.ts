import type { Classification, Scope, Tier } from '../types'

// Port of claude-workspace scripts/model_advisor.py: the same classifier contract,
// thresholds and rules. Change both together.

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']
const SCOPES: readonly Scope[] = ['quick', 'task', 'project']

/** Display name, /model alias, first-party input $/MTok (2026-10; output is 5x on every tier). */
export const MODELS: Record<Tier, { name: string; alias: string; price: number }> = {
  haiku: { name: 'Haiku 5.5', alias: 'haiku', price: 0.1 },
  sonnet: { name: 'Sonnet 5.5', alias: 'sonnet', price: 2 },
  opus: { name: 'Opus 5.5', alias: 'opus', price: 4 },
  fable: { name: 'Fable 5.1', alias: 'fable', price: 10 },
}

// Sonnet 5.5 finishes a named deliverable well but stops to ask on a goal it has to
// work out (2026-10-07), so the sonnet/opus line is whether the work is named.
export const CRITERIA: Record<Tier, string> = {
  haiku:
    'A mechanical or fully specified task a small fast model completes reliably: run a named command or script, look something up, rename or reformat, extract or classify, summarise one item, apply edits the prompt spells out. No judgment, design or debugging expected.',
  sonnet:
    'A bounded task whose deliverable the prompt names: implement or fix a described change in known code, review one document, issue or PR, answer a factual question, a routine lookup or write-up. Done when the named thing is done; nothing has to be found out first.',
  opus:
    'Work the prompt sets as a goal and leaves to be discovered: find what needs changing and then change it, audit and update, follow through across many files or repositories, design an approach, debug an unknown cause, assess claims critically, synthesise research across sources. Needs initiative to keep going without asking.',
  fable:
    'Frontier-hard work where depth matters more than cost: novel research or experiments with uncertain outcomes, subtle correctness or security reasoning, long autonomous projects spanning many hours.',
}
const QUESTION = 'Which is the least capable model tier that would reliably complete this task well?'
const JUDGEABLE =
  'The prompt itself describes the work to be done, so its difficulty can be judged without opening a linked issue, memory id, file, paper or web page.'
const SCOPE_CRITERIA: Record<Scope, string> = {
  quick: 'A single answer, a short conversation or one small change, done within minutes.',
  task: 'A focused task of several steps, finished within about an hour.',
  project: 'An extended session: research, experiments or many changes over hours.',
}

export const THETA_UP = 0.75
export const THETA_DOWN = 0.75
export const JUDGEABLE_MIN = 0.5
export const QUICK_MAX = 0.5
export const PROMPT_CHARS = 4000
export const TIMEOUT_MS = 6000
export const OPT_OUT = '#no-advice'

export const tierOf = (model: string | undefined): Tier | null =>
  TIERS.find(t => (model ?? '').toLowerCase().includes(t)) ?? null

const rank = (t: Tier) => TIERS.indexOf(t)
const atMost = (p: Record<Tier, number>, t: Tier) => TIERS.slice(0, rank(t) + 1).reduce((s, u) => s + p[u], 0)
const atLeast = (p: Record<Tier, number>, t: Tier) => TIERS.slice(rank(t)).reduce((s, u) => s + p[u], 0)
export const best = (p: Record<Tier, number>): Tier => TIERS.reduce((a, b) => (p[b] > p[a] ? b : a))

// ------------------------------------------------------------------ transport

export type JevEnv = {
  typesafeKey?: string
  cfAccount?: string
  cfToken?: string
  cfGateway?: string
}

export type JevCall = { url: string; headers: Record<string, string>; body: string; gateway: boolean }

/** The Jev request for `prompt`, or null with no transport configured. */
export const jevCall = (env: JevEnv, prompt: string, repo: string | null): JevCall | null => {
  const state = {
    setting:
      'The first message of a Claude Code session. The model works autonomously with tools (shell, files, web, GitHub) for as many turns as the task takes.',
    repository: repo,
    prompt: prompt.slice(0, PROMPT_CHARS),
  }
  const questions = {
    tier: { type: 'choice', instructions: QUESTION, criteria: CRITERIA },
    judgeable: { type: 'noul', instructions: JUDGEABLE },
    scope: { type: 'choice', instructions: 'How much work will this session take?', criteria: SCOPE_CRITERIA },
  }
  if (env.typesafeKey) {
    return {
      url: 'https://api.typesafe.ai/v1/systemone',
      headers: { Authorization: `Bearer ${env.typesafeKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      gateway: false,
    }
  }
  if (env.cfToken && env.cfAccount) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.cfToken}`,
      'Content-Type': 'application/json',
    }
    if (env.cfGateway) headers['cf-aig-gateway-id'] = env.cfGateway

    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${env.cfAccount}/ai/run`,
      headers,
      body: JSON.stringify({ model: 'typesafe/jev', input: { state, questions } }),
      gateway: true,
    }
  }

  return null
}

/** Reads Jev's answer; throws with a short reason on any shape it does not expect. */
export const parseJev = (text: string, gateway: boolean): Classification => {
  let ans: any
  try {
    const res = JSON.parse(text)
    ans = (gateway ? res.result.result : res).answers
  } catch {
    throw new Error(`unreadable answer: ${text.slice(0, 120)}`)
  }
  const num = (v: unknown) => {
    const n = Number(v)
    if (v === undefined || v === null || Number.isNaN(n)) throw new Error(`unexpected answer shape: ${JSON.stringify(ans).slice(0, 120)}`)

    return n
  }
  const tier = Object.fromEntries(TIERS.map(t => [t, num(ans?.tier?.probabilities?.[t])])) as Record<Tier, number>
  const scope = Object.fromEntries(SCOPES.map(s => [s, num(ans?.scope?.probabilities?.[s])])) as Record<Scope, number>

  return { tier, scope, judgeable: num(ans?.judgeable?.noul) }
}

// ------------------------------------------------------------------- decision

/** The tier to suggest, or null, and the rule that decided. */
export const suggest = (
  cls: Classification,
  current: Tier | null,
  downgrade = false,
): { tier: Tier | null; rule: string } => {
  const p = cls.tier
  let rec: Tier | null = null
  if (current === null) {
    if (downgrade) rec = TIERS.slice(0, 2).find(t => atMost(p, t) >= THETA_DOWN) ?? null
  } else {
    if (downgrade) rec = TIERS.slice(0, rank(current)).find(t => atMost(p, t) >= THETA_DOWN) ?? null
    if (rec === null) rec = [...TIERS.slice(rank(current) + 1)].reverse().find(t => atLeast(p, t) >= THETA_UP) ?? null
  }
  if (rec === null) {
    if (current === null) return { tier: null, rule: 'unknown-model' }
    if (cls.judgeable < JUDGEABLE_MIN) return { tier: null, rule: 'opaque' }
    const b = best(p)
    if (b === current) return { tier: null, rule: 'agrees' }

    return { tier: null, rule: rank(b) < rank(current) && !downgrade ? 'cheaper' : 'unsure' }
  }
  const down = current === null || rank(rec) < rank(current)
  if (cls.judgeable < JUDGEABLE_MIN) {
    if (current === 'fable' && down) return { tier: 'opus', rule: 'opaque-fable-prior' }

    return { tier: null, rule: 'opaque' }
  }
  if (down && cls.scope.quick > QUICK_MAX) return { tier: null, rule: 'quick' }

  return { tier: rec, rule: 'tier' }
}

// ------------------------------------------------------------------- messages

const pct = (x: number) => `${Math.round(x * 100)}%`
const a = (name: string) => (/^[AEIOU]/.test(name) ? `an ${name}` : `a ${name}`)

export const WHY_SILENT: Record<string, string> = {
  agrees: "agrees with the session's model",
  unsure: 'leans another way, but not confidently enough to interrupt',
  'unknown-model': "couldn't read the session's model",
  cheaper: 'a cheaper model looks enough, and the advisor only suggests upgrades',
  opaque: 'the prompt points at the work rather than describing it, so no call',
  quick: 'looks like a few-minute session, not worth interrupting',
}

/** One line for a suggestion: the tier, how sure, and the cost ratio. */
export const advice = (rec: Tier, rule: string, current: Tier | null, cls: Classification): string => {
  const { name } = MODELS[rec]
  const down = current === null || rank(rec) < rank(current)
  const sure = down ? atMost(cls.tier, rec) : atLeast(cls.tier, rec)
  const why =
    rule === 'opaque-fable-prior'
      ? 'the prompt points at the work rather than describing it, and in 32 graded past sessions none needed Fable'
      : `${pct(sure)} sure`
  if (current === null) return `Model advisor: this looks like ${a(name)} task (${why}).`
  const ratio = MODELS[current].price / MODELS[rec].price
  const cost = ratio > 1 ? `${ratio.toFixed(1)}x less` : `${(1 / ratio).toFixed(1)}x more`

  return `Model advisor: this looks like ${a(name)} task (${why}); the session is on ${MODELS[current].name}, and ${name} costs about ${cost} per token.`
}

/** Context for the model when the person's client cannot show a choice (phone, web). */
export const relayContext = (rec: Tier, current: Tier | null, line: string): string => {
  const { name, alias } = MODELS[rec]
  const down = current === null || rank(rec) < rank(current)
  const todo = down
    ? 'then answer as usual.'
    : `then do the task, running its substantive work (the design, the hard reasoning, the implementation) in a subagent through the Agent tool with model "${alias}". Keep the main loop to coordinating, checking the subagent's result, and the reply.`
  const tail = down ? ` /model ${alias} would likely do, for next time.` : ` Handing the heavy part to ${a(name)} subagent; /model ${alias} moves the whole session.`

  return `The model advisor plugin classified this prompt; the user's client does not display plugin output. Open your reply with this line verbatim as a blockquote, ${todo}\n${line}${tail}`
}

/** The status-line verdict when the advisor stays silent. */
export const verdict = (rule: string, current: Tier | null, cls: Classification): string => {
  const b = best(cls.tier)
  const on = current ? MODELS[current].name : 'unknown model'

  return `advisor: ${MODELS[b].name}-shaped (${pct(cls.tier[b])}), on ${on}; quick ${pct(cls.scope.quick)}, describes the work ${pct(cls.judgeable)}. Silent: ${WHY_SILENT[rule] ?? rule}.`
}
