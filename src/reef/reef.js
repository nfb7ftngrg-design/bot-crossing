import * as THREE from 'three'
import { allocateCells, hexToWorld } from '../world/layout.js'
import { liveThreadsForColony } from '../game/hidden-projects.js'
import { STATUS_ORDER, statusFor, transcriptProgress } from '../game/status.js'
import { Water } from './water.js'
import { Seabed } from './seabed.js'
import { Corals } from './coral.js'
import { School, Shoal, MAX_FISH } from './fish.js'
import { shelfSignal } from './signals.js'
import { Beacons, Badges, Effects, BADGE } from './effects.js'

/**
 * The reef: the thread list in, a place out.
 *
 * This is the mapper. It owns no state of its own worth saving except where each repo's shelf
 * sits, and that comes from — and goes back to — the same `plots` the colony keeps, through the
 * same allocator. So a repo holds the same hexes in both worlds, and a shelf only ever moves when
 * its own footprint changes.
 */

/** A project this old (by its oldest thread) has the most overgrown shelf. */
const AGE_FULL_MS = 180 * 864e5
/** How many repos' ground to remember, including ones with nothing running right now. */
const LAYOUT_MEMORY = 80
/** Coral slots in a cell: the middle, then a ring of six. */
const SLOTS_PER_CELL = 7
const SLOT_RING = 3.7

const BADGE_FOR = { waiting: BADGE.waiting, blocked: BADGE.blocked, celebrating: BADGE.done }

export class Reef {
  constructor(scene, renderer, settings) {
    this.scene = scene
    this.settings = settings
    this.effects = new Effects(scene)
    this.water = new Water(scene, renderer, settings)
    this.seabed = new Seabed(scene, settings)
    this.corals = new Corals(scene)
    this.school = new School(scene, this.seabed, this.effects)
    this.beacons = new Beacons(scene)
    this.badges = new Badges(scene)
    this.shoal = new Shoal(scene)
    this._bubbleClock = 0

    /** project → cells, remembered between polls and seeded from the saved colony file. */
    this.plotCells = new Map()
    this.slotOf = new Map()
    this.projects = []
    this.threads = new Map()
    this.dormantProjects = new Set()
    this.capped = 0
    this.applySettings()
  }

  applySettings() {
    this.water.applySettings()
    this.effects.setBudget(this.settings.particleBudget)
    // Traffic is ambience, and ambience is the first thing a weak machine gives up.
    this.shoal.setVisible(this.settings.particleBudget > 0)
  }

  /** Before the first roster: shelves come back to the ground they held last time. */
  restoreLayout(plots) {
    for (const [name, cells] of Object.entries(plots || {})) {
      if (!Array.isArray(cells)) continue
      this.plotCells.set(
        name,
        cells.filter((c) => Array.isArray(c) && c.length === 2).map(([q, r]) => ({ q, r }))
      )
    }
  }

  layoutForSave() {
    const out = {}
    for (const [name, cells] of this.plotCells) out[name] = cells.map((c) => [c.q, c.r])
    return out
  }

  setThreads(threads, archivedIds = new Set(), hiddenProjects = new Set(), knownIds = new Set()) {
    const now = Date.now()
    let live = liveThreadsForColony(threads, archivedIds, hiddenProjects)

    // The crowd is capped by the quality preset. What is dropped is the least interesting end of
    // the list — dormant before idle, idle before anything that wants you.
    const cap = Math.min(MAX_FISH, this.settings.get('maxAgents') || MAX_FISH)
    this.capped = Math.max(0, live.length - cap)
    if (this.capped) {
      live = [...live]
        .sort((a, b) => STATUS_ORDER.indexOf(statusFor(a, now)) - STATUS_ORDER.indexOf(statusFor(b, now)) || b.lastActivityAt - a.lastActivityAt)
        .slice(0, cap)
    }

    const byProject = new Map()
    for (const thread of live) {
      const key = thread.project || 'unknown'
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push(thread)
    }
    // Repos where nothing has stirred in days, folded away — the colony's setting, shared.
    const dormant = new Set()
    if (this.settings.get('hideDormant')) {
      for (const [name, list] of byProject) if (list.every((t) => statusFor(t, now) === 'sleeping')) dormant.add(name)
      if (dormant.size === byProject.size) dormant.clear()
      for (const name of dormant) byProject.delete(name)
    }
    this.dormantProjects = dormant

    const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    const layout = allocateCells(
      projects.map(([name, list]) => ({ id: name, size: list.length })),
      this.plotCells
    )
    for (const [name, cells] of layout) {
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }
    for (const name of [...hiddenProjects, ...dormant]) {
      const cells = this.plotCells.get(name)
      if (!cells) continue
      this.plotCells.delete(name)
      this.plotCells.set(name, cells)
    }
    while (this.plotCells.size > LAYOUT_MEMORY) this.plotCells.delete(this.plotCells.keys().next().value)

    const shown = new Map(projects.map(([name]) => [name, layout.get(name) || []]))
    // How established each project is, from its oldest thread, in tenths so a shelf is not
    // rebuilt because a day went by.
    const ages = new Map(
      projects.map(([name, list]) => {
        const oldest = Math.min(...list.map((t) => t.createdAt || now))
        return [name, Math.round(Math.min(1, Math.max(0, (now - oldest) / AGE_FULL_MS)) * 10) / 10]
      })
    )
    this.seabed.setLayout(shown, ages)

    const roster = []
    const seen = new Set()
    const stats = { agents: 0, projects: projects.length }
    for (const key of STATUS_ORDER) stats[key] = 0
    this.projects = []

    for (const [name, list] of projects) {
      const cells = layout.get(name) || []
      if (!cells.length) continue
      // Oldest thread first, and a thread keeps its slot while the shelf stands, so one archive
      // never shuffles the corals of everything younger.
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      const slots = this.slotOf.get(name) || new Map()
      this.slotOf.set(name, slots)
      for (const id of [...slots.keys()]) if (!list.some((t) => t.id === id)) slots.delete(id)
      const taken = new Set(slots.values())
      for (const thread of list) {
        if (slots.has(thread.id)) continue
        let slot = 0
        while (taken.has(slot)) slot++
        taken.add(slot)
        slots.set(thread.id, slot)
      }

      const statuses = []
      const counts = {}
      for (const thread of list) {
        const status = statusFor(thread, now)
        stats[status]++
        stats.agents++
        statuses.push(status)
        counts[status] = (counts[status] || 0) + 1
        const position = this._slotPosition(cells, slots.get(thread.id))
        const home = this.corals.sync(thread.id, position, transcriptProgress(thread), status === 'working')
        if (!home) continue
        seen.add(thread.id)
        roster.push({ id: thread.id, thread, status, home, cells, project: name, known: knownIds.has(thread.id) })
      }
      const signal = shelfSignal(statuses)
      const urgent = signal.mode === 2
      const active = urgent || statuses.includes('working')
      const centre = cells.reduce((acc, c) => {
        const w = hexToWorld(c.q, c.r)
        return acc.add(new THREE.Vector3(w.x, 0, w.z))
      }, new THREE.Vector3()).divideScalar(cells.length)
      centre.y = this.seabed.heightAt(centre.x, centre.z)
      this.projects.push({ name, count: list.length, counts, signal, urgent, active, centre, cells, age: ages.get(name) })
    }
    this.seabed.setSignals(new Map(this.projects.map((p) => [p.name, p.signal])))

    for (const id of [...this.corals.entries.keys()]) if (!seen.has(id)) this.corals.retire(id)
    this.threads = new Map(live.map((t) => [t.id, t]))
    this.school.setRoster(roster)
    this.stats = { ...stats, done: stats.celebrating }
    return this.stats
  }

  _slotPosition(cells, slot) {
    const cell = cells[Math.floor(slot / SLOTS_PER_CELL) % cells.length]
    const k = slot % SLOTS_PER_CELL
    const c = hexToWorld(cell.q, cell.r)
    // Past the cells' own room the slots spiral further out, so an overfull shelf still places.
    const ring = Math.floor(slot / (SLOTS_PER_CELL * cells.length))
    const x = c.x + (k ? Math.cos((k - 1) * (Math.PI / 3) + 0.5 + ring) * (SLOT_RING - ring * 1.2) : ring * 1.6)
    const z = c.z + (k ? Math.sin((k - 1) * (Math.PI / 3) + 0.5 + ring) * (SLOT_RING - ring * 1.2) : 0)
    return new THREE.Vector3(x, this.seabed.heightAt(x, z) - 0.05, z)
  }

  update(dt, elapsed, camera, focus, selectedId) {
    const light = this.water.update(dt, elapsed, focus, camera)
    this.seabed.update(dt, light.night)
    this.corals.update(dt)
    this.school.update(dt, elapsed, camera, this.corals, selectedId)
    this.shoal.update(dt, elapsed)

    // Activity drives ambience: every running thread's coral breathes out a thin stream of
    // bubbles, so a shelf with several threads at work is visibly busier than a quiet one.
    this._bubbleClock += dt
    if (this._bubbleClock > 0.35) {
      this._bubbleClock = 0
      for (const coral of this.corals.entries.values()) {
        if (!coral.active || coral.leaving || Math.random() > 0.5) continue
        const at = coral.position.clone()
        at.y += coral.height * coral.growth * 0.9
        this.effects.burst(at, 'bubbles', 1)
      }
    }

    const beacons = new Map()
    const badges = []
    for (const fish of this.school.order) {
      if (fish.mode !== 'live' || !this.school.isShown(fish)) continue
      if (fish.status === 'waiting') beacons.set(fish.id, fish.pos)
      const icon = BADGE_FOR[fish.status]
      if (icon !== undefined) badges.push({ pos: new THREE.Vector3(fish.pos.x, fish.pos.y + 0.9, fish.pos.z), icon })
    }
    this.beacons.update(dt, elapsed, beacons)
    this.badges.update(elapsed, badges)
    this.effects.update(dt, elapsed)
    return light
  }
}
