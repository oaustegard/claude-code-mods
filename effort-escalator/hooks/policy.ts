// Pure decisions of effort-escalator: the Jev request, its answer, the level
// to run a turn at, and the lines the model is asked to show.

export type Level = 'low' | 'high' | 'xhigh'
export const LEVELS: readonly Level[] = ['low', 'high', 'xhigh']
const ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** True when `a` is a higher effort than `b`; an unknown or numeric level ranks lowest. */
export const above = (a: unknown, b: unknown): boolean => ORDER.indexOf(String(a)) > ORDER.indexOf(String(b))

export const THETA = 0.65 // Jev's probability for a level before the turn is raised to it
export const FAIL_MAX = 2 // failed tool calls in one turn before the model is told to escalate
export const PROMPT_CHARS = 4000
export const REPLY_CHARS = 1500
export const TIMEOUT_MS = 5000
export const OPT_OUT = '#no-escalate'

export const CRITERIA: Record<Level, string> = {
  low:
    'Routine: a lookup, a status check, a question, opinion or idea to discuss, a confirmation or go-ahead for work already planned, running a known command, an edit, fix or small feature whose change is clear.',
  high:
    'Moderate: a fix or feature whose approach has to be worked out but stays inside one component, an investigation with several plausible causes, a careful written deliverable.',
  xhigh:
    'Hard: debugging whose cause is unclear, a design tradeoff, a change across several files or systems, a derivation or proof, an experiment to design, or a second attempt after a failed one.',
}

export type JevEnv = { typesafeKey?: string; cfAccount?: string; cfToken?: string; cfGateway?: string }
export type JevCall = { url: string; headers: Record<string, string>; body: string; gateway: boolean }

/** The Jev request rating `prompt`, or null with no transport configured. */
export const jevCall = (env: JevEnv, prompt: string, lastReply: string | null): JevCall | null => {
  const state = {
    setting:
      'A user message in a Claude Code session. The model works with tools (shell, files, web, GitHub) until the request is done. Reasoning effort is set per turn; low is the default.',
    previous_assistant_reply: lastReply ? lastReply.slice(-REPLY_CHARS) : null,
    prompt: prompt.slice(0, PROMPT_CHARS),
  }
  const questions = {
    effort: {
      type: 'choice',
      instructions:
        'How much reasoning effort does the work this message asks for need? Judge the work, read with the previous reply for context, not the length of the message.',
      criteria: CRITERIA,
    },
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
    const headers: Record<string, string> = { Authorization: `Bearer ${env.cfToken}`, 'Content-Type': 'application/json' }
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

/** Jev's probabilities per level; throws with a short reason on a shape it does not expect. */
export const parseJev = (text: string, gateway: boolean): Record<Level, number> => {
  let ans: any
  try {
    const res = JSON.parse(text)
    ans = (gateway ? res.result.result : res).answers
  } catch {
    throw new Error(`unreadable answer: ${text.slice(0, 120)}`)
  }
  const out = {} as Record<Level, number>
  for (const l of LEVELS) {
    const v = ans?.effort?.probabilities?.[l]
    const n = Number(v)
    if (v === undefined || v === null || Number.isNaN(n))
      throw new Error(`unexpected answer shape: ${JSON.stringify(ans).slice(0, 120)}`)
    out[l] = n
  }
  return out
}

/** The level to raise the turn to, or null to leave it at the default. */
export const decide = (p: Record<Level, number>, theta = THETA): Level | null => {
  const best = LEVELS.reduce((a, b) => (p[b] > p[a] ? b : a))
  // Only a confident call raises: a split between high and xhigh was mostly discussion.
  return best !== 'low' && p[best] >= theta ? best : null
}

export const visibleLine = (level: string, why: string) => `↑ effort ${level} this turn (effort-escalator: ${why})`

export const showNote = (level: string, why: string) =>
  `effort-escalator: this turn runs at ${level}. This client does not display mod output, so end your reply with this line verbatim: \`${visibleLine(level, why)}\``

export const failNote = (n: number) =>
  `effort-escalator: ${n} tool calls have failed this turn and it is still at the default effort. Invoke the escalating-effort skill now, before the next attempt.`
