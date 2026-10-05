import type { Engine, Register } from 'claude-code'

import type { Booked, Days } from '../types'
import { book, dayKey, line, prune, summarize } from './ledger'

const DAYS = 'days'
const BOOKED = 'booked'
const WARNED = 'warned'

// Books this session's new spend into the shared day ledger and returns the summary.
// `seed` records the session's current total as already booked: a resumed session
// arrives with its past cost, which belongs to the days it was spent on.
async function sync($: Engine, seed: boolean, budget: number) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.cost === undefined) return undefined

  const session = String(usage.startedAt)
  const days = ((await $.store.get(DAYS)) ?? {}) as Days
  const booked = ((await $.store.get(BOOKED)) ?? {}) as Booked
  const next =
    seed && !(session in booked)
      ? { days, booked: { ...booked, [session]: usage.cost.usd } }
      : book(days, booked, session, usage.cost.usd, dayKey(now))
  const pruned = prune(next.days, next.booked, now)
  await $.store.set(DAYS, pruned.days)
  await $.store.set(BOOKED, pruned.booked)

  return summarize(pruned.days, now, budget)
}

export const register: Register = (on, options) => {
  const budget = Number(options.monthlyBudgetUsd ?? 0)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spend', description: 'Spend today and month to date against the budget' })
    const s = await sync($, true, budget)
    if (s) $.ui.status(line(s))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const s = await sync($, false, budget)
    if (s) {
      $.ui.status(line(s))
      if (s.budget > 0) {
        const month = dayKey(await $.clock.now()).slice(0, 7)
        const level = s.month >= s.budget ? 100 : s.month >= s.budget * 0.8 ? 80 : 0
        const warned = ((await $.store.get(WARNED)) ?? {}) as { month?: string; level?: number }
        const last = warned.month === month ? (warned.level ?? 0) : 0
        if (level > last) {
          await $.store.set(WARNED, { month, level })
          $.ui.toast(`Budget ${level}% reached: ${line(s)}`)
        }
      }
    }

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    const s = await sync($, false, budget)
    if (!s) return { text: 'No cost ledger in this host.' }
    const rest = s.budget > 0 ? `\nRemaining this month: ${Math.max(0, s.budget - s.month).toFixed(2)} USD` : ''

    return { text: `${line(s)}${rest}` }
  })
}
