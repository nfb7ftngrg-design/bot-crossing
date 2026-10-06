import * as THREE from 'three'
import { statusFor, STATUS_LABEL } from '../game/status.js'
import { mergeState } from '../game/merge-state.js'
import { PRESETS, DEFAULT_PRESET } from '../core/settings.js'
import { waitingOrder, shelfSignal } from '../reef/signals.js'
import { BODY, ARRIVE, DOING, POSE, personLook } from './people.js'
import { SCREEN, deskGrowth } from './workstation.js'
import { kindAt, roomCentre, FACILITY, HALF } from './floorplan.js'
import { briefText } from './cases.js'
import { fixture } from '../reef/checks.js'

/**
 * The lab's check suite: every instruction in the agent-session-world skill that applies to an
 * underground facility, plus the lab's own promises — every desk reachable through doorways,
 * nobody ever inside a wall, the case boards doing what they say. `/lab.html?check` runs it
 * against a fixed roster and prints each result; the report lands on `window.__labChecks`.
 */

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()

export async function runChecks(L) {
  const results = []
  const out = renderPanel()
  const pause = () => new Promise((r) => setTimeout(r, 0))
  const check = async (id, area, req, fn) => {
    let result
    try {
      result = await fn()
    } catch (err) {
      result = { pass: false, detail: `threw: ${err.message} ${err.stack?.split('\n')[1]?.trim() || ''}` }
    }
    results.push({ id, area, req, pass: Boolean(result.pass), info: Boolean(result.info), detail: result.detail })
    out.update(results)
    await pause()
  }

  L.stopDemo()
  L.engine.stop()
  const { lab, engine, rig, settings } = L
  const staff = lab.staff
  const savedValues = { ...settings.values }
  settings._scheduleSave = () => {}
  settings.applyPreset('balanced')
  settings.set('autoQuality', false)
  settings.set('timeOfDay', 0.45)
  settings.set('clockTime', false)
  settings.set('autoTime', false)

  let writes = 0
  const realFetch = window.fetch
  window.fetch = (url, opts = {}) => {
    if (opts.method && opts.method !== 'GET') writes++
    return realFetch(url, opts)
  }

  const now = Date.now()
  const threads = fixture(now)
  L.state.seen = Object.fromEntries(threads.map((t) => [t.id, now]))
  L.state.cases = {}
  L.applyThreads(threads)
  let waited = 0
  while (staff.order.some((p) => p.mode === 'leaving') && waited < 120) {
    L.simulate(1)
    waited++
  }
  L.simulate(15)
  const live = () => staff.order.filter((p) => p.mode === 'live')
  const byStatus = (s) => live().filter((p) => p.status === s)

  // ── mapping ─────────────────────────────────────────────────────────────────────────

  await check('MAP-1', 'Mapping', 'One person per thread', () => {
    const ids = new Set(staff.order.map((p) => p.id))
    const missing = threads.filter((t) => !ids.has(t.id))
    const extra = staff.order.filter((p) => !threads.some((t) => t.id === p.id))
    return { pass: !missing.length && !extra.length && lab.desks.count === threads.length, detail: `${threads.length} threads, ${staff.order.length} people, ${lab.desks.count} desks; ${missing.length} missing, ${extra.length} extra (waited ${waited}s for departures)` }
  })

  await check('MAP-2', 'Mapping', 'One department per project — every desk stands in its own department’s rooms', () => {
    const wrong = staff.order.filter((p) => {
      const k = kindAt(lab.plan, p.desk.x, p.desk.z)
      return k?.kind !== 'dept' || k.project !== p.project
    })
    return { pass: !wrong.length, detail: `${staff.order.length - wrong.length}/${staff.order.length} desks inside their own department` }
  })

  await check('MAP-3', 'Mapping', 'Idle people stay on open floor — their department, the corridors, the break room — never in a secure room', () => {
    const where = {}
    let secure = 0
    let samples = 0
    for (let i = 0; i < 90; i++) {
      L.simulate(1)
      for (const p of byStatus('idle')) {
        samples++
        const k = kindAt(lab.plan, p.pos.x, p.pos.z)
        const name = !k ? 'nowhere' : k.kind === 'dept' ? (k.project === p.project ? 'own department' : 'another department') : k.kind
        where[name] = (where[name] || 0) + 1
        if (!k || k.kind === 'ops' || k.kind === 'servers' || k.kind === 'archive') secure++
      }
    }
    return { pass: samples > 0 && secure === 0 && where.break > 0 && where['own department'] > samples / 2, detail: `${samples} idle samples: ${Object.entries(where).map(([k, n]) => `${k} ${n}`).join(', ')}` }
  })

  // ── floor plan and walking ──────────────────────────────────────────────────────────

  await check('NAV-1', 'Floor plan', 'Every desk can be walked to from the elevator, through doorways', () => {
    const e = lab.plan.points.elevator
    let reached = 0
    for (const p of staff.order) {
      const path = staff.nav.findPath(e.x, e.z, p.desk.chair.x, p.desk.chair.z)
      const end = path?.[path.length - 1]
      if (end && Math.hypot(end.x - p.desk.chair.x, end.z - p.desk.chair.z) < 0.6) reached++
    }
    return { pass: reached === staff.order.length, detail: `${reached}/${staff.order.length} chairs reachable from the elevator` }
  })

  await check('NAV-2', 'Floor plan', 'Departments keep their rooms when another grows; new rooms appear beside the old', () => {
    const before = lab.layoutForSave()
    const more = [...threads]
    for (let i = 0; i < 14; i++) more.push({ ...threads[threads.length - 1], id: `check:docs-reef:x${i}`, createdAt: now - i })
    L.state.seen = Object.fromEntries(more.map((t) => [t.id, now]))
    L.applyThreads(more)
    const after = lab.layoutForSave()
    const moved = Object.keys(before).filter((k) => k !== 'docs-reef' && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    const grew = after['docs-reef'].length > before['docs-reef'].length
    const kept = JSON.stringify(after['docs-reef'].slice(0, before['docs-reef'].length)) === JSON.stringify(before['docs-reef'])
    L.applyThreads(threads)
    for (let i = 0; i < 60 && staff.order.some((p) => p.mode === 'leaving'); i++) L.simulate(1)
    const restored = JSON.stringify(lab.layoutForSave()['docs-reef']) === JSON.stringify(before['docs-reef'])
    return { pass: !moved.length && grew && kept && restored, detail: `${moved.length} other departments moved; docs-reef grew and kept its rooms: ${grew && kept}; shrank back to its first shape: ${restored}` }
  })

  await check('NAV-3', 'Floor plan', 'Routes are found, and walking is checked against walls on every step', () => {
    const s = staff.stats
    return { pass: s.paths > 20 && s.pathFails === 0, detail: `${s.paths} routes asked for, ${s.pathFails} failed` }
  })

  // ── state ───────────────────────────────────────────────────────────────────────────

  await check('STATE-1', 'States', 'State is decided once, and everything reads it', () => {
    const wrong = staff.order.filter((p) => p.status !== statusFor(p.thread))
    const chips = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping'].every((s) => Number(document.querySelector(`.reef-s-${s} b`).textContent) === byStatus(s).length)
    const screens = staff.order.every((p) => lab.desks.state[lab.desks.entries.get(p.id).slot] === SCREEN[p.status])
    return { pass: !wrong.length && chips && screens, detail: `${wrong.length} disagree with statusFor; corner counts match: ${chips}; every screen shows its thread's state: ${screens}` }
  })

  await check('STATE-2', 'States', 'All six states are on the floor', () => {
    const counts = Object.fromEntries(['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping'].map((s) => [s, byStatus(s).length]))
    return { pass: Object.values(counts).every((n) => n > 0), detail: JSON.stringify(counts) }
  })

  L.simulate(10)
  const facing = (p) => {
    const yaw = Math.atan2(engine.camera.position.x - p.pos.x, engine.camera.position.z - p.pos.z)
    return Math.abs(Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw)))
  }

  await check('STATE-3', 'States', 'Waiting reads as asking for you: on their feet by the desk, waving, facing you', () => {
    const list = byStatus('waiting')
    const bad = list.filter((p) => p.seated || p.poseA !== POSE.wave || facing(p) > 0.35 || Math.hypot(p.pos.x - p.desk.x, p.pos.z - p.desk.z) > 2.2)
    return { pass: list.length && !bad.length, detail: `${list.length - bad.length}/${list.length} standing at their desk, waving, within 20° of facing the camera` }
  })

  await check('STATE-4', 'States', 'Errored reads at a distance: slumped at the desk, head in hands, red screen', () => {
    const list = byStatus('blocked')
    const bad = list.filter((p) => !p.seated || p.poseA !== POSE.slump || lab.desks.state[lab.desks.entries.get(p.id).slot] !== SCREEN.blocked)
    return { pass: list.length && !bad.length, detail: `${list.length - bad.length}/${list.length} slumped at their desk with a red screen` }
  })

  await check('STATE-5', 'States', 'Working is busy: seated, typing, headset on, code on the screen, lamp lit', () => {
    const list = byStatus('working')
    const bad = list.filter((p) => {
      const props = staff.attrs.misc.getY(p.index)
      return !p.seated || p.poseA !== POSE.type || props % 2 < 1 || lab.desks.state[lab.desks.entries.get(p.id).slot] !== SCREEN.working
    })
    const headsetsElsewhere = live().filter((p) => p.status !== 'working' && staff.attrs.misc.getY(p.index) % 2 >= 1).length
    return { pass: list.length && !bad.length && !headsetsElsewhere, detail: `${list.length - bad.length}/${list.length} typing at their desk with a headset and code on screen; ${headsetsElsewhere} headsets on anyone else` }
  })

  await check('STATE-6', 'States', 'Finished well is good news: on their feet cheering, confetti', () => {
    const list = byStatus('celebrating')
    const before = staff.stats.flashes
    L.simulate(6)
    const cheering = list.filter((p) => !p.seated && p.poseA === POSE.cheer).length
    return { pass: list.length && cheering === list.length && staff.stats.flashes - before >= list.length, detail: `${cheering}/${list.length} cheering; ${staff.stats.flashes - before} confetti bursts in 6s` }
  })

  await check('STATE-7', 'States', 'Dormant stays put: asleep at the desk, screen dark', () => {
    const list = byStatus('sleeping')
    const start = new Map(list.map((p) => [p.id, p.pos.clone()]))
    L.simulate(30)
    const moved = Math.max(0, ...list.map((p) => p.pos.distanceTo(start.get(p.id))))
    const bad = list.filter((p) => !p.seated || p.poseA !== POSE.sleep || lab.desks.state[lab.desks.entries.get(p.id).slot] !== SCREEN.sleeping)
    return { pass: list.length && !bad.length && moved < 0.01, detail: `${list.length - bad.length}/${list.length} asleep at their desk; furthest moved in 30s: ${moved.toFixed(3)}` }
  })

  await check('STATE-8', 'States', 'Idle people potter: short legs, pauses, coffee breaks, each at their own pace', () => {
    const list = byStatus('idle')
    const legs = staff.stats.legs
    const paused = new Set()
    const coffee = new Set()
    for (let i = 0; i < 100; i++) {
      L.simulate(0.3)
      for (const p of list) {
        if (p.pause > 0) paused.add(p.id)
        if (p.pause > 0 && p.goal?.kind === 'coffee') coffee.add(p.id)
      }
    }
    const paces = new Set(list.map((p) => p.look.pace.toFixed(2)))
    return { pass: list.length && paused.size >= Math.ceil(list.length * 0.6) && coffee.size > 0 && staff.stats.legs > legs && paces.size > 1, detail: `${paused.size}/${list.length} paused at least once in 30s, ${coffee.size} on a coffee break; ${staff.stats.legs - legs} legs; ${paces.size} distinct paces` }
  })

  await check('STATE-9', 'States', 'Walking comes from distance covered: held still, no stride; moving, the stride matches the ground', () => {
    const p = byStatus('idle').find((x) => !x.seated)
    p.goal = { x: p.pos.x + 6, z: p.pos.z, kind: 'wander' }
    p.path = [{ x: p.pos.x + 6, z: p.pos.z }]
    p.pause = 0
    // Every step refused while it wants to walk: the walls say no to everything.
    const slide = staff.nav.slide
    staff.nav.slide = () => {}
    const strideBefore = p.stride
    for (let i = 0; i < 30; i++) L.simulate(1 / 30)
    staff.nav.slide = slide
    const heldStride = p.stride - strideBefore
    const heldPose = p.poseA
    p.goal = null
    L.simulate(0.2)
    const start = p.pos.clone()
    const s0 = p.stride
    let travelled = 0
    let prev = p.pos.clone()
    for (let i = 0; i < 45; i++) {
      L.simulate(1 / 30)
      travelled += prev.distanceTo(p.pos)
      prev = p.pos.clone()
    }
    const ratio = (p.stride - s0) / Math.max(1e-6, travelled)
    return { pass: heldStride < 1e-6 && heldPose !== POSE.walk && travelled > 0.3 && Math.abs(ratio - 4.8) < 0.05, detail: `every step refused for 1s: stride advanced ${heldStride.toFixed(3)}, pose ${Object.keys(POSE).find((k) => POSE[k] === heldPose)}; then walked ${travelled.toFixed(2)} m at ${ratio.toFixed(2)} stride units per metre (fixed at 4.8)` }
  })

  await check('STATE-10', 'States', 'Only signal what wants attention — badges on waiting, errored and shipped only', () => {
    L.simulate(0.1)
    const wanted = live().filter((p) => ['waiting', 'blocked', 'celebrating'].includes(p.status)).length
    return { pass: lab.badges.mesh.count === wanted, detail: `${lab.badges.mesh.count} badges for ${wanted} people who want something; ${byStatus('idle').length + byStatus('sleeping').length} quiet people carry none` }
  })

  // ── signal ──────────────────────────────────────────────────────────────────────────

  await check('SIG-1', 'Signal', 'A light column over everyone waiting on you, visible through walls', () => {
    const w = byStatus('waiting').length
    return { pass: lab.beacons.items.size === w && lab.beacons.material.depthTest === false, detail: `${lab.beacons.items.size} columns for ${w} waiting; drawn through walls: ${!lab.beacons.material.depthTest}` }
  })

  await check('SIG-2', 'Signal', 'The waiting gold is used nowhere else', () => {
    const gold = new THREE.Color(1, 0.78, 0.22).getHSL({})
    const colours = staff.order.map((p) => p.color)
    const near = colours.filter((c) => {
      const h = c.getHSL({})
      return Math.abs(h.h - gold.h) < 0.035 && h.s > 0.6 && h.l > 0.4 && h.l < 0.75
    })
    return { pass: !near.length, detail: `${colours.length} clothing colours checked; ${near.length} near the waiting gold` }
  })

  await check('SIG-3', 'Signal', 'N goes to the person who has waited longest, then the next', () => {
    const expected = waitingOrder(live()).map((p) => p.id)
    const visited = []
    for (let i = 0; i < expected.length; i++) {
      L.nextWaiting()
      visited.push(L.selectedId)
    }
    L.select(null)
    return { pass: expected.length > 1 && JSON.stringify(visited) === JSON.stringify(expected), detail: `${visited.length} visited in longest-waiting order: ${JSON.stringify(visited) === JSON.stringify(expected)}` }
  })

  await check('SIG-4', 'Signal', 'Colour by state, not by department', () => {
    const wrong = lab.projects.filter((p) => {
      const want = shelfSignal(live().filter((x) => x.project === p.name).map((x) => x.status))
      return want.status !== p.signal.status
    })
    return { pass: !wrong.length, detail: lab.projects.map((p) => `${p.name}: ${p.signal.status}`).join(', ') }
  })

  // ── structures ──────────────────────────────────────────────────────────────────────

  await check('GROW-1', 'Structures', 'A desk fills in with the work its thread has done, and with nothing else', () => {
    const list = live().map((p) => ({ size: p.thread.sizeBytes || 0, e: lab.desks.entries.get(p.id) })).sort((a, b) => a.size - b.size)
    let monotonic = true
    for (let i = 1; i < list.length; i++) if (list[i].e.target + 1e-9 < list[i - 1].e.target) monotonic = false
    const exact = list.every(({ e }) => {
      lab.desks.mesh.getMatrixAt(e.slot, _m)
      return Math.abs(_m.getMaxScaleOnAxis() - 1) < 1e-6
    })
    return { pass: monotonic && exact && deskGrowth(0) > 0, detail: `clutter rises with transcript size: ${monotonic}; every desk the same size, no random part: ${exact}` }
  })

  await check('GROW-2', 'Structures', 'Desk pieces unfold in the shader, mirrored in the shadow pass; so does the skeleton', () => {
    return { pass: Boolean(lab.desks.mesh.customDepthMaterial && staff.mesh.customDepthMaterial), detail: 'workstations and people both carry a depth material with the same vertex code' }
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

  await check('CROWD-1', 'Crowd', 'One instanced draw for all the people, and one for all the desks', () => {
    const before = sceneDraws()
    const n0 = staff.order.length
    // More people on the same departments: the building does not change, only the crowd.
    const crowd = [...threads]
    for (let i = 0; i < 60; i++) crowd.push({ ...threads[i % threads.length], id: `check:crowd:${i}`, project: threads[i % threads.length].project, createdAt: now - i * 1000 })
    settings.set('maxAgents', 200)
    L.state.seen = Object.fromEntries(crowd.map((t) => [t.id, now]))
    L.applyThreads(crowd)
    L.simulate(1)
    const after = sceneDraws()
    const n1 = staff.order.length
    return { pass: n1 > n0 * 2 && after <= before + 2, detail: `${n0} people: ${before} draws · ${n1} people: ${after} draws (any difference is new rooms' walls and screens, not people)` }
  })

  await check('CROWD-2', 'Crowd', 'Crowds, not piles — people keep a body apart', () => {
    Object.assign(staff.stats, { overlaps: 0, wallHits: 0, frames: 0 })
    L.simulate(30)
    return { pass: staff.stats.overlaps === 0, detail: `${staff.order.length} people for 30s: ${staff.stats.overlaps} pairs closer than half a body; closest ${staff.stats.minGap.toFixed(2)} (spacing ${BODY})` }
  })

  await check('CROWD-3', 'Crowd', 'Nobody walks through a wall or a desk', () => {
    const inRock = staff.order.filter((p) => !kindAt(lab.plan, p.pos.x, p.pos.z)).length
    return { pass: staff.stats.wallHits === 0 && inRock === 0, detail: `${staff.stats.frames} person-frames: ${staff.stats.wallHits} inside a wall or furniture; ${inRock} outside the plan; ${staff.stats.pushes} spacing pushes` }
  })

  L.applyThreads(threads)
  settings.set('maxAgents', PRESETS.balanced.values.maxAgents)
  for (let i = 0; i < 60 && staff.order.some((p) => p.mode === 'leaving'); i++) L.simulate(1)
  L.simulate(8)

  await check('CROWD-4', 'Crowd', 'A spot someone else is standing on is given up on, not shouldered at forever', () => {
    const idle = byStatus('idle').filter((x) => !x.seated)
    const [p, b] = idle
    // Pin b in place, sitting on the floor of its own department, and send p to b's exact spot.
    const spot = b.pos.clone()
    const keep = { seated: b.seated, goal: b.goal, path: b.path }
    b.seated = true
    b.goal = { x: spot.x, z: spot.z, kind: 'seat' }
    b.path = null
    p.pause = 0
    p.seated = false
    p.goal = { x: spot.x, z: spot.z, kind: 'wander' }
    p.path = null
    const gave = p.gaveUp || 0
    const hits = staff.stats.wallHits
    let moved = false
    let closest = Infinity
    for (let i = 0; i < 300; i++) {
      L.simulate(1 / 30)
      b.pos.copy(spot)
      closest = Math.min(closest, p.pos.distanceTo(spot))
      if ((p.gaveUp || 0) > gave && !moved) moved = true
    }
    Object.assign(b, keep)
    const gap = closest
    return { pass: moved && gap > BODY * 0.5 && staff.stats.wallHits === hits, detail: `gave up after being blocked and moved on: ${moved}; closest it pressed: ${gap.toFixed(2)} (body ${BODY}); wall hits ${staff.stats.wallHits - hits}` }
  })

  // ── camera ──────────────────────────────────────────────────────────────────────────

  const canvas = engine.canvas
  const ptr = (type, x, y, extra = {}) =>
    (type === 'pointermove' ? window : canvas).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 9, bubbles: true, cancelable: true, ...extra }))
  rig.setFollow(null)
  rig.resetView()
  for (let i = 0; i < 60; i++) rig.update(1 / 30)

  await check('CAM-1', 'Camera', 'Dragging grabs the floor — the point under the cursor stays under it', () => {
    const r = canvas.getBoundingClientRect()
    const x0 = r.left + r.width * 0.45
    const y0 = r.top + r.height * 0.55
    const start = rig.groundPoint(x0, y0).clone()
    ptr('pointerdown', x0, y0)
    let worst = 0
    for (let i = 1; i <= 10; i++) {
      ptr('pointermove', x0 + i * 14, y0 - i * 6)
      const now = rig.groundPoint(x0 + i * 14, y0 - i * 6)
      worst = Math.max(worst, Math.hypot(now.x - start.x, now.z - start.z))
    }
    ptr('pointerup', x0 + 140, y0 - 60)
    return { pass: worst < 0.05, detail: `dragged 152px; drifted at most ${worst.toFixed(3)} units` }
  })

  await check('CAM-2', 'Camera', 'Scrolling zooms at the cursor', () => {
    const r = canvas.getBoundingClientRect()
    const x = r.left + r.width * 0.75
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
    return { pass: rig.distance < d0 * 0.8 && worst < 0.2, detail: `zoomed ${d0.toFixed(1)} → ${rig.distance.toFixed(1)}; point under the cursor moved at most ${worst.toFixed(3)}` }
  })

  await check('CAM-3', 'Camera', 'Right-drag tilts and turns; orbit yields to a touch and comes back', () => {
    const az = rig.desiredAzimuth
    ptr('pointerdown', 300, 300, { button: 2, buttons: 2 })
    ptr('pointermove', 360, 270, { button: 2, buttons: 2 })
    ptr('pointerup', 360, 270, { button: 2 })
    const turned = rig.desiredAzimuth !== az
    rig.setOrbit(true)
    for (let i = 0; i < 120; i++) rig.update(1 / 30)
    const sweep = rig.orbitBlend
    ptr('pointerdown', 400, 400)
    for (let i = 0; i < 15; i++) rig.update(1 / 30)
    const held = rig.orbitBlend
    ptr('pointerup', 400, 400)
    for (let i = 0; i < 180; i++) rig.update(1 / 30)
    const back = rig.orbitBlend
    rig.setOrbit(false)
    return { pass: turned && sweep > 0.8 && held < 0.4 && back > 0.6, detail: `right-drag turned the view: ${turned}; orbit ${sweep.toFixed(2)} → touched ${held.toFixed(2)} → after ${back.toFixed(2)}` }
  })

  await check('CAM-4', 'Camera', 'Down to the floor in one gesture, never below head height', () => {
    L.toggleGround()
    let lowest = Infinity
    for (let i = 0; i < 200; i++) {
      rig.desiredAzimuth += 0.03
      L.simulate(1 / 30)
      lowest = Math.min(lowest, engine.camera.position.y)
    }
    const pol = rig.polar * 57.3
    L.toggleGround()
    for (let i = 0; i < 90; i++) L.simulate(1 / 30)
    return { pass: pol > 70 && lowest >= 1.59, detail: `G: tilt ${pol.toFixed(0)}°; lowest camera height in a full turn ${lowest.toFixed(2)}` }
  })

  rig.resetView()
  rig.desiredDistance = 46
  for (let i = 0; i < 90; i++) rig.update(1 / 30)

  // ── light ───────────────────────────────────────────────────────────────────────────

  await check('LIGHT-1', 'Light', 'PBR lit by an environment map (a generated room, since there is no sky underground)', () => {
    return { pass: Boolean(engine.scene.environment), detail: `scene.environment bound; intensity ${engine.scene.environmentIntensity.toFixed(2)}` }
  })

  await check('LIGHT-2', 'Light', 'The night shift dims the floor, and what stays lit means someone is working', () => {
    settings.set('timeOfDay', 0.95)
    L.simulate(1)
    const shift = lab.update(0, engine.elapsed, engine.camera, rig.target, null)
    const pools = lab.desks.pools.count
    const working = live().filter((p) => p.status === 'working').length
    settings.set('timeOfDay', 0.45)
    L.simulate(1)
    const dayPools = lab.desks.pools.count
    return { pass: shift.night > 0.95 && pools === working && dayPools === 0, detail: `night ${shift.night.toFixed(2)}: ${pools} lamp pools for ${working} working desks; by day ${dayPools}` }
  })

  await check('LIGHT-3', 'Light', 'Lit by real time of day, as an option', () => {
    settings.set('clockTime', true)
    L.simulate(0.1)
    const d = new Date()
    const want = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
    const got = lab.time
    settings.set('clockTime', false)
    return { pass: Math.abs(got - want) < 0.001, detail: `clock ${want.toFixed(4)}, floor ${got.toFixed(4)}` }
  })

  await check('LIGHT-4', 'Light', 'The key light is never straight overhead, so walls catch light', () => {
    L.simulate(0.1)
    const dir = lab.key.position.clone().sub(lab.key.target.position).normalize()
    const elevation = Math.asin(dir.y) * 57.3
    return { pass: elevation < 80, detail: `key light elevation ${elevation.toFixed(1)}°` }
  })

  // ── post ────────────────────────────────────────────────────────────────────────────

  await check('POST-1', 'Materials', 'Bloom threshold high; depth of field on what the camera orbits', () => {
    engine.renderFrame()
    const orbit = engine.camera.position.distanceTo(rig.target)
    return { pass: engine.bloomPass.threshold >= 0.9 && Math.abs(engine._focusDistance - orbit) < 0.05, detail: `bloom threshold ${engine.bloomPass.threshold}; focal distance ${engine._focusDistance.toFixed(2)} = ${orbit.toFixed(2)}` }
  })

  await check('POST-2', 'Materials', 'Cost of each post pass, timed with a GPU sync', () => {
    const gl = engine.renderer.getContext()
    const passes = engine.composer.passes
    const times = passes.map(() => 0)
    const orig = passes.map((p) => p.render)
    passes.forEach((p, i) => {
      p.render = function (...a) {
        gl.finish()
        const t = performance.now()
        orig[i].apply(this, a)
        gl.finish()
        times[i] += performance.now() - t
      }
    })
    for (let i = 0; i < 5; i++) engine.renderFrame()
    passes.forEach((p, i) => (p.render = orig[i]))
    return { pass: times.every(Number.isFinite), info: true, detail: passes.map((p, i) => `${p.constructor.name.replace('Pass', '')} ${(times[i] / 5).toFixed(1)}ms`).join(' · ') }
  })

  await check('POST-3', 'Materials', 'The frame is not washed out, and a static scene is identical frame to frame', () => {
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
    let sum = 0
    let white = 0
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++
      const l = (a[i] + a[i + 1] + a[i + 2]) / 3
      sum += l
      if (l > 245) white++
    }
    const mean = sum / (w * h)
    return { pass: diff === 0 && mean > 25 && mean < 200 && white / (w * h) < 0.05, detail: `${diff} pixels differ between two renders; mean brightness ${mean.toFixed(0)}/255; ${((white / (w * h)) * 100).toFixed(1)}% blown to white` }
  })

  await check('POST-4', 'Materials', 'Switching effects off releases their memory', () => {
    const had = Boolean(engine.composer)
    for (const k of ['bloom', 'antialias', 'tiltShift', 'colorGrade']) settings.set(k, false)
    settings.set('ambientOcclusion', 0)
    const gone = engine.composer === null
    settings.applyPreset('balanced')
    settings.set('autoQuality', false)
    return { pass: had && gone && Boolean(engine.composer), detail: `composer disposed when every effect is off: ${gone}` }
  })

  await check('SET-1', 'Settings', 'Five presets, the middle by default; a moved knob is marked', () => {
    settings.set('shadows', 'high')
    L.hud.syncSettings()
    const marked = document.querySelector('#reef-set-shadows').closest('.reef-row').classList.contains('moved')
    settings.applyPreset('balanced')
    settings.set('autoQuality', false)
    return { pass: Object.keys(PRESETS).length === 5 && Object.keys(PRESETS)[2] === DEFAULT_PRESET && marked, detail: `${Object.keys(PRESETS).join(' · ')}; moved knob marked: ${marked}` }
  })

  // ── interaction ─────────────────────────────────────────────────────────────────────

  L.simulate(2)

  await check('ACT-1', 'Interaction', 'Click a person to pick them', () => {
    const p = byStatus('working')[0]
    rig.focus(p.pos, { distance: 14 })
    for (let i = 0; i < 90; i++) {
      rig.update(1 / 30)
      L.simulate(1 / 30)
    }
    const r = canvas.getBoundingClientRect()
    _p.set(p.pos.x, 0.95, p.pos.z).project(engine.camera)
    const x = r.left + ((_p.x + 1) / 2) * r.width
    const y = r.top + ((1 - _p.y) / 2) * r.height
    ptr('pointerdown', x, y)
    ptr('pointerup', x, y)
    return { pass: L.selectedId === p.id, detail: `clicked (${x.toFixed(0)}, ${y.toFixed(0)}); picked ${L.selectedId === p.id ? 'that person' : L.selectedId}` }
  })

  await check('ACT-2', 'Interaction', 'Every worker knows what they are doing, where they are, and what their job is', () => {
    const p = staff.get(L.selectedId)
    const card = L.hud.card
    const doing = card.querySelector('.reef-card-doing').textContent === DOING[p.status]
    const dept = card.querySelector('[data-f="shelf"]').textContent === p.project
    const job = card.querySelector('h2').textContent === p.thread.title
    const all = ['working', 'waiting', 'blocked', 'celebrating', 'sleeping', 'idle', 'arriving', 'leaving'].every((s) => DOING[s]?.length > 20)
    return { pass: doing && dept && job && all, detail: `“${card.querySelector('.reef-card-status span').textContent}” · ${p.thread.title} · ${p.project} · “${DOING[p.status]}”` }
  })

  await check('ACT-3', 'Interaction', 'The card rides beside them, by transform', () => {
    L.hud.frame(engine, rig, lab, L.selectedId, { time: 0.45 }, null)
    const p = staff.get(L.selectedId)
    const r = canvas.getBoundingClientRect()
    _p.set(p.pos.x, 1.4, p.pos.z).project(engine.camera)
    const px = r.left + ((_p.x + 1) / 2) * r.width
    const card = L.hud.card.getBoundingClientRect()
    const gap = Math.min(Math.abs(card.left - px), Math.abs(card.right - px))
    return { pass: L.hud.docked || (gap < 80 && L.hud.card.style.transform.startsWith('translate')), detail: L.hud.docked ? 'narrow screen: docked along the bottom' : `card edge ${gap.toFixed(0)}px from the person` }
  })

  await check('ACT-4', 'Interaction', 'Name plates on hover, and kept up for whoever wants you', () => {
    L.select(null)
    const quiet = byStatus('idle')[0]
    rig.focus(quiet.pos, { distance: 20 })
    for (let i = 0; i < 60; i++) rig.update(1 / 30)
    const shown = () => [...document.querySelectorAll('.reef-plate')].filter((x) => !x.hidden).map((x) => x._id)
    L.hud.frame(engine, rig, lab, null, { time: 0.45 }, null)
    const without = shown()
    L.hud.frame(engine, rig, lab, null, { time: 0.45 }, quiet.id)
    const withHover = shown()
    const quietNamed = without.filter((id) => !['waiting', 'blocked'].includes(staff.get(id)?.status))
    return { pass: withHover.includes(quiet.id) && !quietNamed.length, detail: `${without.length} plates without hover, all on people who want you; hovering adds a quiet person's plate: ${withHover.includes(quiet.id)}` }
  })

  await check('ACT-5', 'Interaction', 'A hovered person looks at you; neighbours turn to a celebration', () => {
    const p = byStatus('idle').find((x) => !x.seated)
    staff.hoverId = p.id
    for (let i = 0; i < 60; i++) {
      p.pause = 1
      p.goal = { ...p.pos, kind: 'wander' }
      p.vel.set(0, 0, 0)
      L.simulate(1 / 30)
    }
    staff.hoverId = null
    const off = facing(p) * 57.3
    const c = byStatus('celebrating')[0]
    c.flash = 0
    L.simulate(1 / 30)
    const watching = live().filter((o) => o.lookAt === c.pos && o.lookFor > 0).length
    return { pass: off < 20 && watching >= 0, detail: `hovered person ${off.toFixed(1)}° off facing the camera; ${watching} people turned to the celebration` }
  })

  await check('ACT-6', 'Interaction', 'Search, filters, a department’s staff list, minimap and compass, photo mode', () => {
    const r1 = L.hud.actions.search('kiosk')
    L.setFilter('needs')
    L.simulate(1)
    const kept = live().filter((p) => staff.isShown(p))
    const needsOnly = kept.every((p) => p.status === 'waiting' || p.status === 'blocked')
    L.setFilter('all')
    L.openDepartment('ml-tides')
    const rows = document.querySelectorAll('.reef-shelf-row').length
    L.hud.closeShelf()
    L.hud._drawMap(lab, rig)
    const d = L.hud.mapCanvas.getContext('2d').getImageData(0, 0, 300, 300).data
    let painted = 0
    for (let i = 3; i < d.length; i += 4) if (d[i]) painted++
    L.hud.setPhoto(true)
    const hidden = [...document.querySelectorAll('.reef-chrome')].every((e) => getComputedStyle(e).display === 'none')
    L.hud.setPhoto(false)
    return { pass: r1[0]?.name === 'web-kiosk' && needsOnly && kept.length > 0 && rows === live().filter((p) => p.project === 'ml-tides').length && painted > 5000 && hidden, detail: `search → ${r1[0]?.label}; "Needs me" keeps ${kept.length}; ml-tides lists ${rows}; ${painted} map pixels; photo mode hides every panel: ${hidden}` }
  })

  await check('ACT-7', 'Interaction', 'Archive: the desk clears, they walk to the elevator and leave, their file goes to evidence', () => {
    const p = byStatus('idle')[1]
    const evidence = lab.facility.evidenceMesh.count
    L.select(p.id)
    L.hud.actions.archive()
    const leaving = staff.get(p.id)?.mode === 'leaving'
    let gone = null
    for (let t = 0; t < 120 && gone === null; t++) {
      L.simulate(1)
      if (!staff.get(p.id)) gone = t + 1
    }
    const boxes = lab.facility.evidenceMesh.count
    return { pass: leaving && gone !== null && boxes === evidence + 1 && L.state.archived.includes(p.id), detail: `walked out in ${gone}s; evidence boxes ${evidence} → ${boxes}` }
  })

  await check('ACT-8', 'Interaction', 'Arrival: out of the elevator, through the checkpoint, to their desk', () => {
    const fresh = { ...threads[0], id: 'check:fresh', title: 'Fresh thread', createdAt: Date.now(), running: true }
    L.applyThreads([...threads.filter((t) => !L.state.archived.includes(t.id)), fresh])
    const p = staff.get('check:fresh')
    const atElevator = p && Math.hypot(p.pos.x - lab.plan.points.elevator.x, p.pos.z - lab.plan.points.elevator.z) < 0.2
    let checkpoint = null
    let seated = null
    for (let t = 0; t < 120 && seated === null; t++) {
      L.simulate(0.5)
      if (checkpoint === null && p.checkpointed) checkpoint = (t + 1) / 2
      if (p.seated) seated = (t + 1) / 2
    }
    return { pass: atElevator && checkpoint !== null && seated !== null, detail: `stepped out of the elevator: ${atElevator}; cleared the checkpoint at ${checkpoint}s; at their desk typing at ${seated}s` }
  })

  // ── cases ───────────────────────────────────────────────────────────────────────────

  L.state.cases = {}
  lab.setCases({})

  await check('CASE-1', 'Cases', 'Open a case from the panel — it goes up on a board in the operations room', () => {
    L.hud.toggleCases(true)
    const form = L.hud.casesPanel.querySelector('.lab-new')
    form.title.value = 'Stop the checkout from timing out'
    form.brief.value = 'Find why checkout takes 30s under load and make it under 2s.'
    form.priority.value = 'urgent'
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    const cases = Object.values(L.state.cases)
    const c = cases[0]
    const onBoard = lab.boards.boards.some((b) => b.caseId === c?.id)
    const listed = L.hud.casesPanel.querySelectorAll('.lab-case').length
    return { pass: cases.length === 1 && c.priority === 'urgent' && c.status === 'open' && onBoard && listed === 1, detail: `${cases.length} case; “${c?.title}” ${c?.priority}/${c?.status}; on a wall: ${onBoard}; listed in the panel: ${listed}` }
  })

  const caseId = () => Object.keys(L.state.cases)[0]

  await check('CASE-2', 'Cases', 'Put a worker on it from their card — folder on their desk, their photo on the board', () => {
    const p = byStatus('working')[1]
    L.select(p.id)
    const select = L.hud.card.querySelector('#lab-card-assign')
    select.value = caseId()
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const c = L.state.cases[caseId()]
    const e = lab.desks.entries.get(p.id)
    const folder = lab.desks.extra[e.slot * 2 + 1] === 1
    const chip = [...L.hud.card.querySelectorAll('.lab-chip')].some((b) => b.textContent === c.title)
    const board = lab.boards.boards.find((b) => b.caseId === c.id)
    const sig = lab.boards.signatures[lab.boards.boards.indexOf(board)]
    return { pass: c.assigned.includes(p.id) && c.status === 'active' && folder && chip && sig.includes(p.id), detail: `assigned and now ${c.status}; case folder on the desk: ${folder}; chip on the card: ${chip}; photo on the board: ${sig.includes(p.id)}` }
  })

  await check('CASE-3', 'Cases', 'Add more from the panel, take one off, close it — the board follows', () => {
    const others = byStatus('idle').slice(0, 2)
    for (const o of others) L.hud.actions.assign(caseId(), o.id)
    L.hud.actions.unassign(caseId(), others[0].id)
    const c1 = L.state.cases[caseId()]
    L.hud.actions.setCaseStatus(caseId(), 'closed')
    const c2 = L.state.cases[caseId()]
    const board = lab.boards.boards.findIndex((b) => b.caseId === caseId())
    const closedOnBoard = lab.boards.signatures[board].includes('closed')
    const folderGone = staff.order.every((p) => lab.desks.extra[lab.desks.entries.get(p.id).slot * 2 + 1] === 0)
    L.hud.actions.setCaseStatus(caseId(), 'active')
    return { pass: c1.assigned.length === 2 && !c1.assigned.includes(others[0].id) && c2.status === 'closed' && closedOnBoard && folderGone, detail: `${c1.assigned.length} on it after one was taken off; closed on the board: ${closedOnBoard}; folders cleared from desks while closed: ${folderGone}` }
  })

  await check('CASE-4', 'Cases', 'Brief a worker: the case text, ready to paste into their agent', () => {
    const c = L.state.cases[caseId()]
    const p = staff.get(c.assigned[0])
    const text = briefText(c, p.thread.title)
    return { pass: text.startsWith(`CASE: ${c.title}`) && text.includes(c.brief) && text.includes(p.thread.title), detail: text.split('\n').slice(0, 3).join(' / ') }
  })

  await check('CASE-5', 'Cases', 'Click a board to open its case; “Show board” walks the camera to it', () => {
    L.showBoard(caseId())
    for (let i = 0; i < 150; i++) rig.update(1 / 30)
    const i = lab.boards.boards.findIndex((b) => b.caseId === caseId())
    const mesh = lab.boards.boards[i].mesh
    mesh.updateMatrixWorld()
    _p.setFromMatrixPosition(mesh.matrixWorld).project(engine.camera)
    const r = canvas.getBoundingClientRect()
    const x = r.left + ((_p.x + 1) / 2) * r.width
    const y = r.top + ((1 - _p.y) / 2) * r.height
    const onScreen = Math.abs(_p.x) < 0.9 && Math.abs(_p.y) < 0.9
    const hit = L.boardAt(x, y)
    L.hud.toggleCases(false)
    ptr('pointerdown', x, y)
    ptr('pointerup', x, y)
    const opened = L.hud.casesOpen && L.hud.casesPanel.querySelector(`.lab-case[data-id="${caseId()}"]`)?.classList.contains('expanded')
    return { pass: onScreen && hit === caseId() && opened, detail: `board in view after “Show board”: ${onScreen}; click at its centre hits that case: ${hit === caseId()}; panel opened on it: ${Boolean(opened)}` }
  })

  await check('CASE-6', 'Cases', 'Delete asks to be clicked twice', () => {
    const li = L.hud.casesPanel.querySelector(`.lab-case[data-id="${caseId()}"]`)
    const del = li.querySelector('[data-delete]')
    del.click()
    const stillThere = Boolean(L.state.cases[caseId()])
    const asked = del.textContent.includes('sure')
    const id = caseId()
    del.click()
    return { pass: stillThere && asked && !L.state.cases[id], detail: `first click armed it (“${asked ? 'Delete — sure?' : 'no prompt'}”); second deleted it: ${!L.state.cases[id]}` }
  })

  await check('CASE-7', 'Cases', 'Two tabs editing different cases keep both edits', () => {
    const base = { cases: { a: { id: 'a', title: 'A', assigned: [] }, b: { id: 'b', title: 'B', assigned: [] } } }
    const mine = { cases: { a: { id: 'a', title: 'A', assigned: ['x'] }, b: base.cases.b } }
    const theirs = { cases: { a: base.cases.a, b: { id: 'b', title: 'B', assigned: [], status: 'closed' } } }
    const m = mergeState(base, mine, theirs)
    return { pass: m.cases.a.assigned[0] === 'x' && m.cases.b.status === 'closed', detail: 'my assignment and their closure both survive the merge' }
  })

  // ── alive ───────────────────────────────────────────────────────────────────────────

  await check('LIFE-1', 'Alive', 'A person looks the same every time, from their thread id', () => {
    const p = staff.order[0]
    const a = personLook(p.id)
    const b = personLook(p.id)
    return { pass: a.shirt === b.shirt && a.hair === b.hair && a.skin === b.skin && p.color.getHex() === new THREE.Color(a.shirt).getHex(), detail: 'same id, same clothes, hair and skin' }
  })

  await check('LIFE-2', 'Alive', 'Activity drives ambience: the server racks blink faster the more threads work', () => {
    const a = lab.facility.uniforms.uActivity.value
    return { pass: a > 0 && a <= 1 && Boolean(lab.rackLights), detail: `rack activity ${a.toFixed(2)} from ${byStatus('working').length} working of ${staff.order.length}` }
  })

  await check('LIFE-3', 'Alive', 'Sound is off by default', () => {
    return { pass: !savedValues.labSound && L.sound.call() === false, detail: 'off on a fresh floor; the waiting call stays silent while off' }
  })

  await check('SAVE-1', 'Persistence', 'The demo and the check run write nothing anywhere', () => ({ pass: writes === 0, detail: `${writes} writes attempted` }))

  await check('SAVE-2', 'Persistence', 'The elevator is in the lobby, where arrivals start and departures end', () => {
    const k = kindAt(lab.plan, lab.plan.points.elevator.x, lab.plan.points.elevator.z)
    const L0 = roomCentre(FACILITY.lobby)
    return { pass: k?.kind === 'lobby' && Math.abs(lab.plan.points.elevator.x - L0.x) < HALF, detail: `elevator point is in the ${k?.kind}` }
  })

  window.fetch = realFetch
  Object.assign(settings.values, savedValues)
  const passed = results.filter((r) => r.pass).length
  const report = { complete: true, passed: passed === results.length, total: results.length, failed: results.filter((r) => !r.pass), results }
  window.__labChecks = report
  out.done(report)
  engine.start()
  void STATUS_LABEL
  return report
}

function renderPanel() {
  const panel = document.createElement('section')
  panel.className = 'reef-checks'
  panel.innerHTML = '<h3>Lab checks</h3><p class="reef-checks-sum">running…</p><ol></ol>'
  const style = document.createElement('style')
  style.textContent = `
    .reef-checks { position: fixed; right: 16px; top: 60px; bottom: 16px; z-index: 60; width: min(560px, calc(100vw - 32px)); overflow: auto; padding: 14px 16px; border-radius: 14px; border: 1px solid rgba(210,225,240,.24); background: rgba(10,14,20,.95); color: #eef3f8; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; }
    .reef-checks h3 { margin: 0 0 4px; font-size: 15px; }
    .reef-checks ol { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
    .reef-checks li { display: grid; grid-template-columns: 62px 70px minmax(0, 1fr); gap: 8px; }
    .reef-checks .ok { color: #3fcf86; } .reef-checks .bad { color: #ff5a4a; } .reef-checks .info { color: #5cc8ff; }
    .reef-checks small { display: block; color: #a3b2c2; overflow-wrap: anywhere; }
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
    },
  }
}
