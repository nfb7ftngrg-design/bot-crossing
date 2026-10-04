import * as THREE from 'three'
import './reef.css'
import { Engine } from '../core/engine.js'
import { Settings, PRESETS } from '../core/settings.js'
import { CameraRig } from '../core/camera.js'
import { fetchThreads, fetchState, saveState, openThread } from '../game/api.js'
import { withErrands } from '../game/errands.js'
import { STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress, withViewed } from '../game/status.js'
import { Reef } from './reef.js'
import { Hud } from './hud.js'
import { demoThreads, demoTick, demoRandom } from './demo.js'

/**
 * The reef page: wiring. The world is a pure function of the thread list plus the saved layout;
 * everything here is getting the list in, getting clicks out, and saving what the person did.
 *
 * It shares the colony's file and the colony's way of writing it — whole, merged against disk
 * when another tab got there first — so the reef and the colony can be open side by side and an
 * archive in either is an archive in both.
 */

/** A copy hosted away from the scanner — nothing to read, nothing to save, and no colony beside it. */
const STANDALONE = Boolean(window.REEF_STANDALONE)
const DEMO = STANDALONE || new URLSearchParams(location.search).has('demo')
const POLL_MS = 15000

const settings = new Settings()
const engine = new Engine(settings).mount(document.querySelector('#app'))
const rig = new CameraRig(engine.camera, engine.canvas, settings)
rig.desiredDistance = rig.distance = 58
const reef = new Reef(engine.scene, engine.renderer, settings)

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {} }
let stateLoaded = false
let threads = []
let selectedId = null
let lastLayout = ''
let pendingSave = 0
let waitingCursor = -1

const hud = new Hud(document.body, settings, {
  open: () => act('open'),
  seen: () => act('seen'),
  archive: () => act('archive'),
  close: () => select(null),
  nextWaiting: () => nextWaiting(),
  cycleStatus: (status) => cycleStatus(status),
  orbit: () => hud.setOrbit(rig.toggleOrbit()),
  home: () => {
    select(null)
    rig.resetView()
  },
  focusProject: (name) => {
    const p = reef.projects.find((x) => x.name === name)
    if (p) rig.focus(p.centre, { distance: 34 })
  },
  progressFor: (id) => {
    const t = reef.threads.get(id)
    return t ? transcriptProgress(t) : 0
  },
})
hud.setDemo(DEMO, STANDALONE)

// ── selection ─────────────────────────────────────────────────────────────────────────

function select(id) {
  selectedId = id
  const fish = id ? reef.school.get(id) : null
  if (!fish) {
    selectedId = null
    rig.setFollow(null)
    hud.setSelection(null)
    return
  }
  if (settings.get('followSelected')) rig.setFollow(fish)
  else rig.focus(fish.pos)
  if (rig.desiredDistance > 32) rig.desiredDistance = 24
  hud.setSelection(fish, fish.thread, fish.status)
}

function nextWaiting() {
  const waiting = reef.school.order.filter((f) => f.status === 'waiting' && f.mode === 'live').sort((a, b) => a.id.localeCompare(b.id))
  if (!waiting.length) {
    hud.toast('Nobody is waiting on you')
    return
  }
  waitingCursor = (waitingCursor + 1) % waiting.length
  select(waiting[waitingCursor].id)
}

const statusCursor = {}
function cycleStatus(status) {
  const list = reef.school.order.filter((f) => f.status === status && f.mode === 'live').sort((a, b) => a.id.localeCompare(b.id))
  if (!list.length) {
    hud.toast(`Nobody is ${(STATUS_LABEL[status] || status).toLowerCase()} right now`)
    return
  }
  statusCursor[status] = ((statusCursor[status] ?? -1) + 1) % list.length
  select(list[statusCursor[status]].id)
}

async function act(kind) {
  const thread = threads.find((t) => t.id === selectedId)
  if (!thread) return
  if (kind === 'open') {
    if (DEMO) return hud.toast('Demo thread — nothing to open')
    try {
      const shown = await openThread(thread, settings.get('openIn'))
      const name = thread.harnessName || 'your harness'
      hud.toast(shown.via === 'terminal' ? `Opened ${name} in a terminal` : `Opened in ${name}`)
      setTimeout(poll, 1800)
    } catch (err) {
      hud.toast(err.message || 'Could not open that thread', 'err')
    }
    return
  }
  if (!DEMO && !stateLoaded) return hud.toast('The saved reef could not be read — reload to archive', 'err')
  if (kind === 'seen') {
    state.viewedAt = { ...(state.viewedAt || {}), [thread.id]: Date.now() }
    hud.toast('Marked as seen')
  } else if (kind === 'archive') {
    state.archived = [...new Set([...state.archived, thread.id])]
    state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
    hud.toast('Archived — heading back to the wreck')
    select(null)
  }
  queueSave()
  applyThreads(rawThreads)
}

// ── picking ───────────────────────────────────────────────────────────────────────────

const _p = new THREE.Vector3()
function fishAt(clientX, clientY) {
  const rect = engine.canvas.getBoundingClientRect()
  let best = null
  let bestD = Infinity
  for (const fish of reef.school.order) {
    if (fish.mode === 'leaving') continue
    _p.copy(fish.pos).project(engine.camera)
    if (_p.z > 1) continue
    const sx = rect.left + ((_p.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - _p.y) / 2) * rect.height
    const d = Math.hypot(sx - clientX, sy - clientY)
    // The hit radius follows the fish's size on screen, with a floor so a far fish is clickable.
    const reach = Math.max(18, 900 / Math.max(1, engine.camera.position.distanceTo(fish.pos)))
    if (d < reach && d < bestD) {
      bestD = d
      best = fish
    }
  }
  return best
}

engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const fish = fishAt(e.clientX, e.clientY)
  select(fish ? fish.id : null)
})
engine.canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return
  engine.canvas.style.cursor = fishAt(e.clientX, e.clientY) ? 'pointer' : ''
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

const keys = new Set()
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return
  const k = e.key.toLowerCase()
  if (k === 'n') nextWaiting()
  else if (k === 'o') hud.setOrbit(rig.toggleOrbit())
  else if (k === 'h') {
    select(null)
    rig.resetView()
  } else if (k === 'escape') {
    if (hud.settingsOpen) hud.toggleSettings(false)
    else select(null)
  } else if (k === ',') hud.toggleSettings()
  else keys.add(k)
})
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
window.addEventListener('blur', () => keys.clear())

function driveKeys(dt) {
  if (!keys.size) return
  let x = 0
  let z = 0
  if (keys.has('w') || keys.has('arrowup')) z -= 1
  if (keys.has('s') || keys.has('arrowdown')) z += 1
  if (keys.has('a') || keys.has('arrowleft')) x -= 1
  if (keys.has('d') || keys.has('arrowright')) x += 1
  if (x || z) {
    const speed = rig.distance * 0.9 * dt
    const sin = Math.sin(rig.azimuth)
    const cos = Math.cos(rig.azimuth)
    rig.desiredTarget.x += (x * cos + z * sin) * speed
    rig.desiredTarget.z += (-x * sin + z * cos) * speed
    rig._clampTarget()
    if (selectedId) rig.setFollow(null)
    rig.idleFor = 0
  }
  if (keys.has('q')) rig.desiredAzimuth -= dt * 1.2
  if (keys.has('e')) rig.desiredAzimuth += dt * 1.2
  if (keys.has('=') || keys.has('+')) rig.desiredDistance = Math.max(4, rig.desiredDistance * (1 - dt * 1.2))
  if (keys.has('-') || keys.has('_')) rig.desiredDistance = Math.min(150, rig.desiredDistance * (1 + dt * 1.2))
}

// ── frame ─────────────────────────────────────────────────────────────────────────────

engine.add({
  update(dt, elapsed) {
    driveKeys(dt)
    rig.update(dt)
    engine.setFocusDistance(rig.distance)
    const light = reef.update(dt, elapsed, engine.camera, rig.target, selectedId)
    hud.frame(engine, rig, reef, selectedId, light)
  },
})

settings.onChange((changed, scope) => {
  if (scope.render || changed.has('fov')) engine.applySettings()
  if (changed.has('particles') || changed.has('shadows') || changed.has('ibl') || changed.has('preset')) reef.applySettings()
  if (changed.has('scatterDensity')) reef.seabed.setDensity(settings.get('scatterDensity'))
  if (changed.has('maxAgents') || changed.has('hideDormant')) applyThreads(rawThreads)
  hud.syncSettings()
  if (stateLoaded && !DEMO) {
    state.settings = { ...settings.values }
    queueSave()
  }
})

// ── data ──────────────────────────────────────────────────────────────────────────────

let rawThreads = []
function applyThreads(list) {
  rawThreads = list
  threads = withViewed(withErrands(list), state.viewedAt || {})
  const archivedSet = new Set(state.archived)
  const hiddenSet = new Set(state.hiddenProjects || [])

  // A thread already on the books is simply already there; only a new one swims out of the wreck.
  const known = new Set(Object.keys(state.seen || {}))
  let firstSeen = false
  for (const t of threads) {
    if (state.seen?.[t.id]) continue
    state.seen = { ...(state.seen || {}), [t.id]: Date.now() }
    firstSeen = true
  }

  const stats = reef.setThreads(threads, archivedSet, hiddenSet, known)
  hud.setStats(stats, reef.capped)
  hud.setProjects(reef.projects)

  if (selectedId) {
    const fish = reef.school.get(selectedId)
    if (fish && fish.mode !== 'leaving') hud.setSelection(fish, fish.thread, fish.status)
    else select(null)
  }

  const layout = JSON.stringify(reef.layoutForSave())
  if (layout !== lastLayout) {
    lastLayout = layout
    state.plots = reef.layoutForSave()
    if (lastLayout !== '{}') firstSeen = true
  }
  if (firstSeen) queueSave()
}

function queueSave() {
  if (DEMO || !stateLoaded) return
  clearTimeout(pendingSave)
  pendingSave = setTimeout(async () => {
    try {
      state = await saveState(state)
    } catch {
      /* the reef still runs; the archive list retries on the next change */
    }
  }, 500)
}

let polling = false
async function poll() {
  if (DEMO || polling) return
  polling = true
  try {
    const res = await fetchThreads()
    applyThreads(res.threads || [])
  } catch (err) {
    hud.toast(err.message || 'Could not reach the thread scanner', 'err')
  } finally {
    polling = false
    hud.removeBoot()
  }
}

async function boot() {
  if (DEMO) {
    const random = demoRandom()
    const first = demoThreads(random)
    // Everything in the opening roster is already home; later arrivals get their entrance.
    for (const t of first) state.seen[t.id] = Date.now()
    applyThreads(first)
    hud.removeBoot()
    setInterval(() => applyThreads(demoTick(random)), 9000)
  } else {
    try {
      state = await fetchState()
      stateLoaded = true
      reef.restoreLayout(state.plots)
    } catch {
      hud.toast('Could not read the saved reef — archiving is off until you reload', 'err')
    }
    await poll()
    setInterval(poll, POLL_MS)
  }
  engine.start()
}

// Exposed for the check scripts: the numbers that say the reef is behaving.
window.__reef = {
  engine,
  reef,
  rig,
  settings,
  select,
  stats() {
    const s = reef.school.stats
    return {
      fish: reef.school.order.length,
      corals: reef.corals.count,
      drawCalls: engine.perf.drawCalls,
      fps: Math.round(engine.perf.fps),
      frames: s.frames,
      penetrations: s.penetrations,
      groundHits: s.groundHits,
      settled: s.settled,
      minGap: Number.isFinite(s.minGap) ? Number(s.minGap.toFixed(3)) : null,
      statuses: Object.fromEntries(STATUS_ORDER.map((k) => [k, reef.school.order.filter((f) => f.status === k).length])),
    }
  },
  /**
   * Step the world without drawing it, for the check scripts. A software-rendered headless
   * browser manages a frame or two a second, which the engine clamps to 0.1s steps — so watching
   * it in real time is watching it in slow motion. This runs the same update at 30Hz instead.
   */
  simulate(seconds, step = 1 / 30) {
    const start = engine.elapsed
    for (let t = 0; t < seconds; t += step) {
      engine.elapsed += step
      rig.update(step)
      reef.update(step, engine.elapsed, engine.camera, rig.target, selectedId)
    }
    return engine.elapsed - start
  },
  statusFor,
  PRESETS,
}

boot()
