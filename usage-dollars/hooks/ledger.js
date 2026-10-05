const pad = (n) => String(n).padStart(2, '0');
/** Local calendar day of an epoch-millisecond time, "YYYY-MM-DD". */
export const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/**
 * Books the part of a session's cumulative `usd` not yet booked onto `day`.
 * A cumulative figure that went down (a /clear, a reset ledger) books nothing
 * and becomes the new baseline.
 */
export const book = (days, booked, session, usd, day) => {
    const delta = Math.max(0, usd - (booked[session] ?? 0));
    return {
        days: delta > 0 ? { ...days, [day]: (days[day] ?? 0) + delta } : days,
        booked: { ...booked, [session]: usd },
    };
};
/** Drops days from before the current month and sessions older than 40 days. */
export const prune = (days, booked, now) => {
    const month = dayKey(now).slice(0, 7);
    const cutoff = now - 40 * 86_400_000;
    return {
        days: Object.fromEntries(Object.entries(days).filter(([k]) => k.startsWith(month))),
        booked: Object.fromEntries(Object.entries(booked).filter(([k]) => Number(k) >= cutoff)),
    };
};
export const summarize = (days, now, budget) => {
    const day = dayKey(now);
    const month = day.slice(0, 7);
    const sum = Object.entries(days).reduce((s, [k, v]) => (k.startsWith(month) ? s + v : s), 0);
    return { today: days[day] ?? 0, month: sum, budget };
};
export const usd = (n) => `$${n.toFixed(2)}`;
export const line = (s) => s.budget > 0
    ? `${usd(s.today)} today · ${usd(s.month)}/${usd(s.budget)} month (${Math.round((s.month / s.budget) * 100)}%)`
    : `${usd(s.today)} today · ${usd(s.month)} month`;
