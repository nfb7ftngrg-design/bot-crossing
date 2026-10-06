import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { liveThreadsForColony } from '../game/hidden-projects.js'
import { STATUS_ORDER, statusFor, transcriptProgress } from '../game/status.js'
import { shelfSignal } from '../reef/signals.js'
import { Beacons, Badges, Effects, BADGE } from '../reef/effects.js'
import { allocateRooms, buildPlan, deskFor, roomCentre } from './floorplan.js'
import { Facility, createRackLights } from './building.js'
import { Workstations } from './workstation.js'
import { Staff, MAX_PEOPLE } from './people.js'
import { CaseBoards } from './caseboards.js'
import { casesFor } from './cases.js'
import { labUniforms, hash } from './look.js'
import { drawOps, drawDept, drawTv } from './screens.js'

/**
 * The lab: the thread list in, a working floor out.
 *
 * This is the mapper. A project is a department with rooms of its own, a thread is a person at a
 * workstation, and what the thread is doing decides what the person is doing — decided once, by
 * the same `statusFor` the colony and the reef use. The only state it keeps worth saving is which
 * rooms each department holds, written back to the colony file as `labRooms`.
 */

const LAYOUT_MEMORY = 80
const BADGE_FOR = { waiting: BADGE.waiting, blocked: BADGE.blocked, celebrating: BADGE.done }

export class Lab {
  constructor(scene, renderer, settings) {
    this.scene = scene
    this.settings = settings
    this.effects = new Effects(scene)
    this.facility = new Facility(scene, settings)
    this.desks = new Workstations(scene)
    this.staff = new Staff(scene, this.facility, this.effects)
    this.boardGroup = new THREE.Group()
    scene.add(this.boardGroup)
    this.boards = new CaseBoards(this.boardGroup)
    this.beacons = new Beacons(scene)
    this.badges = new Badges(scene)

    this.rooms = new Map()
    this.slotOf = new Map()
    this.projects = []
    this.threads = new Map()
    this.cases = {}
    this.dormantProjects = new Set()
    this.capped = 0
    this.overflowCases = 0
    this._navSignature = ''
    this._screenClock = 99

    // Light: a soft room environment for the PBR surfaces, a key light from the ceiling for
    // shadows, and a hemisphere for when the environment is switched off.
    // Bedrock is the clear colour, not a scene background: three clears the frame for a colour
    // background on every render, and the overlay pass renders the scene a second time on top —
    // with a background colour that wipes everything the main pass drew.
    scene.background = null
    renderer.setClearColor(0x07090c, 1)
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.key = new THREE.DirectionalLight(0xfff4e6, 1.6)
    this.key.castShadow = true
    Object.assign(this.key.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 80 })
    this.key.shadow.bias = -0.0005
    this.key.shadow.normalBias = 0.03
    scene.add(this.key, this.key.target)
    this.hemi = new THREE.HemisphereLight(0xdfe8f2, 0x2a2f36, 0.8)
    scene.add(this.hemi)
    this.applySettings()
  }

  applySettings() {
    const s = this.settings
    const ibl = s.get('ibl')
    this.scene.environment = ibl ? this.envTexture : null
    this.hemi.intensity = ibl ? 0.2 : 0.75
    this.effects.setBudget(s.particleBudget)
    const size = s.shadowSize
    this.key.castShadow = size > 0
    if (size) this.key.shadow.mapSize.setScalar(size)
  }

  restoreLayout(saved) {
    for (const [name, cells] of Object.entries(saved || {})) {
      if (!Array.isArray(cells)) continue
      this.rooms.set(name, cells.filter((c) => Array.isArray(c) && c.length === 2).map(([q, r]) => ({ q, r })))
    }
  }

  layoutForSave() {
    const out = {}
    for (const [name, cells] of this.rooms) out[name] = cells.map((c) => [c.q, c.r])
    return out
  }

  setCases(cases) {
    this.cases = cases || {}
    this._syncCases()
  }

  setThreads(threads, archivedIds = new Set(), hiddenProjects = new Set(), knownIds = new Set()) {
    const now = Date.now()
    let live = liveThreadsForColony(threads, archivedIds, hiddenProjects)
    const cap = Math.min(MAX_PEOPLE, this.settings.get('maxAgents') || MAX_PEOPLE)
    this.capped = Math.max(0, live.length - cap)
    if (this.capped) {
      live = [...live]
        .sort((a, b) => STATUS_ORDER.indexOf(statusFor(a, now)) - STATUS_ORDER.indexOf(statusFor(b, now)) || b.lastActivityAt - a.lastActivityAt)
        .slice(0, cap)
    }

    const byProject = new Map()
    for (const t of live) {
      const k = t.project || 'unknown'
      if (!byProject.has(k)) byProject.set(k, [])
      byProject.get(k).push(t)
    }
    const dormant = new Set()
    if (this.settings.get('hideDormant')) {
      for (const [name, list] of byProject) if (list.every((t) => statusFor(t, now) === 'sleeping')) dormant.add(name)
      if (dormant.size === byProject.size) dormant.clear()
      for (const name of dormant) byProject.delete(name)
    }
    this.dormantProjects = dormant

    const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    const layout = allocateRooms(
      projects.map(([name, list]) => ({ id: name, size: list.length })),
      this.rooms
    )
    for (const [name, cells] of layout) {
      this.rooms.delete(name)
      this.rooms.set(name, cells)
    }
    for (const name of [...hiddenProjects, ...dormant]) {
      const cells = this.rooms.get(name)
      if (!cells) continue
      this.rooms.delete(name)
      this.rooms.set(name, cells)
    }
    while (this.rooms.size > LAYOUT_MEMORY) this.rooms.delete(this.rooms.keys().next().value)

    const shown = new Map(projects.map(([name]) => [name, layout.get(name) || []]))
    this.plan = buildPlan(shown)
    if (this.facility.setPlan(this.plan)) {
      this.rackLights = createRackLights(this.facility)
      this.boards.setSlots(this.facility.boardSlots)
    }
    this.facility.setArchived(archivedIds.size)

    const roster = []
    const seen = new Set()
    const stats = { agents: 0, projects: projects.length }
    for (const k of STATUS_ORDER) stats[k] = 0
    this.projects = []
    for (const [name, list] of projects) {
      const rooms = layout.get(name) || []
      if (!rooms.length) continue
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      const slots = this.slotOf.get(name) || new Map()
      this.slotOf.set(name, slots)
      for (const id of [...slots.keys()]) if (!list.some((t) => t.id === id)) slots.delete(id)
      const taken = new Set(slots.values())
      for (const t of list) {
        if (slots.has(t.id)) continue
        let slot = 0
        while (taken.has(slot)) slot++
        taken.add(slot)
        slots.set(t.id, slot)
      }
      const statuses = []
      const counts = {}
      for (const t of list) {
        const status = statusFor(t, now)
        stats[status]++
        stats.agents++
        statuses.push(status)
        counts[status] = (counts[status] || 0) + 1
        const desk = deskFor(rooms, slots.get(t.id))
        const onCase = casesFor(this.cases, t.id).some((c) => c.status !== 'closed')
        if (!this.desks.sync(t.id, desk, transcriptProgress(t), status, onCase, (hash(t.id) % 1000) / 1000)) continue
        seen.add(t.id)
        roster.push({ id: t.id, thread: t, status, desk, project: name, known: knownIds.has(t.id), onCase })
      }
      const signal = shelfSignal(statuses)
      const centre = rooms
        .reduce((acc, c) => {
          const w = roomCentre(c)
          return acc.add(new THREE.Vector3(w.x, 0, w.z))
        }, new THREE.Vector3())
        .divideScalar(rooms.length)
      this.projects.push({ name, count: list.length, counts, signal, urgent: signal.mode === 2, active: signal.mode > 0, centre, cells: rooms })
    }
    for (const id of [...this.desks.entries.keys()]) if (!seen.has(id)) this.desks.retire(id)

    // The walking map changes when a wall or a desk does. Rebuilt then, and only then.
    const navSignature = this.facility.signature + '|' + [...this.desks.entries.values()].map((e) => `${e.x},${e.z}`).sort().join(';')
    if (navSignature !== this._navSignature) {
      this._navSignature = navSignature
      this.staff.rebuildNav(this.plan, [...this.facility.obstacles, ...this.desks.obstacles()])
    }
    this.threads = new Map(live.map((t) => [t.id, t]))
    this.staff.setRoster(roster)
    this.stats = { ...stats, done: stats.celebrating }
    this._syncCases()
    this._screenClock = 99
    return this.stats
  }

  /** Folders on the desks of everyone on an open case, and the boards brought up to date. */
  _syncCases() {
    for (const e of this.desks.entries.values()) {
      const on = casesFor(this.cases, e.id).some((c) => c.status !== 'closed')
      if (e.onCase === on) continue
      e.onCase = on
      this.desks.extra[e.slot * 2 + 1] = on ? 1 : 0
      this.desks.mesh.geometry.attributes.aExtra.needsUpdate = true
      const person = this.staff.get(e.id)
      if (person) person.onCase = on
    }
    const people = new Map()
    for (const p of this.staff.order) people.set(p.id, { title: p.thread?.title, status: p.status, look: p.look })
    if (this.boards.boards.length) this.overflowCases = this.boards.update(this.cases, people)
  }

  /** 0..1 — the night shift runs from evening to morning; by day every fixture is on. */
  shift(t) {
    const day = THREE.MathUtils.smoothstep(t, 0.27, 0.31) * (1 - THREE.MathUtils.smoothstep(t, 0.77, 0.81))
    return day
  }

  currentTime(dt) {
    const s = this.settings
    if (s.get('clockTime')) {
      const d = new Date()
      this.time = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
    } else if (s.get('autoTime')) this.time = ((this.time ?? s.get('timeOfDay')) + dt / Math.max(10, s.get('dayLength'))) % 1
    else this.time = s.get('timeOfDay')
    return this.time
  }

  update(dt, elapsed, camera, focus, selectedId) {
    const t = this.currentTime(dt)
    const day = this.shift(t)
    labUniforms.uTime.value = elapsed
    labUniforms.uShift.value = 0.3 + 0.7 * day
    labUniforms.uNight.value = 1 - day
    this.key.intensity = 0.3 + 0.7 * day
    this.key.target.position.set(focus.x, 0, focus.z)
    this.key.position.set(focus.x + 8, 30, focus.z + 12)
    this.scene.environmentIntensity = this.settings.get('iblIntensity') * (0.22 + 0.2 * day)

    this.facility.update(dt, elapsed, camera, focus)
    this.desks.update(dt, 1 - day)
    this.staff.update(dt, elapsed, camera, selectedId)

    const working = this.staff.order.filter((p) => p.status === 'working').length
    this.facility.setActivity(Math.min(1, working / Math.max(4, this.staff.order.length * 0.5)))

    const beacons = new Map()
    const badges = []
    for (const p of this.staff.order) {
      if (p.mode !== 'live' || !this.staff.isShown(p)) continue
      if (p.status === 'waiting') beacons.set(p.id, p.pos)
      const icon = BADGE_FOR[p.status]
      if (icon !== undefined) badges.push({ pos: new THREE.Vector3(p.pos.x, p.seated ? 1.75 : 2.25, p.pos.z), icon })
    }
    this.beacons.update(dt, elapsed, beacons)
    this.badges.update(elapsed, badges)
    this.effects.update(dt, elapsed)

    this._screenClock += dt
    if (this._screenClock > 1.5) {
      this._screenClock = 0
      this._drawScreens(elapsed)
    }
    return { time: t, day, night: 1 - day }
  }

  _drawScreens(elapsed) {
    const f = this.facility
    const people = this.staff.order.filter((p) => p.mode !== 'leaving')
    if (f.screens.ops && this.plan) f.screens.ops.texture.userData.redraw((ctx, w, h) => drawOps(ctx, w, h, { plan: this.plan, people, stats: this.stats || {} }))
    if (f.screens.tv) f.screens.tv.texture.userData.redraw((ctx, w, h) => drawTv(ctx, w, h, { stats: this.stats || {}, tick: elapsed }))
    for (const [name, screen] of f.deptScreens || []) {
      screen.texture.userData.redraw((ctx, w, h) => drawDept(ctx, w, h, { name, people: people.filter((p) => p.project === name) }))
    }
  }
}
