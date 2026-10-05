import { expect, test } from 'claude-code/testing'

import { book, dayKey, line, prune, summarize } from './ledger'

const t = (s: string) => new Date(s).getTime()

test('book adds only the unbooked delta to the day', () => {
  const a = book({}, {}, 's1', 1.5, '2026-10-05')
  expect(a.days['2026-10-05']).toBe(1.5)
  const b = book(a.days, a.booked, 's1', 2.0, '2026-10-05')
  expect(b.days['2026-10-05']).toBe(2.0)
})

test('book ignores a total that went down and rebases', () => {
  const a = book({ d: 3 }, { s: 5 }, 's', 1, 'd')
  expect(a.days.d).toBe(3)
  expect(a.booked.s).toBe(1)
})

test('summarize counts today and the current month only', () => {
  const now = t('2026-10-05T12:00:00')
  const s = summarize({ '2026-09-30': 9, '2026-10-01': 2, [dayKey(now)]: 1 }, now, 10)
  expect(s.today).toBe(1)
  expect(s.month).toBe(3)
})

test('prune drops earlier months', () => {
  const now = t('2026-10-05T12:00:00')
  expect(Object.keys(prune({ '2026-09-30': 1, '2026-10-01': 1 }, {}, now).days)).toEqual(['2026-10-01'])
})

test('line shows percentage, or no budget when 0', () => {
  expect(line({ today: 1, month: 25, budget: 100 })).toBe('$1.00 today · $25.00/$100.00 month (25%)')
  expect(line({ today: 1, month: 25, budget: 0 })).toBe('$1.00 today · $25.00 month')
})
