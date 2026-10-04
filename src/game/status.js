/**
 * What a thread is doing, decided once.
 *
 * Every world and every panel reads this — the colony's bots, the reef's fish, the thread card,
 * the board's sort — so no two places can disagree about a thread. Pure and browser-free, so it
 * runs under bare node with the rest of the bookkeeping.
 */

/** Untouched this long and a thread is dormant rather than merely idle. */
export const STALE_MS = 3 * 24 * 60 * 60 * 1000

export const STATUS_ORDER = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']

export const STATUS_LABEL = {
  working: 'Working',
  waiting: 'Waiting on you',
  blocked: 'Blocked',
  celebrating: 'Shipped',
  idle: 'Idle',
  sleeping: 'Dormant',
  spawning: 'Arriving',
  leaving: 'Heading home',
}

/**
 * Thread → behaviour. First match wins, exactly like the board's auto-sort.
 *
 * Errored outranks running because a thread that fell over mid-run is stuck, not busy; unread
 * sits below running because a thread still going is not waiting on anybody yet.
 */
export function statusFor(thread, now = Date.now()) {
  if (thread.hasError) return 'blocked'
  if (thread.running) return 'working'
  if (thread.prState === 'MERGED') return 'celebrating'
  if (thread.unread) return 'waiting'
  if (now - thread.lastActivityAt > STALE_MS) return 'sleeping'
  return 'idle'
}

/**
 * A thread you have said you looked at stops counting as unread until it moves on again.
 * Applied to the list before anything reads it, so the card, the badge and the inhabitant agree.
 */
export function withViewed(threads, viewedAt = {}) {
  return threads.map((t) => {
    const at = viewedAt[t.id]
    return at && t.lastActivityAt <= at ? { ...t, unread: false } : t
  })
}

/**
 * How far along a thread is, on a log scale over its transcript size. This drives the bar
 * on the thread card — it no longer drives how much of the building you can see.
 *
 * It used to. The shader draws construction by sinking the structure into the ground and
 * discarding what falls below the deck, and mapping transcript size onto that meant most
 * buildings stood permanently waist-deep in their own plot. Read as a picture of a colony
 * rather than as a chart, that is not "this thread is young", it is "this building is
 * broken" — a dome cut off by a flat plane looks like a rendering fault, and it is the
 * first thing the eye goes to. So the sink is now only what it is good at: the few seconds
 * of a new building rising out of the ground.
 */
export function transcriptProgress(thread) {
  const size = Math.max(1, thread.sizeBytes || 0)
  return Math.min(1, Math.max(0.05, (Math.log10(size) - 3) / 3.5))
}
