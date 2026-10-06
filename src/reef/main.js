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
import { ReefSound } from './sound.js'
import { filterFor, search, waitingOrder } from './signals.js'
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
const params = new URLSearchParams(location.search)
const DEMO = STANDALONE || params.has('demo') || params.has('check')
const POLL_MS = 15000
const ISO_POLAR = THREE.MathUtils.degToRad(56)
const GROUND_POLAR = THREE.MathUtils.degToRad(80)

const settings = new Settings()
const engine = new Engine(settings).mount(document.querySelector('#app'))
const rig = new CameraRig(engine.camera, engine.canvas, settings)
rig.desiredDistance = rig.distance = 58
const reef = new Reef(engine.scene, engine.renderer, settings)
const sound = new ReefSound(settings)

/**
 * Drag and zoom anchor on the seabed itself, not on a flat plane. The rig's default plane sits at
 * y=0, but a shelf top stands well above that, so a point grabbed on a shelf would slip under the
 * cursor as the view moved. This walks the pointer's ray down to the actual floor.
 */
const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
/**
 * Once something is grabbed — by a drag or a scroll — it is held on a level plane through the
 * exact point that was grabbed. That point is then pinned under the cursor exactly, however the
 * floor around it rises and falls; re-reading the uneven floor on every move would let it slip.
 */
const _level = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
function heldHeight() {
  if (rig._zoom) return rig._zoom.world.y
  if (rig._mode && rig._hasAnchor) return rig._panAnchor.y
  return null
}
const grab = rig._grab.bind(rig)
rig._grab = (x, y) => {
  rig._hasAnchor = false
  grab(x, y)
}
const wheel = rig._wheel.bind(rig)
rig._wheel = (e) => {
  rig._zoom = null
  wheel(e)
}
rig.dom.removeEventListener('wheel', rig._onWheel)
rig._onWheel = (e) => rig._wheel(e)
rig.dom.addEventListener('wheel', rig._onWheel, { passive: false })
rig.groundPoint = (clientX, clientY, out = new THREE.Vector3()) => {
  const rect = engine.canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  _ray.setFromCamera(_ndc, engine.camera)
  const { origin, direction } = _ray.ray
  if (direction.y > -1e-4) return null
  const held = heldHeight()
  if (held !== null) {
    _level.constant = -held
    return _ray.ray.intersectPlane(_level, out)
  }
  // From where the ray crosses the highest the floor can be, to where it passes the lowest.
  const t0 = Math.max(0, (6 - origin.y) / direction.y)
  const t1 = (-12 - origin.y) / direction.y
  const steps = 96
  let prev = t0
  for (let i = 1; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps
    _a.copy(origin).addScaledVector(direction, t)
    if (_a.y <= reef.seabed.heightAt(_a.x, _a.z)) {
      // Bisect between the last point above the floor and this one below it.
      let lo = prev
      let hi = t
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2
        _b.copy(origin).addScaledVector(direction, mid)
        if (_b.y <= reef.seabed.heightAt(_b.x, _b.z)) hi = mid
        else lo = mid
      }
      return out.copy(origin).addScaledVector(direction, (lo + hi) / 2)
    }
    prev = t
  }
  return null
}

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {} }
let stateLoaded = false
let threads = []
let rawThreads = []
let selectedId = null
let hoverId = null
let lastLayout = ''
let pendingSave = 0
let lastWaitingId = null
let filterKey = 'all'
let atGround = false
const waitingBefore = new Set()
let firstRoster = true

const hud = new Hud(document.body, settings, {
  open: () => act('open'),
  seen: () => act('seen'),
  archive: () => act('archive'),
  close: () => select(null),
  nextWaiting: () => nextWaiting(),
  cycleStatus: (status) => cycleStatus(status),
  orbit: () => hud.setOrbit(rig.toggleOrbit()),
  ground: () => toggleGround(),
  photo: () => hud.setPhoto(!hud.photo),
  home: () => goHome(),
  openShelf: (name) => openShelf(name),
  selectThread: (id) => selectThread(id),
  setFilter: (key) => setFilter(key),
  search: (q) => search(q, reef.projects, [...reef.threads.values()], (t) => reef.school.get(t.id)?.status || statusFor(t)),
  flyTo: (x, z) => {
    rig.setFollow(null)
    rig.focus(new THREE.Vector3(x, 0, z))
  },
  faceNorth: () => {
    rig.desiredAzimuth = Math.round(rig.desiredAzimuth / (Math.PI * 2)) * Math.PI * 2
  },
  progressFor: (id) => {
    const t = reef.threads.get(id)
    return t ? transcriptProgress(t) : 0
  },
})
hud.setDemo(DEMO, STANDALONE)

// ── selection and navigation ──────────────────────────────────────────────────────────

function select(id) {
  selectedId = id
  const fish = id ? reef.school.get(id) : null
  if (!fish) {
    selectedId = null
    rig.setFollow(null)
    rig.setViewportInsets(window.innerWidth, window.innerHeight)
    hud.setSelection(null)
    return
  }
  if (settings.get('followSelected')) rig.setFollow(fish)
  else rig.focus(fish.pos)
  if (rig.desiredDistance > 32) rig.desiredDistance = 24
  // With the card docked along the bottom, frame the fish in the space left above it.
  rig.setViewportInsets(window.innerWidth, window.innerHeight, { bottom: window.innerWidth < 700 ? window.innerHeight * 0.45 : 0 })
  hud.setSelection(fish, fish.thread, fish.status)
}

/** From a search result or the shelf list: fly to that thread's fish, clearing a filter hiding it. */
function selectThread(id) {
  const fish = reef.school.get(id)
  if (!fish) return hud.toast('That thread is not on the reef right now')
  if (!reef.school.isShown(fish)) setFilter('all')
  select(id)
}

/** The waiting fish in turn, longest-waiting first. */
function nextWaiting() {
  const waiting = waitingOrder(reef.school.order.filter((f) => f.mode === 'live'))
  if (!waiting.length) {
    hud.toast('Nobody is waiting on you')
    return
  }
  const at = waiting.findIndex((f) => f.id === lastWaitingId)
  const next = waiting[(at + 1) % waiting.length]
  lastWaitingId = next.id
  selectThread(next.id)
}

const statusCursor = {}
function cycleStatus(status) {
  const list = reef.school.order.filter((f) => f.status === status && f.mode === 'live').sort((a, b) => a.id.localeCompare(b.id))
  if (!list.length) {
    hud.toast(`Nobody is ${(STATUS_LABEL[status] || status).toLowerCase()} right now`)
    return
  }
  statusCursor[status] = ((statusCursor[status] ?? -1) + 1) % list.length
  selectThread(list[statusCursor[status]].id)
}

function openShelf(name) {
  const p = reef.projects.find((x) => x.name === name)
  if (!p) return
  select(null)
  rig.focus(p.centre, { distance: 34 })
  hud.showShelf(name, reef.school.order.filter((f) => f.project === name && f.mode !== 'leaving'), () =>
    reef.school.order.filter((f) => f.project === hud.shelf && f.mode !== 'leaving')
  )
}

function setFilter(key) {
  filterKey = key || 'all'
  reef.school.filter = filterFor(filterKey)
  hud.setFilter(filterKey)
  const kept = reef.school.order.filter((f) => reef.school.isShown(f)).length
  if (filterKey !== 'all') hud.toast(`${kept} fish match — the rest have swum off`)
  if (selectedId && !reef.school.isShown(reef.school.get(selectedId))) select(null)
}

function goHome() {
  select(null)
  hud.closeShelf()
  atGround = false
  hud.setGround(false)
  rig.resetView()
}

/** Ground level in one gesture: down among the fish, looking across the reef. Again to rise. */
function toggleGround() {
  atGround = !atGround
  hud.setGround(atGround)
  if (atGround) {
    rig.desiredPolar = GROUND_POLAR
    rig.desiredDistance = 9
  } else {
    rig.desiredPolar = ISO_POLAR
    rig.desiredDistance = 34
  }
}

/** Save the current view as a picture. Only works where the page is allowed to download. */
function screenshot() {
  if (STANDALONE) return hud.toast('Saving pictures is not available in this hosted copy')
  engine.renderFrame()
  engine.canvas.toBlob((blob) => {
    if (!blob) return hud.toast('Could not save the picture', 'err')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `reef-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    hud.toast('Picture saved')
  })
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
/** Hit-testing in screen space: the nearest fish to the pointer, within its size on screen. */
function fishAt(clientX, clientY) {
  const rect = engine.canvas.getBoundingClientRect()
  let best = null
  let bestD = Infinity
  for (const fish of reef.school.order) {
    if (!reef.school.isShown(fish)) continue
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

engine.canvas.addEventListener('pointerdown', () => sound.unlock())
engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const fish = fishAt(e.clientX, e.clientY)
  if (fish) hud.closeShelf()
  select(fish ? fish.id : null)
})
engine.canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return
  const fish = fishAt(e.clientX, e.clientY)
  hoverId = fish ? fish.id : null
  reef.school.hoverId = hoverId
  engine.canvas.style.cursor = fish ? 'pointer' : ''
})
engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  reef.school.hoverId = null
})

// ── keyboard ──────────────────────────────────────────────────────────────────────────

const keys = new Set()
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  sound.unlock()
  if (k === 'n') nextWaiting()
  else if (k === 'o') hud.setOrbit(rig.toggleOrbit())
  else if (k === 'h') goHome()
  else if (k === 'g') toggleGround()
  else if (k === 'p' && e.shiftKey) screenshot()
  else if (k === 'p') hud.setPhoto(!hud.photo)
  else if (k === '/') {
    e.preventDefault()
    hud.openSearch()
  } else if (k === 'escape') {
    if (hud.photo) hud.setPhoto(false)
    else if (hud.settingsOpen) hud.toggleSettings(false)
    else if (selectedId) select(null)
    else if (hud.shelf) hud.closeShelf()
    else if (filterKey !== 'all') setFilter('all')
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

/** How high above the floor the camera must stay, so ground level is among the fish, not in the rock. */
const CAMERA_CLEARANCE = 1.5
function step(dt, elapsed) {
  // The point the camera orbits sits on the seabed itself — a shelf top is well above y=0 — so
  // tilting down to ground level looks across the reef rather than up from inside it.
  if (!rig.following) {
    const floor = reef.seabed.heightAt(rig.desiredTarget.x, rig.desiredTarget.z)
    rig.desiredTarget.y += (Math.max(0, floor) + 0.4 - rig.desiredTarget.y) * Math.min(1, dt * 4)
  }
  rig.update(dt)
  const cam = engine.camera.position
  const below = reef.seabed.heightAt(cam.x, cam.z) + CAMERA_CLEARANCE - cam.y
  if (below > 0) {
    cam.y += below
    engine.camera.lookAt(rig.target)
    engine.camera.updateMatrixWorld()
  }
  engine.setFocusDistance(cam.distanceTo(rig.target))
  return reef.update(dt, elapsed, engine.camera, rig.target, selectedId)
}

engine.add({
  update(dt, elapsed) {
    driveKeys(dt)
    const light = step(dt, elapsed)
    hud.frame(engine, rig, reef, selectedId, light, hoverId)
    if (sound.ctx) {
      let busy = 0
      for (const f of reef.school.order) if (f.status === 'working' && f.pos.distanceTo(engine.camera.position) < 30) busy++
      sound.update(busy)
    }
  },
})

settings.onChange((changed, scope) => {
  if (scope.render || changed.has('fov')) engine.applySettings()
  if (changed.has('particles') || changed.has('shadows') || changed.has('ibl') || changed.has('preset')) reef.applySettings()
  if (changed.has('scatterDensity')) reef.seabed.setDensity(settings.get('scatterDensity'))
  if (changed.has('maxAgents') || changed.has('hideDormant')) applyThreads(rawThreads)
  if (changed.has('reefSound') && settings.get('reefSound')) sound.unlock()
  hud.syncSettings()
  if (stateLoaded && !DEMO) {
    state.settings = { ...settings.values }
    queueSave()
  }
})

// ── data ──────────────────────────────────────────────────────────────────────────────

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
  if (filterKey !== 'all') reef.school.filter = filterFor(filterKey)

  // The one sound allowed to interrupt: a thread that has just started waiting. Never on the first
  // roster — a reload is not news.
  const waitingNow = new Set(reef.school.order.filter((f) => f.status === 'waiting' && f.mode !== 'leaving').map((f) => f.id))
  if (!firstRoster && [...waitingNow].some((id) => !waitingBefore.has(id))) sound.call()
  waitingBefore.clear()
  for (const id of waitingNow) waitingBefore.add(id)
  firstRoster = false

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

let demoTimer = 0
async function boot() {
  if (DEMO) {
    const random = demoRandom()
    const first = demoThreads(random)
    // Everything in the opening roster is already home; later arrivals get their entrance.
    for (const t of first) state.seen[t.id] = Date.now()
    applyThreads(first)
    hud.removeBoot()
    // The check run drives the roster itself, so it gets no surprise changes underneath it.
    if (!params.has('check')) demoTimer = setInterval(() => applyThreads(demoTick(random)), 9000)
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
  if (params.has('check')) {
    const { runChecks } = await import('./checks.js')
    runChecks(window.__reef)
  }
}

// Exposed for the check suite: the numbers that say the reef is behaving, and the hooks it drives.
window.__reef = {
  engine,
  reef,
  rig,
  hud,
  settings,
  sound,
  select,
  selectThread,
  nextWaiting,
  setFilter,
  openShelf,
  toggleGround,
  applyThreads,
  get state() {
    return state
  },
  get selectedId() {
    return selectedId
  },
  get lastWaitingId() {
    return lastWaitingId
  },
  stopDemo() {
    clearInterval(demoTimer)
  },
  stats() {
    const s = reef.school.stats
    return {
      fish: reef.school.order.length,
      corals: reef.corals.count,
      drawCalls: engine.perf.drawCalls,
      fps: Math.round(engine.perf.fps),
      frames: s.frames,
      legs: s.legs,
      penetrations: s.penetrations,
      pushes: s.pushes || 0,
      groundHits: s.groundHits,
      overlaps: s.overlaps,
      gaveUp: s.gaveUp,
      settled: s.settled,
      minGap: Number.isFinite(s.minGap) ? Number(s.minGap.toFixed(3)) : null,
      statuses: Object.fromEntries(STATUS_ORDER.map((k) => [k, reef.school.order.filter((f) => f.status === k).length])),
    }
  },
  /**
   * Step the world without drawing it. A software-rendered headless browser manages a frame or
   * two a second, which the engine clamps to 0.1s steps — so watching it in real time is watching
   * it in slow motion. This runs the same update at 30Hz instead.
   */
  simulate(seconds, dt = 1 / 30) {
    const start = engine.elapsed
    for (let t = 0; t < seconds; t += dt) {
      engine.elapsed += dt
      step(dt, engine.elapsed)
    }
    return engine.elapsed - start
  },
  statusFor,
  PRESETS,
}

boot()
