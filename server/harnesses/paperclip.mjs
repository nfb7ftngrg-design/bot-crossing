/**
 * Harness adapter: Paperclip — a company of agents, read off its local board.
 *
 * Paperclip keeps everything in an embedded Postgres under
 * `~/.paperclip/instances/<id>/`, which is not something to open from outside the
 * process that owns it. What it does offer is the board API its own UI talks to, on
 * loopback, and in the default `local_trusted` mode a loopback caller is the board.
 * So this adapter reads two GETs — the companies, then each company's agents — and
 * nothing else. No POST, no PUT, nothing that could wake an agent or change one.
 *
 * Every Paperclip **agent** is a bot, and its **company** is the plot it builds on:
 * an org of a dozen agents reads as a dozen bots at one site, which is what it is.
 *
 * Paperclip not running is a normal state, not a failure: the company's bots go home
 * until it comes back, and `diagnostic()` says why the list is empty.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exists, num } from '../lib/fsutil.mjs'

const DEFAULT_PORT = 3100
const FETCH_TIMEOUT_MS = 2500

/** Paperclip's own resolution: `$PAPERCLIP_HOME`, `$PAPERCLIP_INSTANCE_ID`, else `~/.paperclip` / `default`. */
export function instanceRoot(env = process.env, home = os.homedir()) {
  const base = env.PAPERCLIP_HOME?.trim() || path.join(home, '.paperclip')
  const id = env.PAPERCLIP_INSTANCE_ID?.trim() || 'default'
  return path.resolve(base.replace(/^~(?=$|[\\/])/, home), 'instances', id)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Where the board answers. `$BOT_CROSSING_PAPERCLIP_URL` wins; otherwise the instance's
 * `config.json`, with a wildcard bind (`0.0.0.0`, `::`) read as loopback — that is where
 * this machine reaches it, and the only place `local_trusted` lets a caller in.
 */
export async function baseUrl(env = process.env) {
  const override = env.BOT_CROSSING_PAPERCLIP_URL?.trim()
  if (override) return override.replace(/\/+$/, '')
  let host = '127.0.0.1'
  let port = DEFAULT_PORT
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(instanceRoot(env), 'config.json'), 'utf8'))
    if (Number.isInteger(cfg?.server?.port)) port = cfg.server.port
    const h = typeof cfg?.server?.host === 'string' ? cfg.server.host.trim() : ''
    if (LOOPBACK.has(h)) host = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h
  } catch {
    /* no config yet, or one mid-write — the defaults are Paperclip's own */
  }
  return `http://${host}:${port}`
}

/** Why the last scan came back empty, for the HUD's harness list. */
let lastProblem = ''

async function getJson(base, route) {
  const res = await fetch(`${base}/api${route}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Paperclip asked for sign-in — only a local_trusted instance can be read')
    err.auth = true
    throw err
  }
  if (!res.ok) throw new Error(`Paperclip answered ${res.status} for ${route}`)
  return res.json()
}

const unreachable = (err) =>
  err?.name === 'TimeoutError' ||
  err?.name === 'AbortError' ||
  /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed/i.test(`${err?.code || ''} ${err?.cause?.code || ''} ${err?.message || ''}`)

const ms = (v) => {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One agent, one bot. Exported for the tests; pure. */
export function toThread(agent, company, { base, root }) {
  const cfg = agent?.adapterConfig && typeof agent.adapterConfig === 'object' ? agent.adapterConfig : {}
  const status = String(agent?.status || '')
  const role = clean(agent?.title) || clean(agent?.role)
  const pitch = clean(agent?.capabilities)
  const lastActivityAt = Math.max(ms(agent?.lastHeartbeatAt), ms(agent?.updatedAt), ms(agent?.createdAt))
  return {
    id: `paperclip:${agent.id}`,
    title: clean(agent?.name) || 'Unnamed agent',
    preview: [role, pitch].filter(Boolean).join(' — ').slice(0, 280),
    project: clean(company?.name) || 'Paperclip',
    // One path per instance, so a company is one plot however its agents' workspaces are laid out.
    projectPath: root,
    worktree: '',
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
    gitBranch: '',
    model: typeof cfg.model === 'string' ? cfg.model : '',
    effort: typeof cfg.effort === 'string' ? cfg.effort : typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : '',
    createdAt: ms(agent?.createdAt),
    lastActivityAt,
    lastFocusedAt: 0,
    running: status === 'running',
    // Waiting on the board to approve its hire is the agent waiting on you.
    unread: status === 'pending_approval',
    hasError: status === 'error',
    archived: status === 'terminated',
    // Spend is the one running total of work Paperclip keeps per agent; the building
    // reads it on a log scale, so the units only need to grow with the work.
    sizeBytes: Math.max(0, Math.round(num(agent?.spentMonthlyCents) * 2000)),
    source: clean(agent?.adapterType),
    canOpen: Boolean(base),
    ref: { agentId: agent.id },
  }
}

async function detect() {
  if (process.env.BOT_CROSSING_PAPERCLIP_URL?.trim()) return true
  return exists(path.join(instanceRoot(), 'config.json'))
}

async function scanThreads() {
  const base = await baseUrl()
  const root = instanceRoot()
  let companies
  try {
    companies = await getJson(base, '/companies')
  } catch (err) {
    if (err?.auth || unreachable(err)) {
      lastProblem = err?.auth ? err.message : `Paperclip is not answering at ${base} — start it and its bots come back`
      return []
    }
    throw err
  }
  lastProblem = ''
  const out = []
  for (const company of Array.isArray(companies) ? companies : []) {
    if (!company?.id || !UUID.test(company.id)) continue
    let agents = []
    try {
      agents = await getJson(base, `/companies/${company.id}/agents`)
    } catch (err) {
      // One company the board cannot read costs that company, not the whole instance.
      if (!err?.auth && !unreachable(err)) console.warn('bot-crossing: paperclip company skipped —', err?.message || err)
      continue
    }
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (!agent?.id || !UUID.test(agent.id)) continue
      out.push(toThread(agent, company, { base, root }))
    }
  }
  return out
}

async function openThread(ref) {
  const id = typeof ref?.agentId === 'string' ? ref.agentId : ''
  if (!UUID.test(id)) return { ok: false, error: 'That is not a Paperclip agent' }
  // The board redirects an unprefixed agent route to the company it belongs to.
  return { ok: true, url: `${await baseUrl()}/agents/${id}` }
}

async function newSession() {
  return { ok: false, error: 'Paperclip hires agents from its own board — open it and add one there.' }
}

async function diagnostic() {
  return lastProblem
}

export default {
  id: 'paperclip',
  name: 'Paperclip',
  detect,
  scanThreads,
  openThread,
  newSession,
  diagnostic,
}
