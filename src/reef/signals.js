import { STATUS_ORDER, STALE_MS } from '../game/status.js'

/**
 * The reef's small decisions, kept pure so they run under node: what colour a shelf's rim
 * shows, which fish a filter keeps, what a search finds, and the order `N` visits waiting fish.
 */

/**
 * Colour goes on state, not on project — a project is already told apart by *where* it is. So a
 * shelf's rim shows the loudest thing happening on it, and a quiet shelf shows nothing at all.
 * `mode` is 0 none, 1 steady, 2 pulsing (for the states that want you).
 */
export const SIGNAL = {
  blocked: { color: [1.0, 0.33, 0.27], mode: 2 },
  waiting: { color: [1.0, 0.78, 0.22], mode: 2 },
  working: { color: [0.36, 0.78, 1.0], mode: 1 },
  celebrating: { color: [0.25, 0.81, 0.53], mode: 1 },
}

export function shelfSignal(statuses) {
  for (const status of STATUS_ORDER) {
    if (SIGNAL[status] && statuses.includes(status)) return { status, ...SIGNAL[status] }
  }
  return { status: 'quiet', color: [0, 0, 0], mode: 0 }
}

/** The filters the HUD offers. Each takes { status, thread, project } and the current time. */
export const FILTERS = {
  all: { label: 'Everything', keep: () => true },
  needs: { label: 'Needs me', keep: (f) => f.status === 'waiting' || f.status === 'blocked' },
  working: { label: 'Working', keep: (f) => f.status === 'working' },
  today: { label: 'Active today', keep: (f, now) => now - (f.thread?.lastActivityAt || 0) < 864e5 },
  awake: { label: 'Hide dormant', keep: (f, now) => now - (f.thread?.lastActivityAt || 0) < STALE_MS },
}

/** `project:<name>` keeps one shelf; anything else is a key of FILTERS. */
export function filterFor(key, now = Date.now()) {
  if (!key || key === 'all') return null
  if (key.startsWith('project:')) {
    const name = key.slice(8)
    return (f) => f.project === name
  }
  const filter = FILTERS[key]
  return filter ? (f) => filter.keep(f, now) : null
}

/**
 * Search over shelves and threads. Case-insensitive; every word has to match somewhere. Shelves
 * rank first, then threads that want you, then the rest by how recently they moved.
 */
export function search(query, projects, threads, statusOf) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hit = (text) => words.every((w) => text.includes(w))
  const out = []
  for (const p of projects) {
    if (hit(p.name.toLowerCase())) out.push({ kind: 'shelf', name: p.name, label: p.name, detail: `${p.count} thread${p.count === 1 ? '' : 's'}` })
  }
  const urgent = (s) => (s === 'waiting' || s === 'blocked' ? 0 : 1)
  const found = threads
    .filter((t) => hit(`${t.title || ''} ${t.project || ''} ${t.gitBranch || ''}`.toLowerCase()))
    .map((t) => ({ kind: 'thread', id: t.id, label: t.title || 'Untitled thread', detail: t.project || '', status: statusOf(t), at: t.lastActivityAt || 0 }))
    .sort((a, b) => urgent(a.status) - urgent(b.status) || b.at - a.at)
  return [...out, ...found].slice(0, 12)
}

/**
 * The order `N` visits waiting fish: the one that has been waiting longest first. A thread goes
 * quiet when it finishes its turn, so its last activity is when it started waiting on you.
 * Ties break on id, so the order is stable from one press to the next.
 */
export function waitingOrder(fish) {
  return fish
    .filter((f) => f.status === 'waiting')
    .sort((a, b) => (a.thread?.lastActivityAt || 0) - (b.thread?.lastActivityAt || 0) || a.id.localeCompare(b.id))
}

/** "4 min", "3 h", "2 d" — for how long ago something happened. */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
