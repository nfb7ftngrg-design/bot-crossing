import * as THREE from 'three'
import '../reef/reef.css'
import './lab.css'
import { Engine } from '../core/engine.js'
import { Settings, PRESETS } from '../core/settings.js'
import { CameraRig } from '../core/camera.js'
import { fetchThreads, fetchState, saveState, openThread } from '../game/api.js'
import { withErrands } from '../game/errands.js'
import { STATUS_LABEL, STATUS_ORDER, statusFor, transcriptProgress, withViewed } from '../game/status.js'
import { filterFor, search, waitingOrder } from '../reef/signals.js'
import { ReefSound } from '../reef/sound.js'
import { demoThreads, demoTick, demoRandom } from '../reef/demo.js'
import { Lab } from './lab.js'
import { Hud } from './hud.js'
import { createCase, assign, unassign, setStatus, setPriority, removeCase, briefText, demoCases, ordered } from './cases.js'

/**
 * The lab page: wiring. The facility is a pure function of the thread list, the saved floor plan
 * and the cases; everything here is getting the list in, getting clicks out, and saving what the
 * person did — through the colony file and its merging save, like the colony and the reef.
 */

const STANDALONE = Boolean(window.LAB_STANDALONE)
const params = new URLSearchParams(location.search)
const DEMO = STANDALONE || params.has('demo') || params.has('check')
const POLL_MS = 15000
const ISO_POLAR = THREE.MathUtils.degToRad(52)
const GROUND_POLAR = THREE.MathUtils.degToRad(76)
const CAMERA_CLEARANCE = 1.6

const settings = new Settings()
const engine = new Engine(settings).mount(document.querySelector('#app'))
const rig = new CameraRig(engine.camera, engine.canvas, settings)
rig.desiredDistance = rig.distance = 46
rig.desiredPolar = rig.polar = ISO_POLAR
const lab = new Lab(engine.scene, engine.renderer, settings)
const sound = new ReefSound(settings, { enabledKey: 'labSound', volumeKey: 'labVolume', bed: 240, work: 3400 })

let state = { archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, hiddenProjects: [], viewedAt: {}, cases: {}, labRooms: {} }
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

const workerTitle = (id) => lab.threads.get(id)?.title || 'this person'

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
  openShelf: (name) => openDepartment(name),
  selectThread: (id) => selectThread(id),
  setFilter: (key) => setFilter(key),
  search: (q) => search(q, lab.projects, [...lab.threads.values()], (t) => lab.staff.get(t.id)?.status || statusFor(t)),
  flyTo: (x, z) => {
    rig.setFollow(null)
    rig.focus(new THREE.Vector3(x, 0, z))
  },
  faceNorth: () => {
    rig.desiredAzimuth = Math.round(rig.desiredAzimuth / (Math.PI * 2)) * Math.PI * 2
  },
  progressFor: (id) => {
    const t = lab.threads.get(id)
    return t ? transcriptProgress(t) : 0
  },
  // Cases.
  cases: () => state.cases || {},
  workers: () => new Map(lab.staff.order.filter((p) => p.mode !== 'leaving').map((p) => [p.id, { title: p.thread?.title, status: p.status, project: p.project }])),
  workerTitle,
  createCase: (fields) => editCases((c) => {
    const made = createCase(c, fields)
    hud.toast(`Case opened — “${fields.title.trim()}” is on the board`)
    return made
  }),
  assign: (caseId, threadId) => {
    editCases((c) => assign(c, caseId, threadId))
    hud.toast(`${workerTitle(threadId)} is on “${state.cases[caseId]?.title}”`)
  },
  unassign: (caseId, threadId) => editCases((c) => unassign(c, caseId, threadId)),
  setCaseStatus: (caseId, status) => editCases((c) => setStatus(c, caseId, status)),
  setCasePriority: (caseId, priority) => editCases((c) => setPriority(c, caseId, priority)),
  removeCase: (caseId) => {
    const title = state.cases[caseId]?.title
    editCases((c) => removeCase(c, caseId))
    hud.toast(`Case deleted — “${title}”`)
  },
  brief: (caseId, threadId) => brief(caseId, threadId),
  showBoard: (caseId) => showBoard(caseId),
})
hud.setDemo(DEMO, STANDALONE)

// ── cases ─────────────────────────────────────────────────────────────────────────────

/**
 * Every change to the cases goes through here: a new `cases` object (never mutated in place, so
 * the merge can tell what this tab did), the boards and desks brought up to date, and a save.
 */
function editCases(fn) {
  const before = state.cases || {}
  const result = fn(before)
  const next = result && result.cases ? result.cases : result
  if (next === before) return result?.id ?? null
  state.cases = next
  lab.setCases(state.cases)
  hud.renderCases()
  if (selectedId) {
    const p = lab.staff.get(selectedId)
    if (p) hud.setSelection(p, p.thread, p.status)
  }
  queueSave()
  return result?.id ?? null
}

/** Copy the case brief and open the worker's thread in its own agent, to paste it in. */
async function brief(caseId, threadId) {
  const c = state.cases[caseId]
  const thread = threads.find((t) => t.id === threadId)
  if (!c || !thread) return
  const text = briefText(c, thread.title)
  let copied = false
  try {
    await navigator.clipboard.writeText(text)
    copied = true
  } catch {
    /* clipboard refused — the toast says so, and the text is still in the case panel */
  }
  if (DEMO) return hud.toast(copied ? 'Brief copied — a demo thread has no agent to open' : 'Could not copy the brief here')
  try {
    await openThread(thread, settings.get('openIn'))
    hud.toast(copied ? `Brief copied — paste it into ${thread.harnessName || 'the agent'}` : `Opened ${thread.harnessName || 'the agent'} — copy the brief from the case panel`)
  } catch (err) {
    hud.toast(err.message || 'Could not open that thread', 'err')
  }
}

/** Walk the camera to the board a case hangs on. */
function showBoard(caseId) {
  const i = lab.boards.boards.findIndex((b) => b.caseId === caseId)
  if (i < 0) return hud.toast('That case is not on a wall right now — the operations room holds twelve boards')
  const slot = lab.facility.boardSlots[i]
  select(null)
  rig.focus(new THREE.Vector3(slot.x, 0, slot.z), { distance: 9 })
  // Stand back from the wall, in front of the board: a board faces along its own heading.
  rig.desiredAzimuth = slot.ry
  rig.desiredPolar = THREE.MathUtils.degToRad(62)
}

// ── selection and navigation ──────────────────────────────────────────────────────────

function select(id) {
  selectedId = id
  const p = id ? lab.staff.get(id) : null
  if (!p) {
    selectedId = null
    rig.setFollow(null)
    rig.setViewportInsets(window.innerWidth, window.innerHeight)
    hud.setSelection(null)
    return
  }
  if (settings.get('followSelected')) rig.setFollow(p)
  else rig.focus(p.pos)
  if (rig.desiredDistance > 26) rig.desiredDistance = 18
  rig.setViewportInsets(window.innerWidth, window.innerHeight, { bottom: window.innerWidth < 700 ? window.innerHeight * 0.45 : 0 })
  hud.setSelection(p, p.thread, p.status)
}

function selectThread(id) {
  const p = lab.staff.get(id)
  if (!p) return hud.toast('That person is not on the floor right now')
  if (!lab.staff.isShown(p)) setFilter('all')
  select(id)
}

function nextWaiting() {
  const waiting = waitingOrder(lab.staff.order.filter((p) => p.mode === 'live'))
  if (!waiting.length) return hud.toast('Nobody is waiting on you')
  const at = waiting.findIndex((p) => p.id === lastWaitingId)
  const next = waiting[(at + 1) % waiting.length]
  lastWaitingId = next.id
  selectThread(next.id)
}

const statusCursor = {}
function cycleStatus(status) {
  const list = lab.staff.order.filter((p) => p.status === status && p.mode === 'live').sort((a, b) => a.id.localeCompare(b.id))
  if (!list.length) return hud.toast(`Nobody is ${(STATUS_LABEL[status] || status).toLowerCase()} right now`)
  statusCursor[status] = ((statusCursor[status] ?? -1) + 1) % list.length
  selectThread(list[statusCursor[status]].id)
}

function openDepartment(name) {
  const p = lab.projects.find((x) => x.name === name)
  if (!p) return
  select(null)
  rig.focus(p.centre, { distance: 30 })
  const staff = () => lab.staff.order.filter((x) => x.project === hud.shelf && x.mode !== 'leaving')
  hud.showShelf(name, lab.staff.order.filter((x) => x.project === name && x.mode !== 'leaving'), staff)
}

function setFilter(key) {
  filterKey = key || 'all'
  lab.staff.filter = filterFor(filterKey)
  hud.setFilter(filterKey)
  const kept = lab.staff.order.filter((p) => lab.staff.isShown(p)).length
  if (filterKey !== 'all') hud.toast(`${kept} people match — everyone else is off the floor`)
  if (selectedId && !lab.staff.isShown(lab.staff.get(selectedId))) select(null)
}

function goHome() {
  select(null)
  hud.closeShelf()
  atGround = false
  hud.setGround(false)
  rig.resetView()
  rig.desiredDistance = 46
  rig.desiredPolar = ISO_POLAR
}

function toggleGround() {
  atGround = !atGround
  hud.setGround(atGround)
  rig.desiredPolar = atGround ? GROUND_POLAR : ISO_POLAR
  rig.desiredDistance = atGround ? 8 : 30
}

function screenshot() {
  if (STANDALONE) return hud.toast('Saving pictures is not available in this hosted copy')
  engine.renderFrame()
  engine.canvas.toBlob((blob) => {
    if (!blob) return hud.toast('Could not save the picture', 'err')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lab-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
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
  if (!DEMO && !stateLoaded) return hud.toast('The saved floor could not be read — reload to archive', 'err')
  if (kind === 'seen') {
    state.viewedAt = { ...(state.viewedAt || {}), [thread.id]: Date.now() }
    hud.toast('Marked as seen')
  } else if (kind === 'archive') {
    state.archived = [...new Set([...state.archived, thread.id])]
    state.archivedAt = { ...state.archivedAt, [thread.id]: Date.now() }
    hud.toast('Archived — clearing their desk and heading for the elevator; the file goes to evidence')
    select(null)
  }
  queueSave()
  applyThreads(rawThreads)
}

// ── picking ───────────────────────────────────────────────────────────────────────────

const _p = new THREE.Vector3()
function personAt(clientX, clientY) {
  const rect = engine.canvas.getBoundingClientRect()
  let best = null
  let bestD = Infinity
  for (const p of lab.staff.order) {
    if (!lab.staff.isShown(p)) continue
    _p.set(p.pos.x, p.seated ? 0.95 : 1.1, p.pos.z).project(engine.camera)
    if (_p.z > 1) continue
    const sx = rect.left + ((_p.x + 1) / 2) * rect.width
    const sy = rect.top + ((1 - _p.y) / 2) * rect.height
    const d = Math.hypot(sx - clientX, sy - clientY)
    const reach = Math.max(16, 1100 / Math.max(1, engine.camera.position.distanceTo(p.pos)))
    if (d < reach && d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
function boardAt(clientX, clientY) {
  const rect = engine.canvas.getBoundingClientRect()
  _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  _ray.setFromCamera(_ndc, engine.camera)
  const hit = _ray.intersectObjects(lab.boards.meshes, false)[0]
  return hit ? lab.boards.caseAt(hit.object) : null
}

engine.canvas.addEventListener('pointerdown', () => sound.unlock())
engine.canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !rig.wasClick) return
  const p = personAt(e.clientX, e.clientY)
  if (p) {
    hud.closeShelf()
    return select(p.id)
  }
  const caseId = boardAt(e.clientX, e.clientY)
  if (caseId) return hud.openCases({ focus: caseId })
  select(null)
})
engine.canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return
  const p = personAt(e.clientX, e.clientY)
  hoverId = p ? p.id : null
  lab.staff.hoverId = hoverId
  engine.canvas.style.cursor = p || boardAt(e.clientX, e.clientY) ? 'pointer' : ''
})
engine.canvas.addEventListener('pointerleave', () => {
  hoverId = null
  lab.staff.hoverId = null
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
  else if (k === 'c') hud.toggleCases()
  else if (k === 'p' && e.shiftKey) screenshot()
  else if (k === 'p') hud.setPhoto(!hud.photo)
  else if (k === '/') {
    e.preventDefault()
    hud.openSearch()
  } else if (k === 'escape') {
    if (hud.photo) hud.setPhoto(false)
    else if (hud.casesOpen) hud.toggleCases(false)
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

function step(dt, elapsed) {
  rig.update(dt)
  // The camera never goes below head height over the floor.
  const cam = engine.camera.position
  if (cam.y < CAMERA_CLEARANCE) {
    cam.y = CAMERA_CLEARANCE
    engine.camera.lookAt(rig.target)
    engine.camera.updateMatrixWorld()
  }
  engine.setFocusDistance(cam.distanceTo(rig.target))
  return lab.update(dt, elapsed, engine.camera, rig.target, selectedId)
}

engine.add({
  update(dt, elapsed) {
    driveKeys(dt)
    const light = step(dt, elapsed)
    hud.frame(engine, rig, lab, selectedId, light, hoverId)
    if (sound.ctx) {
      let busy = 0
      for (const p of lab.staff.order) if (p.status === 'working' && p.pos.distanceTo(engine.camera.position) < 25) busy++
      sound.update(busy)
    }
  },
})

settings.onChange((changed, scope) => {
  if (scope.render || changed.has('fov')) engine.applySettings()
  if (changed.has('particles') || changed.has('shadows') || changed.has('ibl') || changed.has('preset')) lab.applySettings()
  if (changed.has('maxAgents') || changed.has('hideDormant')) applyThreads(rawThreads)
  if (changed.has('labSound') && settings.get('labSound')) sound.unlock()
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
  const known = new Set(Object.keys(state.seen || {}))
  let firstSeen = false
  for (const t of threads) {
    if (state.seen?.[t.id]) continue
    state.seen = { ...(state.seen || {}), [t.id]: Date.now() }
    firstSeen = true
  }

  lab.cases = state.cases || {}
  const stats = lab.setThreads(threads, archivedSet, hiddenSet, known)
  hud.setStats(stats, lab.capped)
  hud.setProjects(lab.projects)
  if (filterKey !== 'all') lab.staff.filter = filterFor(filterKey)
  hud.renderCases()

  const waitingNow = new Set(lab.staff.order.filter((p) => p.status === 'waiting' && p.mode !== 'leaving').map((p) => p.id))
  if (!firstRoster && [...waitingNow].some((id) => !waitingBefore.has(id))) sound.call()
  waitingBefore.clear()
  for (const id of waitingNow) waitingBefore.add(id)
  firstRoster = false

  if (selectedId) {
    const p = lab.staff.get(selectedId)
    if (p && p.mode !== 'leaving') hud.setSelection(p, p.thread, p.status)
    else select(null)
  }

  const layout = JSON.stringify(lab.layoutForSave())
  if (layout !== lastLayout) {
    lastLayout = layout
    state.labRooms = lab.layoutForSave()
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
      lab.setCases(state.cases || {})
    } catch {
      /* the floor still runs; the archive list and cases retry on the next change */
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
    for (const t of first) state.seen[t.id] = Date.now()
    if (!params.has('check')) state.cases = demoCases(first.map((t) => t.id))
    applyThreads(first)
    lab.setCases(state.cases)
    hud.removeBoot()
    if (!params.has('check')) demoTimer = setInterval(() => applyThreads(demoTick(random)), 9000)
  } else {
    try {
      state = await fetchState()
      state.cases ||= {}
      stateLoaded = true
      lab.restoreLayout(state.labRooms)
    } catch {
      hud.toast('Could not read the saved floor — archiving and cases are off until you reload', 'err')
    }
    await poll()
    setInterval(poll, POLL_MS)
  }
  engine.start()
  if (params.has('check')) {
    const { runChecks } = await import('./checks.js')
    runChecks(window.__lab)
  }
}

// Exposed for the check suite.
window.__lab = {
  engine,
  lab,
  rig,
  hud,
  settings,
  sound,
  select,
  selectThread,
  nextWaiting,
  setFilter,
  openDepartment,
  toggleGround,
  applyThreads,
  editCases,
  showBoard,
  personAt,
  boardAt,
  get state() {
    return state
  },
  get selectedId() {
    return selectedId
  },
  stopDemo() {
    clearInterval(demoTimer)
  },
  stats() {
    const s = lab.staff.stats
    return {
      people: lab.staff.order.length,
      desks: lab.desks.count,
      drawCalls: engine.perf.drawCalls,
      frames: s.frames,
      wallHits: s.wallHits,
      overlaps: s.overlaps,
      pushes: s.pushes,
      paths: s.paths,
      pathFails: s.pathFails,
      gaveUp: s.gaveUp,
      seated: s.seated,
      minGap: Number.isFinite(s.minGap) ? Number(s.minGap.toFixed(3)) : null,
      cases: Object.keys(state.cases || {}).length,
      boardsShowing: lab.boards.boards.filter((b) => b.caseId).length,
      statuses: Object.fromEntries(STATUS_ORDER.map((k) => [k, lab.staff.order.filter((p) => p.status === k).length])),
    }
  },
  simulate(seconds, dt = 1 / 30) {
    const start = engine.elapsed
    for (let t = 0; t < seconds; t += dt) {
      engine.elapsed += dt
      step(dt, engine.elapsed)
    }
    return engine.elapsed - start
  },
  ordered,
  statusFor,
  PRESETS,
}

boot()
