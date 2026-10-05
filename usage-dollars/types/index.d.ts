/** Dollars spent per local calendar day ("YYYY-MM-DD"), summed over every session. */
export type Days = Record<string, number>

/** Cumulative dollars already booked per session, keyed by the session's start time. */
export type Booked = Record<string, number>

export type Summary = { today: number; month: number; budget: number }
