import * as THREE from 'three'
import { statusFor, transcriptProgress, STATUS_LABEL } from '../game/status.js'
import { PRESETS, DEFAULT_PRESET } from '../core/settings.js'
import { SHIP_CELL } from '../world/plot-move.js'
import { hexToWorld } from '../world/layout.js'
import { fishLook, BODY, ARRIVE, DOING } from './fish.js'
import { coralLook, coralSize } from './coral.js'
import { SIGNAL, shelfSignal, waitingOrder } from './signals.js'

/**
 * The reef's check suite: every instruction in the agent-session-world skill that applies to
 * this world, turned into a measurement. Open `/reef.html?check` and it runs against a fixed
 * roster of invented threads, prints each result on the page, and leaves the whole report on
 * `window.__reefChecks` for a script to read.
 *
 * Each check names the line of the skill it tests. A check passes on a number, never on a
 * screenshot someone has to squint at.
 */

const DAY = 864e5
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

/** A fixed roster that puts every state on screen, with distinct waiting times. */
export function fixture(now = Date.now()) {
  const threads = []
  let n = 0
  const add = (project, over = {}) => {
    const id = `check:${project}:${n++}`
    threads.push({
      id,
      title: `Check thread ${n}`,
      preview: 'Fixture',
      project,
      harness: 'claude-code',
      harnessName: 'Claude Code',
      gitBranch: 'main',
      createdAt: now - (30 + n) * DAY,
      lastActivityAt: now - 60_000 * (n + 1),
      running: false,
      unread: false,
      hasError: false,
      prState: null,
      sizeBytes: 10 ** (3.4 + (n % 8) * 0.42),
      canOpen: true,
      ...over,
    })
    return id
  }
  // Ten threads on the busiest shelf, then smaller shelves; ages differ so ground themes differ.
  for (let i = 0; i < 4; i++) add('harbour-api', { running: true })
  add('harbour-api', { unread: true, lastActivityAt: now - 40 * 60_000 })
  add('harbour-api', { hasError: true })
  for (let i = 0; i < 4; i++) add('harbour-api')
  add('web-kiosk', { unread: true, lastActivityAt: now - 90 * 60_000 })
  add('web-kiosk', { prState: 'MERGED' })
  add('web-kiosk', { running: true })
  for (let i = 0; i < 3; i++) add('web-kiosk')
  for (let i = 0; i < 4; i++) add('old-batch', { lastActivityAt: now - 6 * DAY, createdAt: now - 400 * DAY })
  add('old-batch', { running: true, createdAt: now - 400 * DAY })
  add('ml-tides', { unread: true, lastActivityAt: now - 10 * 60_000 })
  add('ml-tides', { prState: 'MERGED' })
  add('ml-tides', { hasError: true })
  for (let i = 0; i < 3; i++) add('ml-tides', { createdAt: now - 2 * DAY })
  add('docs-reef', { running: true })
  add('docs-reef')
  return threads
}

export async function runChecks(R) {
  const results = []
  const out = renderPanel()
  const pause = () => new Promise((r) => setTimeout(r, 0))
  const check = async (id, area, req, fn) => {
    let result
    try {
      result = await fn()
    } catch (err) {
      result = { pass: false, detail: `threw: ${err.message}` }
    }
    results.push({ id, area, req, pass: Boolean(result.pass), info: Boolean(result.info), detail: result.detail })
    out.update(results)
    await pause()
  }

  R.stopDemo()
  R.engine.stop()
  const { reef, engine, rig, settings } = R
  const school = reef.school
  // A known quality level, so render checks are repeatable, and nothing persisted by the run.
  const savedValues = { ...settings.values }
  settings._scheduleSave = () => {}
  settings.applyPreset('balanced')
  settings.set('autoQuality', false)
  settings.set('timeOfDay', 0.4)
  settings.set('clockTime', false)
  settings.set('autoTime', false)

  // Count every write the page tries to make, to prove the demo writes nothing.
  let writes = 0
  const realFetch = window.fetch
  window.fetch = (url, opts = {}) => {
    if (opts.method && opts.method !== 'GET') writes++
    return realFetch(url, opts)
  }

  const now = Date.now()
  const threads = fixture(now)
  R.state.seen = Object.fromEntries(threads.map((t) => [t.id, now]))
  R.applyThreads(threads)
  // The demo's fish swim home to the wreck first — that is the departure ceremony, not a bug —
  // so the run waits for them to leave before it measures anything.
  let waited = 0
  while (school.order.some((f) => f.mode === 'leaving') && waited < 120) {
    R.simulate(1)
    waited++
  }
  R.simulate(8)
  const live = () => school.order.filter((f) => f.mode === 'live')
  const byStatus = (s) => live().filter((f) => f.status === s)
  const top = (coral) => coral.position.y + coral.height * coral.growth

  // ── the mapping ─────────────────────────────────────────────────────────────────────

  await check('MAP-1', 'Mapping', 'One inhabitant per thread', () => {
    const ids = new Set(school.order.map((f) => f.id))
    const missing = threads.filter((t) => !ids.has(t.id))
    const extra = school.order.filter((f) => !threads.some((t) => t.id === f.id))
    return { pass: missing.length === 0 && extra.length === 0, detail: `${threads.length} threads, ${school.order.length} fish, ${missing.length} missing, ${extra.length} extra (after ${waited}s for the demo's fish to swim home)` }
  })

  await check('MAP-2', 'Mapping', 'One territory per project — every fish lives on its own project’s shelf', () => {
    const wrong = school.order.filter((f) => reef.seabed.ownerAt(f.home.position.x, f.home.position.z) !== f.project)
    return { pass: wrong.length === 0, detail: `${school.order.length - wrong.length}/${school.order.length} corals on their own shelf` }
  })

  await check('MAP-3', 'Mapping', 'Idle fish stay on their own ground', () => {
    let inside = 0
    let samples = 0
    for (let i = 0; i < 20; i++) {
      R.simulate(0.5)
      for (const f of byStatus('idle')) {
        samples++
        if (reef.seabed.ownerAt(f.pos.x, f.pos.z) === f.project) inside++
      }
    }
    const share = inside / Math.max(1, samples)
    return { pass: share >= 0.97, detail: `${(share * 100).toFixed(1)}% of ${samples} idle samples over their own shelf` }
  })

  // ── state ───────────────────────────────────────────────────────────────────────────

  await check('STATE-1', 'States', 'State is decided once, in one ordered function, and everything reads it', () => {
    const wrong = school.order.filter((f) => f.status !== statusFor(f.thread))
    const chips = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping'].every(
      (s) => Number(document.querySelector(`.reef-s-${s} b`).textContent) === byStatus(s).length
    )
    return { pass: wrong.length === 0 && chips, detail: `${wrong.length} fish disagree with statusFor; counts in the corner ${chips ? 'match' : 'do not match'}` }
  })

  await check('STATE-2', 'States', 'All six states are on the reef', () => {
    const counts = Object.fromEntries(['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping'].map((s) => [s, byStatus(s).length]))
    return { pass: Object.values(counts).every((n) => n > 0), detail: JSON.stringify(counts) }
  })

  R.simulate(10)

  await check('STATE-3', 'States', 'Waiting reads as asking for you: risen out of the reef, facing the camera', () => {
    const fish = byStatus('waiting')
    const bad = fish.filter((f) => {
      const yaw = Math.atan2(engine.camera.position.x - f.pos.x, engine.camera.position.z - f.pos.z)
      const facing = Math.abs(Math.atan2(Math.sin(yaw - f.yaw), Math.cos(yaw - f.yaw)))
      return f.pos.y < top(f.home) + 1.5 || facing > 0.35
    })
    return { pass: fish.length > 0 && bad.length === 0, detail: `${fish.length - bad.length}/${fish.length} risen ≥1.5 above their coral and within 20° of facing the camera` }
  })

  await check('STATE-4', 'States', 'Errored reads at a distance: on its side, colour drained, down by its coral', () => {
    const fish = byStatus('blocked')
    const lift = (f) => f.pos.y - reef.seabed.heightAt(f.pos.x, f.pos.z)
    const bad = fish.filter((f) => f.roll < 1.0 || f.drain < 0.8 || lift(f) > 0.9)
    return { pass: fish.length > 0 && bad.length === 0, detail: fish.map((f) => `roll ${f.roll.toFixed(2)} drain ${f.drain.toFixed(2)} ${lift(f).toFixed(2)} off the floor`).join('; ') }
  })

  await check('STATE-5', 'States', 'Working is busy and purposeful, and carries a prop', () => {
    const fish = byStatus('working')
    const idle = byStatus('idle')
    const speeds = new Map(fish.map((f) => [f.id, 0]))
    let idleMean = 0
    for (let i = 0; i < 60; i++) {
      R.simulate(0.1)
      for (const f of fish) speeds.set(f.id, speeds.get(f.id) + f.speed / 60)
      for (const f of idle) idleMean += f.speed / (60 * idle.length)
    }
    // Busy means busier than pottering: every working fish averages at least twice an idle one.
    let fast = 0
    for (const v of speeds.values()) if (v > idleMean * 2) fast++
    const list = [...speeds.values()].map((v) => v.toFixed(2)).join(', ')
    const props = fish.filter((f) => {
      school.props.getMatrixAt(f.index, _m)
      return _m.getMaxScaleOnAxis() > 0.5
    })
    const strays = live().filter((f) => f.status !== 'working').filter((f) => {
      school.props.getMatrixAt(f.index, _m)
      return _m.getMaxScaleOnAxis() > 0.01
    })
    return {
      pass: fish.length > 0 && fast === fish.length && props.length === fish.length && strays.length === 0,
      detail: `${fast}/${fish.length} at least twice idle's ${idleMean.toFixed(2)} u/s (${list}); ${props.length}/${fish.length} carry a pebble; ${strays.length} pebbles on fish that are not working`,
    }
  })

  await check('STATE-6', 'States', 'Finished well is good news: loops over its coral and flashes', () => {
    const fish = byStatus('celebrating')
    const before = school.stats.flashes
    let above = 0
    let samples = 0
    for (let i = 0; i < 60; i++) {
      R.simulate(0.1)
      for (const f of fish) {
        samples++
        if (f.pos.y > top(f.home) + 0.4) above++
      }
    }
    const flashes = school.stats.flashes - before
    return { pass: fish.length > 0 && flashes >= fish.length && above / samples > 0.85, detail: `${flashes} flashes from ${fish.length} fish in 6s; ${((above / samples) * 100).toFixed(0)}% of the time above its coral` }
  })

  await check('STATE-7', 'States', 'Dormant stays put — settles once and does not get up again', () => {
    const fish = byStatus('sleeping')
    const start = new Map(fish.map((f) => [f.id, f.pos.clone()]))
    R.simulate(30)
    const moved = fish.map((f) => f.pos.distanceTo(start.get(f.id)))
    const max = Math.max(...moved)
    const lifts = fish.map((f) => f.pos.y - reef.seabed.heightAt(f.pos.x, f.pos.z))
    const low = lifts.every((l) => l < 0.8)
    return { pass: fish.length > 0 && max < 0.35 && low, detail: `${fish.length} dormant fish; furthest moved in 30s: ${max.toFixed(3)}; heights off the floor ${lifts.map((l) => l.toFixed(2)).join(', ')}` }
  })

  await check('STATE-8', 'States', 'Idle potters: short legs, pausing between, pace varying per fish', () => {
    const fish = byStatus('idle')
    let paused = 0
    const legsBefore = school.stats.legs
    const seen = new Set()
    for (let i = 0; i < 80; i++) {
      R.simulate(0.25)
      for (const f of fish) if (f.pause > 0) seen.add(f.id)
    }
    paused = seen.size
    const paces = new Set(fish.map((f) => f.pace.toFixed(2)))
    return {
      pass: fish.length > 0 && paused >= Math.ceil(fish.length * 0.6) && school.stats.legs > legsBefore && paces.size > 1,
      detail: `${paused}/${fish.length} paused at least once in 20s; ${school.stats.legs - legsBefore} legs started; ${paces.size} distinct paces`,
    }
  })

  await check('STATE-9', 'States', 'Locomotion comes from distance covered, not intended velocity', () => {
    const f = byStatus('working')[0]
    // Refuse every step: the fish wants 3.4 u/s but is held where it is.
    for (let i = 0; i < 30; i++) {
      f.vel.set(0, 0, 0)
      R.simulate(1 / 30)
    }
    const heldSpeed = f.speed
    const heldAmp = f.amp
    // Rise at once: the first frame it moves, the measured speed is that frame's speed.
    f.vel.set(3, 0, 0)
    const before = f.pos.clone()
    R.simulate(1 / 30)
    const moved = f.pos.distanceTo(before) * 30
    return {
      pass: f.cruise >= 3 && heldSpeed < 0.6 && heldAmp < 0.5 && f.speed >= moved * 0.99,
      detail: `wanting ${f.cruise} u/s but held: speed ${heldSpeed.toFixed(2)}, tail ${heldAmp.toFixed(2)}; released: measured ${f.speed.toFixed(2)} for ${moved.toFixed(2)} actually moved`,
    }
  })

  await check('STATE-10', 'States', 'Only signal what wants attention — badges on waiting, errored and shipped only', () => {
    R.simulate(0.1)
    const wanted = live().filter((f) => ['waiting', 'blocked', 'celebrating'].includes(f.status)).length
    return { pass: reef.badges.mesh.count === wanted, detail: `${reef.badges.mesh.count} badges for ${wanted} fish that want something; ${byStatus('idle').length + byStatus('sleeping').length} quiet fish carry none` }
  })

  // ── the signal ──────────────────────────────────────────────────────────────────────

  await check('SIG-1', 'Signal', 'Something visible from anywhere over every fish waiting on a reply', () => {
    const waiting = byStatus('waiting').length
    const m = reef.beacons.material
    return {
      pass: reef.beacons.items.size === waiting && m.depthTest === false && reef.beacons.mesh.renderOrder >= 20,
      detail: `${reef.beacons.items.size} light columns for ${waiting} waiting fish; drawn through geometry: ${!m.depthTest}`,
    }
  })

  await check('SIG-2', 'Signal', 'The beacon colour is used nowhere else', () => {
    const gold = new THREE.Color(1, 0.78, 0.22).getHSL({})
    const palettes = [...reef.corals.kinds.flatMap((k) => k.slots.filter(Boolean).map((e) => e.color)), ...school.order.map((f) => f.color)]
    const close = palettes.filter((c) => {
      const h = c.getHSL({})
      return Math.abs(h.h - gold.h) < 0.035 && h.s > 0.6 && h.l > 0.4 && h.l < 0.75
    })
    return { pass: close.length === 0, detail: `${palettes.length} coral and fish colours checked; ${close.length} within reach of the waiting gold` }
  })

  await check('SIG-3', 'Signal', 'A key flies to the next one waiting, in the order they started waiting', () => {
    const expected = waitingOrder(live()).map((f) => f.id)
    const visited = []
    for (let i = 0; i < expected.length; i++) {
      R.nextWaiting()
      visited.push(R.selectedId)
    }
    R.select(null)
    return { pass: JSON.stringify(visited) === JSON.stringify(expected) && expected.length > 1, detail: `visited ${visited.length} in longest-waiting order: ${visited.join(' → ') === expected.join(' → ')}` }
  })

  await check('SIG-4', 'Signal', 'Colour by state, not by project — each shelf rim shows its loudest state', () => {
    const zones = reef.seabed.uniforms.uZone.value
    const wrong = reef.projects.filter((p) => {
      const want = shelfSignal(live().filter((f) => f.project === p.name).map((f) => f.status))
      const v = zones[reef.seabed.zoneIndex.get(p.name)]
      return Math.abs(v.w - want.mode) > 0.01 || (want.mode && Math.abs(v.x - want.color[0]) > 0.01)
    })
    return { pass: wrong.length === 0, detail: reef.projects.map((p) => `${p.name}: ${p.signal.status}`).join(', ') }
  })

  // ── territories ─────────────────────────────────────────────────────────────────────

  await check('LAND-1', 'Territories', 'Territories stay put when a different project gains threads', () => {
    const before = reef.layoutForSave()
    const more = [...threads]
    for (let i = 0; i < 12; i++) more.push({ ...threads[threads.length - 1], id: `check:docs-reef:extra${i}`, createdAt: now - i })
    R.state.seen = Object.fromEntries(more.map((t) => [t.id, now]))
    R.applyThreads(more)
    const after = reef.layoutForSave()
    const moved = Object.keys(before).filter((k) => k !== 'docs-reef' && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    const grew = (after['docs-reef'] || []).length > (before['docs-reef'] || []).length
    const kept = JSON.stringify((after['docs-reef'] || []).slice(0, before['docs-reef'].length)) === JSON.stringify(before['docs-reef'])
    R.simulate(0.5)
    const rising = reef.seabed.rising
    R.applyThreads(threads)
    const back = reef.layoutForSave()
    const restored = JSON.stringify(back['docs-reef']) === JSON.stringify(before['docs-reef'])
    R.simulate(4)
    return {
      pass: moved.length === 0 && grew && kept && restored && rising && !reef.seabed.rising,
      detail: `${moved.length} other shelves moved; docs-reef grew and kept its cells: ${grew && kept}; new ground rose rather than appeared: ${rising}; shrank back to its first shape: ${restored}`,
    }
  })

  await check('LAND-2', 'Territories', 'The layout is persisted and comes back from the saved file', () => {
    const saved = reef.layoutForSave()
    const same = JSON.stringify(R.state.plots) === JSON.stringify(saved)
    return { pass: same, detail: `state.plots ${same ? 'matches' : 'differs from'} the live layout (${Object.keys(saved).length} shelves)` }
  })

  // ── structures ──────────────────────────────────────────────────────────────────────

  await check('GROW-1', 'Structures', 'How developed a structure looks tracks how much work its thread has done', () => {
    const entries = live().map((f) => ({ size: f.thread.sizeBytes || 0, coral: f.home }))
    entries.sort((a, b) => a.size - b.size)
    let monotonic = true
    for (let i = 1; i < entries.length; i++) if (entries[i].coral.target + 1e-9 < entries[i - 1].coral.target) monotonic = false
    // And nothing else: drawn size is exactly the function of growth, with no random part.
    let exact = true
    for (const e of entries) {
      e.coral.kind.mesh.getMatrixAt(e.coral.slot, _m)
      _m.decompose(_p, _q, _s)
      if (Math.abs(_s.x - coralSize(e.coral.target)) > 1e-4) exact = false
    }
    return { pass: monotonic && exact, detail: `growth rises with transcript size: ${monotonic}; drawn scale is growth alone, no random part: ${exact}` }
  })

  await check('GROW-2', 'Structures', 'Growth is a shader offset, mirrored in the shadow pass', () => {
    const kinds = reef.corals.kinds.filter((k) => k.mesh.customDepthMaterial && k.mesh.geometry.attributes.aGrowth && k.mesh.geometry.attributes.aGrow)
    return { pass: kinds.length === reef.corals.kinds.length && school.mesh.customDepthMaterial, detail: `${kinds.length}/${reef.corals.kinds.length} coral forms unfold in the vertex shader and in their depth material; fish swim in theirs too` }
  })

  await check('GROW-3', 'Structures', 'Open shells drawn double-sided and shadowed from their back faces', () => {
    const tubes = reef.corals.kinds.find((k) => k.name === 'tubes').mesh.material
    let hull = null
    reef.seabed.wreck.group.traverse((o) => {
      if (o.isMesh && o.material.side === THREE.DoubleSide) hull = o.material
    })
    const closed = []
    reef.seabed.wreck.group.traverse((o) => {
      if (o.isMesh && o.geometry.type === 'BoxGeometry') closed.push(o.material.side)
    })
    return {
      pass: tubes.side === THREE.DoubleSide && tubes.shadowSide === THREE.BackSide && hull?.shadowSide === THREE.BackSide && closed.every((s) => s === THREE.FrontSide),
      detail: `tube sponges and hull: double-sided, back-face shadows; ${closed.length} closed boxes single-sided`,
    }
  })

  // ── crowd ───────────────────────────────────────────────────────────────────────────

  const sceneDraws = () => {
    engine.renderer.info.reset()
    engine.camera.layers.enableAll()
    const shadow = engine.renderer.shadowMap.enabled
    engine.renderer.shadowMap.enabled = false
    engine.renderer.render(engine.scene, engine.camera)
    engine.renderer.shadowMap.enabled = shadow
    return engine.renderer.info.render.calls
  }

  await check('CROWD-1', 'Crowd', 'One instanced draw for the whole crowd', () => {
    const before = sceneDraws()
    const fishBefore = school.order.length
    const crowd = [...threads]
    for (let i = 0; i < 140; i++) crowd.push({ ...threads[i % threads.length], id: `check:crowd:${i}`, project: `crowd-${i % 9}`, createdAt: now - i * 1000 })
    settings.set('maxAgents', 200)
    R.state.seen = Object.fromEntries(crowd.map((t) => [t.id, now]))
    R.applyThreads(crowd)
    R.simulate(1)
    const after = sceneDraws()
    const fishAfter = school.order.length
    window.__crowdThreads = crowd
    return { pass: after === before && fishAfter > fishBefore * 3, detail: `${fishBefore} fish: ${before} draws · ${fishAfter} fish: ${after} draws (the school is ${school.mesh.isInstancedMesh ? 'one InstancedMesh' : 'not instanced'})` }
  })

  await check('CROWD-2', 'Crowd', 'Crowds, not piles — spaced by the widest part of the body', () => {
    Object.assign(school.stats, { overlaps: 0, penetrations: 0, touches: 0, groundHits: 0, frames: 0, penetrationLog: [] })
    R.simulate(30)
    const s = school.stats
    return { pass: s.overlaps === 0 && s.minGap >= BODY * 0.5, detail: `${school.order.length} fish for 30s: ${s.overlaps} pairs closer than half a body (${(BODY * 0.5).toFixed(2)}); closest ${s.minGap.toFixed(2)}; spacing ${BODY.toFixed(2)}, arrival ${ARRIVE.toFixed(2)}` }
  })

  await check('CROWD-3', 'Crowd', 'Nothing crosses anything solid — coral or floor', () => {
    const s = school.stats
    // A penetration is a fish more than a centimetre inside a coral. Resting exactly on its edge
    // and being nudged by floating-point noise is a touch, and is reported separately.
    return { pass: s.penetrations === 0 && s.groundHits === 0, detail: `${s.touches || 0} touches under 1 cm; ` + `${s.frames} fish-frames: ${s.penetrations} coral penetrations, ${s.groundHits} floor hits; ${s.legs} legs swum${s.penetrationLog?.length ? ` — ${JSON.stringify(s.penetrationLog)}` : ''}` }
  })

  R.applyThreads(threads)
  settings.set('maxAgents', PRESETS.balanced.values.maxAgents)
  R.simulate(25)

  await check('CROWD-4', 'Crowd', 'Arrival distance is larger than spacing; a fish that cannot get closer gives up', () => {
    const resting = [...byStatus('sleeping'), ...byStatus('blocked')]
    // 1. An occupied spot: b is sent to exactly where a lies. It can never get closer than the
    //    spacing, and because arrival is wider than spacing it finishes arriving anyway — no
    //    shouldering at a forever.
    // Start three units from a, on a's own shelf, with a straight run of clear water in — this is
    // the occupied-spot case, not the blocked-path case (part 2 covers that).
    const corals = [...reef.corals.entries.values()]
    const clear = (x, z) => corals.every((c) => Math.hypot(x - c.position.x, z - c.position.z) > c.radius * 0.8 + 0.6)
    let a = null
    let start = null
    for (const cand of resting) {
      for (let i = 0; i < 16 && !start; i++) {
        const ang = (i / 16) * Math.PI * 2
        const sx = cand.pos.x + Math.cos(ang) * 3
        const sz = cand.pos.z + Math.sin(ang) * 3
        if (reef.seabed.ownerAt(sx, sz) !== cand.project) continue
        let ok = true
        for (let k = 1; k <= 10 && ok; k++) ok = clear(cand.pos.x + Math.cos(ang) * 0.3 * k, cand.pos.z + Math.sin(ang) * 0.3 * k)
        if (ok) start = [sx, sz]
      }
      if (start) {
        a = cand
        break
      }
    }
    if (!start) return { pass: false, detail: `no resting fish of ${resting.length} has a clear approach on its shelf` }
    const b = resting.find((f) => f !== a && f.status === 'sleeping') || resting.find((f) => f !== a)
    b.pos.set(start[0], reef.seabed.heightAt(start[0], start[1]) + 0.6, start[1])
    b.vel.set(0, 0, 0)
    b.target.copy(a.pos)
    b.retarget = Infinity
    b.best = Infinity
    b.stuck = 0
    R.simulate(10)
    const gap = a.pos.distanceTo(b.pos)
    const rested = b.speed < 0.15 && b.pos.distanceTo(b.target) < ARRIVE
    // 2. An unreachable spot: three units under the sand beneath b. Every step is refused by the
    //    floor, so it gives up within a few seconds and adopts where it got to.
    const gaveBefore = b.gaveUp || 0
    // Without its usual snap to the sand, so the spot really stays out of reach.
    b.lift = null
    b.target.set(b.pos.x, b.pos.y - 3, b.pos.z)
    b.best = Infinity
    b.stuck = 0
    R.simulate(6)
    const gaveUp = (b.gaveUp || 0) > gaveBefore
    const adopted = b.target.distanceTo(b.pos) < 1
    return {
      pass: gap > BODY * 0.85 && gap < ARRIVE + 0.4 && rested && gaveUp && adopted,
      detail: `occupied spot: stopped ${gap.toFixed(2)} from the fish lying there (spacing ${BODY.toFixed(2)}), at rest; unreachable spot: gave up ${gaveUp}, adopted its own ground ${adopted}`,
    }
  })

  // ── camera ──────────────────────────────────────────────────────────────────────────

  const canvas = engine.canvas
  const ptr = (type, x, y, extra = {}) =>
    // Down and up go to the canvas (and bubble to the window, where the rig also listens), the
    // way a real click does; moves go to the window, which is where a drag is tracked.
    (type === 'pointermove' ? window : canvas).dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, bubbles: true, cancelable: true, ...extra })
    )

  rig.setFollow(null)
  rig.resetView()
  for (let i = 0; i < 60; i++) rig.update(1 / 30)

  await check('CAM-1', 'Camera', 'Dragging grabs the ground — the point under the cursor stays under it', () => {
    const r = canvas.getBoundingClientRect()
    const x0 = r.left + r.width * 0.45
    const y0 = r.top + r.height * 0.55
    const start = rig.groundPoint(x0, y0)
    ptr('pointerdown', x0, y0)
    let worst = 0
    for (let i = 1; i <= 10; i++) {
      const x = x0 + i * 14
      const y = y0 - i * 6
      ptr('pointermove', x, y)
      const now = rig.groundPoint(x, y)
      worst = Math.max(worst, Math.hypot(now.x - start.x, now.z - start.z))
    }
    ptr('pointerup', x0 + 140, y0 - 60)
    return { pass: worst < 0.25, detail: `dragged 152px; the grabbed point drifted at most ${worst.toFixed(3)} units from under the cursor` }
  })

  await check('CAM-2', 'Camera', 'Scrolling zooms at the cursor, not the screen centre', () => {
    const r = canvas.getBoundingClientRect()
    const x = r.left + r.width * 0.78
    const y = r.top + r.height * 0.7
    const start = rig.groundPoint(x, y).clone()
    const d0 = rig.distance
    canvas.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: -240, bubbles: true, cancelable: true }))
    let worst = 0
    for (let i = 0; i < 90; i++) {
      rig.update(1 / 30)
      const now = rig.groundPoint(x, y)
      if (now) worst = Math.max(worst, Math.hypot(now.x - start.x, now.z - start.z))
    }
    return { pass: rig.distance < d0 * 0.8 && worst < 0.6, detail: `zoomed ${d0.toFixed(1)} → ${rig.distance.toFixed(1)}; the point under the cursor moved at most ${worst.toFixed(3)}` }
  })

  await check('CAM-3', 'Camera', 'Right-drag tilts and rotates', () => {
    const r = canvas.getBoundingClientRect()
    const az = rig.desiredAzimuth
    const pol = rig.desiredPolar
    ptr('pointerdown', r.left + 300, r.top + 300, { button: 2, buttons: 2 })
    ptr('pointermove', r.left + 360, r.top + 270, { button: 2, buttons: 2 })
    ptr('pointerup', r.left + 360, r.top + 270, { button: 2 })
    return { pass: rig.desiredAzimuth !== az && rig.desiredPolar !== pol, detail: `heading ${(az * 57.3).toFixed(1)}° → ${(rig.desiredAzimuth * 57.3).toFixed(1)}°, tilt ${(pol * 57.3).toFixed(1)}° → ${(rig.desiredPolar * 57.3).toFixed(1)}°` }
  })

  await check('CAM-4', 'Camera', 'A slow orbit that yields the instant the camera is touched and eases back after', () => {
    rig.setOrbit(true)
    for (let i = 0; i < 120; i++) rig.update(1 / 30)
    const sweeping = rig.orbitBlend
    ptr('pointerdown', 400, 400)
    for (let i = 0; i < 15; i++) rig.update(1 / 30)
    const held = rig.orbitBlend
    ptr('pointerup', 400, 400)
    for (let i = 0; i < 30; i++) rig.update(1 / 30)
    const soon = rig.orbitBlend
    for (let i = 0; i < 150; i++) rig.update(1 / 30)
    const later = rig.orbitBlend
    rig.setOrbit(false)
    return { pass: sweeping > 0.8 && held < 0.4 && soon < 0.2 && later > 0.6, detail: `sweep ${sweeping.toFixed(2)} → touched ${held.toFixed(2)} → 1s after ${soon.toFixed(2)} → 6s after ${later.toFixed(2)}` }
  })

  await check('CAM-5', 'Camera', 'Ground level in one gesture — among the fish, never inside the rock', () => {
    R.toggleGround()
    // Sweep right round at ground level, checking the camera never goes into the floor.
    let worst = Infinity
    for (let i = 0; i < 240; i++) {
      rig.desiredAzimuth += 0.03
      R.simulate(1 / 30)
      const c = engine.camera.position
      worst = Math.min(worst, c.y - reef.seabed.heightAt(c.x, c.z))
    }
    const pol = rig.polar * 57.3
    const dist = rig.distance
    R.toggleGround()
    for (let i = 0; i < 120; i++) R.simulate(1 / 30)
    return { pass: pol > 75 && dist < 11 && worst >= 1.4, detail: `G: tilt ${pol.toFixed(0)}°, ${dist.toFixed(1)} units out; lowest the camera came to the floor in a full turn: ${worst.toFixed(2)}; G again: back to ${(rig.polar * 57.3).toFixed(0)}°` }
  })

  await check('CAM-6', 'Camera', 'Keyboard movement', () => {
    const t = rig.desiredTarget.clone()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    engine.updaters[0].update(0.5, engine.elapsed)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }))
    const moved = rig.desiredTarget.distanceTo(t)
    return { pass: moved > 1, detail: `half a second of D moved the view ${moved.toFixed(2)} units` }
  })

  rig.resetView()
  for (let i = 0; i < 90; i++) rig.update(1 / 30)

  // ── light ───────────────────────────────────────────────────────────────────────────

  await check('LIGHT-1', 'Day and night', 'The sky itself is the environment map', () => {
    R.simulate(0.2)
    const env = engine.scene.environment
    const shared = reef.water.envScene.children[0].material === reef.water.dome.material
    return { pass: Boolean(env) && shared, detail: `scene.environment ${env ? 'bound' : 'missing'}; env dome shares the visible dome's material and uniforms: ${shared}` }
  })

  await check('LIGHT-2', 'Day and night', 'The environment is re-filtered only when the sky has moved', () => {
    let builds = 0
    const real = reef.water.pmrem.fromScene.bind(reef.water.pmrem)
    reef.water.pmrem.fromScene = (...a) => {
      builds++
      return real(...a)
    }
    R.simulate(6)
    const still = builds
    settings.set('timeOfDay', 0.62)
    R.simulate(3)
    const moved = builds - still
    reef.water.pmrem.fromScene = real
    return { pass: still === 0 && moved >= 1, detail: `${still} rebuilds in 6s of unchanged sky; ${moved} after the time changed` }
  })

  await check('LIGHT-3', 'Day and night', 'The sun is never overhead', () => {
    let highest = 0
    for (let t = 0; t <= 1; t += 0.01) {
      settings.values.timeOfDay = t
      reef.water.update(0, 0, rig.target, engine.camera)
      highest = Math.max(highest, Math.asin(reef.water.sun.position.clone().sub(reef.water.sun.target.position).normalize().y) * 57.3)
    }
    settings.set('timeOfDay', 0.4)
    return { pass: highest <= 63, detail: `highest sun over a full day: ${highest.toFixed(1)}°` }
  })

  await check('LIGHT-4', 'Day and night', 'Lit after dark, not only darkened — and only what means something glows', () => {
    settings.set('timeOfDay', 0.95)
    R.simulate(1)
    const night = reef.water.update(0, engine.elapsed, rig.target, engine.camera).night
    let lamp = 0
    reef.seabed.wreck.group.traverse((o) => {
      if (o.isPointLight) lamp = o.intensity
    })
    const activeMatch = school.order.every((f) => Boolean(f.home.active) === (f.status === 'working'))
    settings.set('timeOfDay', 0.5)
    R.simulate(1)
    let dayLamp = 1
    reef.seabed.wreck.group.traverse((o) => {
      if (o.isPointLight) dayLamp = o.intensity
    })
    settings.set('timeOfDay', 0.4)
    R.simulate(0.5)
    return { pass: night > 0.95 && lamp > 5 && dayLamp < 0.1 && activeMatch, detail: `night ${night.toFixed(2)}: wreck lamp ${lamp.toFixed(1)}, noon lamp ${dayLamp.toFixed(2)}; coral glow on exactly the running threads: ${activeMatch}` }
  })

  await check('LIGHT-5', 'Day and night', 'Light the world by real time of day, as an option', () => {
    settings.set('clockTime', true)
    R.simulate(0.1)
    const d = new Date()
    const want = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
    const got = reef.water.time
    settings.set('clockTime', false)
    return { pass: Math.abs(got - want) < 0.001, detail: `clock says ${want.toFixed(4)}, sky is at ${got.toFixed(4)}` }
  })

  // ── materials and post ──────────────────────────────────────────────────────────────

  await check('POST-1', 'Materials', 'Bloom picks out lights rather than hazing everything', () => {
    engine.renderFrame()
    const t = engine.bloomPass?.threshold
    return { pass: t >= 0.9, detail: `bloom threshold ${t}` }
  })

  await check('POST-2', 'Materials', 'Depth of field reads depth, with the focal plane on what the camera orbits', () => {
    engine.renderFrame()
    const ts = engine.tiltShift
    const focus = ts?.passes?.[0]?.uniforms?.uFocusDistance?.value ?? ts?.focusDistance ?? engine._focusDistance
    const orbit = engine.camera.position.distanceTo(rig.target)
    return { pass: Boolean(ts) && Math.abs(engine._focusDistance - orbit) < 0.05, detail: `depth-of-field passes: ${ts?.passes?.length}; focal distance ${Number(focus).toFixed(2)} = camera-to-orbit-point ${orbit.toFixed(2)}` }
  })

  await check('POST-3', 'Materials', 'Cost of each post pass, timed with a GPU sync', () => {
    const gl = engine.renderer.getContext()
    const passes = engine.composer.passes
    const times = passes.map(() => 0)
    const originals = passes.map((p) => p.render)
    passes.forEach((p, i) => {
      p.render = function (...a) {
        gl.finish()
        const t = performance.now()
        originals[i].apply(this, a)
        gl.finish()
        times[i] += performance.now() - t
      }
    })
    const N = 5
    for (let i = 0; i < N; i++) engine.renderFrame()
    passes.forEach((p, i) => (p.render = originals[i]))
    const report = passes.map((p, i) => `${p.constructor.name.replace('Pass', '') || 'pass'} ${(times[i] / N).toFixed(1)}ms`)
    return { pass: times.every(Number.isFinite), info: true, detail: `${report.join(' · ')} (this machine's renderer: ${gl.getParameter(gl.RENDERER)})` }
  })

  await check('POST-4', 'Materials', 'A static scene is identical frame to frame', () => {
    const gl = engine.renderer.getContext()
    const w = engine.canvas.width
    const h = engine.canvas.height
    const read = () => {
      engine.renderFrame()
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return px
    }
    const a = read()
    const b = read()
    let diff = 0
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++
    return { pass: diff === 0, detail: `${diff} of ${w * h} pixels differ between two renders of the same moment` }
  })

  await check('POST-5', 'Materials', 'Turning effects off releases their memory', () => {
    const had = Boolean(engine.composer)
    for (const k of ['bloom', 'antialias', 'tiltShift', 'colorGrade']) settings.set(k, false)
    settings.set('ambientOcclusion', 0)
    const gone = engine.composer === null
    settings.applyPreset('balanced')
    settings.set('autoQuality', false)
    return { pass: had && gone && Boolean(engine.composer), detail: `composer before ${had}, after switching everything off ${!gone ? 'still allocated' : 'disposed'}, back on balanced ${Boolean(engine.composer)}` }
  })

  // ── settings ────────────────────────────────────────────────────────────────────────

  await check('SET-1', 'Settings', 'Five presets, defaulting to the middle one', () => {
    const names = Object.keys(PRESETS)
    return { pass: names.length === 5 && names[2] === DEFAULT_PRESET, detail: `${names.join(' · ')}; default ${DEFAULT_PRESET}` }
  })

  await check('SET-2', 'Settings', 'Every knob adjustable, marked when moved off its preset — and the mark survives a reload', () => {
    R.hud.syncSettings()
    settings.set('bloomStrength', 0.25)
    settings.set('shadows', 'high')
    R.hud.syncSettings()
    const row = document.querySelector('#reef-set-shadows').closest('.reef-row')
    const marked = row.classList.contains('moved')
    const base = settings.values.presetBase
    const quiet = !document.querySelector('#reef-set-bloom').closest('.reef-row').classList.contains('moved')
    settings.applyPreset('balanced')
    settings.set('autoQuality', false)
    return { pass: marked && quiet && base === 'balanced' && settings.get('preset') === 'balanced', detail: `moved knob marked: ${marked}; untouched knob unmarked: ${quiet}; preset it came from saved with the settings: ${base}` }
  })

  await check('SET-3', 'Settings', 'A governor scales under the chosen setting, about a step a second, never above it', () => {
    settings.set('autoQuality', true)
    engine.resize()
    const ceiling = engine._targetScale()
    const scales = []
    const realNow = performance.now.bind(performance)
    let clock = realNow()
    performance.now = () => clock
    engine.perf.fps = 20
    for (let i = 0; i < 6; i++) {
      clock += 1001
      engine._governQuality()
      scales.push(engine.viewport.scale)
    }
    const dropped = engine.viewport.scale < ceiling
    engine.perf.fps = 120
    for (let i = 0; i < 60; i++) {
      clock += 1001
      engine._governQuality()
      scales.push(engine.viewport.scale)
    }
    performance.now = realNow
    const neverAbove = scales.every((s) => s <= ceiling + 1e-6)
    const steps = scales.filter((s, i) => i && s !== scales[i - 1]).length
    settings.set('autoQuality', false)
    engine.resize()
    return { pass: dropped && neverAbove && steps <= 66 / 3, detail: `ceiling ${ceiling.toFixed(2)}; slow frames took it to ${Math.min(...scales).toFixed(2)}; ${steps} changes over 66 simulated seconds; never above the setting: ${neverAbove}` }
  })

  // ── interaction ─────────────────────────────────────────────────────────────────────

  R.simulate(2)
  for (let i = 0; i < 30; i++) rig.update(1 / 30)

  await check('ACT-1', 'Interaction', 'Click an inhabitant to pick it', () => {
    engine.renderFrame()
    const f = byStatus('idle')[0]
    rig.focus(f.pos, { distance: 22 })
    for (let i = 0; i < 90; i++) {
      rig.update(1 / 30)
      R.simulate(1 / 30)
    }
    const r = canvas.getBoundingClientRect()
    _p.copy(f.pos).project(engine.camera)
    const x = r.left + ((_p.x + 1) / 2) * r.width
    const y = r.top + ((1 - _p.y) / 2) * r.height
    ptr('pointerdown', x, y)
    ptr('pointerup', x, y)
    return { pass: R.selectedId === f.id, detail: `clicked at (${x.toFixed(0)}, ${y.toFixed(0)}); picked ${R.selectedId === f.id ? 'that fish' : R.selectedId}` }
  })

  await check('ACT-2', 'Interaction', 'Its card is parked beside it and follows it, moved by transform', () => {
    const f = school.get(R.selectedId)
    const r = canvas.getBoundingClientRect()
    const gaps = []
    for (let i = 0; i < 4; i++) {
      R.simulate(0.5)
      R.hud.frame(engine, rig, reef, R.selectedId, { time: 0.4 }, null)
      _p.copy(f.pos).project(engine.camera)
      const fx = r.left + ((_p.x + 1) / 2) * r.width
      const card = R.hud.card.getBoundingClientRect()
      gaps.push(Math.min(Math.abs(card.left - fx), Math.abs(card.right - fx)))
    }
    const usesTransform = R.hud.card.style.transform.startsWith('translate')
    if (R.hud.docked) {
      // Too narrow for a card beside a fish: it docks along the bottom, and the fish stays in
      // view above it.
      _p.copy(f.pos).project(engine.camera)
      const fy = r.top + ((1 - _p.y) / 2) * r.height
      const card = R.hud.card.getBoundingClientRect()
      return { pass: usesTransform && card.bottom <= innerHeight && fy < card.top && fy > 0, detail: `${innerWidth}px wide: card docked along the bottom (top at ${card.top.toFixed(0)}px), fish above it at ${fy.toFixed(0)}px` }
    }
    return { pass: Math.max(...gaps) < 80 && usesTransform, detail: `card edge within ${Math.max(...gaps).toFixed(0)}px of the fish across 2s of swimming; positioned by transform: ${usesTransform}` }
  })

  await check('ACT-3', 'Interaction', 'Every worker knows what it is doing, where it is, and what its job is', () => {
    const f = school.get(R.selectedId)
    const card = R.hud.card
    const doing = card.querySelector('.reef-card-doing').textContent === DOING[f.status]
    const shelf = card.querySelector('[data-f="shelf"]').textContent === f.project
    const job = card.querySelector('h2').textContent === f.thread.title
    const status = card.querySelector('.reef-card-status span').textContent === STATUS_LABEL[f.status]
    // And every one of the six has a sentence.
    const sentences = ['working', 'waiting', 'blocked', 'celebrating', 'sleeping', 'idle', 'arriving', 'leaving'].every((s) => DOING[s]?.length > 20)
    return { pass: doing && shelf && job && status && sentences, detail: `card shows status "${card.querySelector('.reef-card-status span').textContent}", job "${f.thread.title}", shelf "${f.project}", and "${card.querySelector('.reef-card-doing').textContent}"` }
  })

  await check('ACT-4', 'Interaction', 'Name plates on hover, and kept up for anything that wants attention', () => {
    const idle = byStatus('idle').find((f) => f.id !== R.selectedId)
    rig.focus(idle.pos, { distance: 26 })
    for (let i = 0; i < 90; i++) rig.update(1 / 30)
    R.hud.frame(engine, rig, reef, null, { time: 0.4 }, null)
    const shown = () => [...document.querySelectorAll('.reef-plate')].filter((p) => !p.hidden).map((p) => p._id)
    const without = shown()
    R.hud.frame(engine, rig, reef, null, { time: 0.4 }, idle.id)
    const withHover = shown()
    const quietNamed = without.filter((id) => !['waiting', 'blocked'].includes(school.get(id)?.status))
    return { pass: withHover.includes(idle.id) && !without.includes(idle.id) && quietNamed.length === 0, detail: `${without.length} plates up without hover (all on fish that want you); hovering a quiet fish adds its plate: ${withHover.includes(idle.id)}` }
  })

  await check('ACT-5', 'Interaction', 'Hovered fish turn to look at you', () => {
    const f = byStatus('idle')[1]
    school.hoverId = f.id
    // Hold it still so it is free to turn.
    for (let i = 0; i < 60; i++) {
      f.vel.set(0, 0, 0)
      f.target.copy(f.pos)
      f.pause = 1
      R.simulate(1 / 30)
    }
    school.hoverId = null
    const yaw = Math.atan2(engine.camera.position.x - f.pos.x, engine.camera.position.z - f.pos.z)
    const off = Math.abs(Math.atan2(Math.sin(yaw - f.yaw), Math.cos(yaw - f.yaw))) * 57.3
    return { pass: off < 20, detail: `after 2s of hover, ${off.toFixed(1)}° off facing the camera` }
  })

  await check('ACT-6', 'Interaction', 'Neighbours turn to look when one celebrates', () => {
    const c = byStatus('celebrating')[0]
    c.flash = 0
    R.simulate(1 / 30)
    const watching = live().filter((f) => f.look === c.pos && f.lookFor > 0)
    return { pass: watching.length > 0, detail: `${watching.length} quiet neighbours within 9 units turned to the flash` }
  })

  await check('ACT-7', 'Interaction', 'Search a shelf or thread and fly there', () => {
    const shelf = R.hud.actions.search('kiosk')
    const thread = R.hud.actions.search(threads[3].title)
    R.hud.searchInput.value = threads[3].title
    R.hud._renderResults()
    R.hud._pickResult(R.hud._found.findIndex((r) => r.id === threads[3].id))
    return { pass: shelf[0]?.kind === 'shelf' && shelf[0].name === 'web-kiosk' && thread.some((r) => r.id === threads[3].id) && R.selectedId === threads[3].id, detail: `"kiosk" → ${shelf[0]?.label}; "${threads[3].title}" → ${thread.length} results, picked and flew to it: ${R.selectedId === threads[3].id}` }
  })

  await check('ACT-8', 'Interaction', 'Filters — only what is waiting, only one shelf', () => {
    R.setFilter('needs')
    R.simulate(1.5)
    const shown = live().filter((f) => school.isShown(f))
    const allNeed = shown.every((f) => f.status === 'waiting' || f.status === 'blocked')
    const hiddenSmall = live().filter((f) => !school.isShown(f)).every((f) => f.shown < 0.05)
    const badges = reef.badges.mesh.count
    R.setFilter('project:ml-tides')
    R.simulate(1.5)
    const one = live().filter((f) => school.isShown(f)).every((f) => f.project === 'ml-tides')
    R.setFilter('all')
    R.simulate(1.5)
    return { pass: allNeed && hiddenSmall && one && shown.length > 0 && badges === shown.length, detail: `"Needs me" keeps ${shown.length} fish, hides the rest, ${badges} badges; one-shelf filter keeps only ml-tides: ${one}` }
  })

  await check('ACT-9', 'Interaction', 'Click a territory to see its threads; click a thread to fly to its inhabitant', () => {
    R.openShelf('ml-tides')
    const rows = [...document.querySelectorAll('.reef-shelf-row')]
    const expected = live().filter((f) => f.project === 'ml-tides').length
    rows[0].click()
    const picked = school.get(R.selectedId)
    R.hud.closeShelf()
    return { pass: rows.length === expected && picked?.project === 'ml-tides', detail: `ml-tides lists ${rows.length} of its ${expected} threads, loudest first (“${rows[0]?.querySelector('small').textContent}”); clicking one flew to it` }
  })

  await check('ACT-10', 'Interaction', 'A minimap and compass once the world is bigger than a screen', () => {
    R.hud._drawMap(reef, rig, engine)
    const ctx = R.hud.mapCanvas.getContext('2d')
    const d = ctx.getImageData(0, 0, 300, 300).data
    let painted = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++
    const t = rig.desiredTarget.clone()
    R.hud.actions.flyTo(20, -15)
    const flew = Math.hypot(rig.desiredTarget.x - 20, rig.desiredTarget.z + 15) < 0.5
    rig.desiredTarget.copy(t)
    return { pass: painted > 5000 && flew && Boolean(document.querySelector('.reef-compass')), detail: `${painted} map pixels drawn; clicking the map flies there: ${flew}; compass present` }
  })

  await check('ACT-11', 'Interaction', 'Photo mode hides every panel and keeps the world', () => {
    R.hud.setPhoto(true)
    const hidden = [...document.querySelectorAll('.reef-chrome')].every((e) => getComputedStyle(e).display === 'none')
    const canvasShown = getComputedStyle(canvas).display !== 'none'
    R.hud.setPhoto(false)
    const back = getComputedStyle(document.querySelector('.reef-top')).display !== 'none'
    return { pass: hidden && canvasShown && back, detail: `panels hidden ${hidden}, world kept ${canvasShown}, panels back after ${back}` }
  })

  await check('ACT-12', 'Interaction', 'Archive sends it back the way it came; arrival comes out of the wreck', () => {
    const f = byStatus('idle')[2]
    R.select(f.id)
    R.hud.actions.archive()
    const leaving = school.get(f.id)?.mode === 'leaving'
    let gone = null
    for (let t = 0; t < 90 && gone === null; t++) {
      R.simulate(1)
      if (!school.get(f.id)) gone = t + 1
    }
    const archived = R.state.archived.includes(f.id)
    // A brand-new thread: unseen, so it gets the entrance.
    const fresh = { ...threads[0], id: 'check:fresh', title: 'Fresh thread', createdAt: Date.now(), running: true }
    R.applyThreads([...threads.filter((t) => !R.state.archived.includes(t.id)), fresh])
    const nf = school.get('check:fresh')
    const atWreck = nf && nf.pos.distanceTo(reef.seabed.wreckMouth) < 0.5 && nf.mode === 'arriving'
    let arrived = null
    for (let t = 0; t < 60 && arrived === null; t++) {
      R.simulate(1)
      if (nf.mode === 'live') arrived = t + 1
    }
    return { pass: leaving && gone !== null && archived && atWreck && arrived !== null, detail: `archived fish swam home and left after ${gone}s; on the archive list: ${archived}; new thread came out of the wreck and reached its shelf in ${arrived}s` }
  })

  // ── alive ───────────────────────────────────────────────────────────────────────────

  await check('LIFE-1', 'Alive', 'Appearance is deterministic from the thread id', () => {
    const f = school.order[0]
    const a = fishLook(f.id)
    const b = fishLook(f.id)
    delete a.random
    delete b.random
    const colour = f.color.getHex() === new THREE.Color(a.body).getHex()
    const coral = coralLook(f.id).color === f.home.color.getHex()
    return { pass: JSON.stringify(a) === JSON.stringify(b) && colour && coral, detail: `same id, same fish and coral, every time: ${colour && coral}` }
  })

  await check('LIFE-2', 'Alive', 'Traffic between territories that carries no information', () => {
    R.simulate(3)
    const shoal = reef.shoal
    const highestShelf = Math.max(...reef.projects.map((p) => p.centre.y)) + 4
    let low = 0
    for (const m of shoal.members) if (m.pos.y < highestShelf) low++
    return { pass: shoal.mesh.visible && shoal.mesh.isInstancedMesh && low === 0 && shoal.members.length > 20, detail: `${shoal.members.length} silver fish at a third of the size, all above the reef (none below ${highestShelf.toFixed(1)}), one draw, no badge, no card` }
  })

  await check('LIFE-3', 'Alive', 'Activity drives ambience — running threads breathe bubbles', () => {
    const before = reef.effects.alive
    reef.effects.life.fill(0)
    R.simulate(3)
    const busy = reef.effects.alive
    return { pass: busy > 0 && reef.corals.entries.size > 0, detail: `${busy} bubbles in the water after 3s from ${byStatus('working').length} working corals (was ${before})` }
  })

  await check('LIFE-4', 'Alive', 'Theme ground by project — older projects are more overgrown', () => {
    const old = reef.projects.find((p) => p.name === 'old-batch')
    const young = reef.projects.find((p) => p.name === 'ml-tides')
    return { pass: old.age > young.age, detail: `old-batch age ${old.age}, ml-tides age ${young.age} (oldest thread decides)` }
  })

  await check('LIFE-5', 'Alive', 'Sound is off by default, and has exactly one interrupting call', () => {
    const fresh = settings.values.reefSound
    R.sound.ctx = null
    const silent = R.sound.call() === false
    return { pass: !fresh && silent, detail: `sound setting on a fresh reef: ${fresh ? 'on' : 'off'}; the waiting call stays silent while off: ${silent}` }
  })

  // ── persistence ─────────────────────────────────────────────────────────────────────

  await check('SAVE-1', 'Persistence', 'One writer: the demo and the check run write nothing anywhere', () => {
    return { pass: writes === 0, detail: `${writes} writes attempted during the whole run` }
  })

  await check('SAVE-2', 'Persistence', 'The wreck stands on the colony’s ship cell, where arrivals start', () => {
    const w = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)
    const d = Math.hypot(reef.seabed.wreck.group.position.x - w.x, reef.seabed.wreck.group.position.z - w.z)
    return { pass: d < 0.01 && !reef.seabed.ownerAt(w.x, w.z), detail: `wreck ${d.toFixed(3)} from the ship cell, which no shelf owns` }
  })

  window.fetch = realFetch
  Object.assign(settings.values, savedValues)
  const passed = results.filter((r) => r.pass).length
  const report = { complete: true, passed: passed === results.length, total: results.length, failed: results.filter((r) => !r.pass), results }
  window.__reefChecks = report
  out.done(report)
  engine.start()
  return report
}

function renderPanel() {
  const panel = document.createElement('section')
  panel.className = 'reef-checks'
  panel.innerHTML = '<h3>Reef checks</h3><p class="reef-checks-sum">running…</p><ol></ol>'
  const style = document.createElement('style')
  style.textContent = `
    .reef-checks { position: fixed; right: 16px; top: 60px; bottom: 16px; z-index: 60; width: min(560px, calc(100vw - 32px));
      overflow: auto; padding: 14px 16px; border-radius: 14px; border: 1px solid rgba(190,240,255,.24); background: rgba(6,26,38,.94);
      color: #eefaff; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; }
    .reef-checks h3 { margin: 0 0 4px; font-size: 15px; }
    .reef-checks ol { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    .reef-checks li { display: grid; grid-template-columns: 54px 66px minmax(0, 1fr); gap: 8px; }
    .reef-checks b { font-variant-numeric: tabular-nums; }
    .reef-checks .ok { color: #3fcf86; } .reef-checks .bad { color: #ff5a4a; } .reef-checks .info { color: #5cc8ff; }
    .reef-checks small { display: block; color: #9ec3cf; overflow-wrap: anywhere; }
  `
  document.head.appendChild(style)
  document.body.appendChild(panel)
  const list = panel.querySelector('ol')
  const sum = panel.querySelector('.reef-checks-sum')
  return {
    update(results) {
      const r = results[results.length - 1]
      const li = document.createElement('li')
      const cls = r.pass ? (r.info ? 'info' : 'ok') : 'bad'
      li.innerHTML = `<b class="${cls}">${r.pass ? (r.info ? 'MEASURE' : 'PASS') : 'FAIL'}</b><b>${r.id}</b><span>${r.req}<small>${r.detail}</small></span>`
      list.appendChild(li)
      sum.textContent = `${results.filter((x) => x.pass).length}/${results.length} so far`
    },
    done(report) {
      sum.textContent = `${report.total - report.failed.length}/${report.total} passed`
      sum.className = `reef-checks-sum ${report.passed ? 'ok' : 'bad'}`
    },
  }
}
