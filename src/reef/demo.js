/**
 * Invented threads for `?demo`: enough projects and every status, changing every so often so
 * arrivals, departures and state changes can be watched without any harness installed.
 * Nothing in demo mode is ever saved.
 */

const PROJECTS = [
  ['atlas-api', 9],
  ['web-console', 7],
  ['ml-pipeline', 6],
  ['infra', 4],
  ['mobile-app', 5],
  ['docs-site', 3],
  ['cli-tools', 2],
]
const TITLES = [
  'Fix flaky auth test', 'Add rate limiting', 'Migrate to Postgres 17', 'Refactor billing service', 'Dark mode toggle',
  'Speed up cold start', 'Investigate memory leak', 'Write onboarding guide', 'Bump dependencies', 'Add retry to uploader',
  'Port CI to new runners', 'Paginate audit log', 'Tune batch sizes', 'Crash on empty payload', 'Accessibility pass',
  'Cache image thumbnails', 'Split monolith routes', 'Add feature flags', 'Telemetry for search', 'Clean up warnings',
]

let seq = 0
let threads = []

function make(project, now, random) {
  const id = `demo:${project}:${seq++}`
  const r = random()
  const thread = {
    id,
    harness: random() < 0.7 ? 'claude-code' : 'codex',
    title: TITLES[Math.floor(random() * TITLES.length)],
    preview: 'Can you take a look at this and fix it?',
    project,
    createdAt: now - Math.floor(random() * 9e8),
    lastActivityAt: now - Math.floor(random() * 3e6),
    running: false,
    unread: false,
    hasError: false,
    prState: null,
    sizeBytes: Math.floor(Math.pow(10, 3.3 + random() * 3.4)),
    canOpen: true,
    gitBranch: 'main',
  }
  thread.harnessName = thread.harness === 'codex' ? 'Codex' : 'Claude Code'
  if (r < 0.2) thread.running = true
  else if (r < 0.3) thread.unread = true
  else if (r < 0.36) thread.hasError = true
  else if (r < 0.42) thread.prState = 'MERGED'
  else if (r < 0.62) thread.lastActivityAt = now - 5 * 864e5
  return thread
}

export function demoRandom(seed = 7) {
  let h = seed
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0
    return h / 4294967296
  }
}

export function demoThreads(random) {
  const now = Date.now()
  threads = []
  for (const [project, count] of PROJECTS) for (let i = 0; i < count; i++) threads.push(make(project, now, random))
  // Make sure every state is on screen at least once.
  const by = (f) => threads.find(f)
  by((t) => t.project === 'atlas-api').unread = true
  by((t) => t.project === 'web-console').unread = true
  by((t) => t.project === 'infra').hasError = true
  return threads.map((t) => ({ ...t }))
}

/** One tick of life: a status flips, and now and then a thread arrives or is archived. */
export function demoTick(random) {
  const now = Date.now()
  const t = threads[Math.floor(random() * threads.length)]
  if (t) {
    const r = random()
    t.running = r < 0.35
    t.unread = !t.running && r < 0.55
    t.hasError = !t.running && !t.unread && r < 0.6
    t.prState = !t.running && !t.unread && !t.hasError && r < 0.7 ? 'MERGED' : null
    t.lastActivityAt = now
    t.sizeBytes = Math.floor(t.sizeBytes * 1.4)
  }
  if (random() < 0.3) {
    const [project] = PROJECTS[Math.floor(random() * PROJECTS.length)]
    const fresh = make(project, now, random)
    fresh.running = true
    fresh.createdAt = now
    threads.push(fresh)
  }
  if (random() < 0.2 && threads.length > 20) threads.splice(Math.floor(random() * threads.length), 1)
  return threads.map((x) => ({ ...x }))
}
