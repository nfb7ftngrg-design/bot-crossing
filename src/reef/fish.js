import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { CELL, hexToWorld } from '../world/layout.js'
import { patchMaterial, rng } from './shading.js'

/**
 * The fish: one per thread, the whole school in a single instanced draw.
 *
 * The swim is done in the vertex shader, upstream of the instance transform — the same seam the
 * skill's baked-skeleton approach uses. A fish has no skeleton, so its "animation" is a travelling
 * wave down the body rather than a sampled clip, and there is nothing to bake. Each instance
 * carries one phase and one amplitude; the CPU only advances those and the instance matrix.
 *
 * What a fish *does* comes from its thread's status. How hard its tail beats comes from how far
 * it actually moved last frame, never from how fast it wanted to go: when separation or a coral
 * refuses the step, intent and motion come apart, and a fish beating flat out against a coral
 * reads as broken.
 */

export const MAX_FISH = 400
const LENGTH = 1.2
const FISH_SCALE = 0.95
const SIZE_MIN = 0.85
const SIZE_RANGE = 0.35
/** Half the body's thickness, for coral clearance. Coral is judged against the fish's flank. */
const RADIUS = 0.42 * FISH_SCALE
/**
 * The widest thing a fish is: its length at the largest size. Fish keep this far apart, centre to
 * centre — spacing them by anything smaller is a crowd swimming inside itself.
 */
export const BODY = LENGTH * FISH_SCALE * (SIZE_MIN + SIZE_RANGE)
/**
 * How close counts as arrived at a spot a fish means to stay at. Deliberately larger than the
 * spacing, so a fish whose spot is crowded by a neighbour still finishes arriving instead of
 * shouldering at it forever.
 */
export const ARRIVE = BODY * 1.15
/** Darting fish turn for the next point when this close — they never settle, so need no slack. */
const DART_REACH = 0.5
/** Seconds without getting any closer before a fish gives up and adopts the ground it got to. */
const GIVE_UP = 3
/** How high above the sand a resting fish lies. */
const LIFT = { blocked: 0.32, sleeping: 0.3 }

/** Fish come in pairs of colours, chosen per thread. Never gold, never red — those are signals. */
const BODY_COLORS = [0x2f7fd8, 0xf27a3d, 0x3cc4b4, 0xe8e8f0, 0x7b5cd6, 0x2bb3e6, 0xf09ac0, 0x5ad07a, 0x1f3c88, 0xff9f6e]
const PATTERN_COLORS = [0xffffff, 0x14213d, 0xf2f2f2, 0x0b0b1a, 0x7ee8fa, 0xfff1e0]

/**
 * Everything about how a fish looks, from its thread id and nothing else. Hashed, never random,
 * so a long-running thread is the same fish every time the reef is opened and people learn it.
 * Pure, so it can be checked under node.
 */
export function fishLook(id) {
  const random = rng(id)
  return {
    yaw: random() * Math.PI * 2,
    phase: random() * 10,
    fin: random() * 10,
    loop: random() * Math.PI * 2,
    orbit: random() * Math.PI * 2,
    size: SIZE_MIN + random() * SIZE_RANGE,
    body: BODY_COLORS[Math.floor(random() * BODY_COLORS.length)],
    pattern: PATTERN_COLORS[Math.floor(random() * PATTERN_COLORS.length)],
    patternKind: Math.floor(random() * 4),
    patternFreq: 2 + Math.floor(random() * 4),
    patternPhase: random(),
    /** How brisk this individual is, and how long it lingers — pottering varies per fish. */
    pace: 0.8 + random() * 0.5,
    linger: 0.7 + random() * 0.9,
    random,
  }
}

/** Plain-language account of what a fish in each state is doing, and why. Shared with the card. */
export const DOING = {
  working: 'Darting round its coral with a pebble — the thread is running right now.',
  waiting: 'Risen out of the reef, facing you — the thread has replied and is waiting for you.',
  blocked: 'Lying on its side by its coral — the thread stopped on an error.',
  celebrating: 'Looping over its coral — the thread’s pull request merged.',
  sleeping: 'Resting on the sand — nothing has happened in this thread for three days.',
  idle: 'Pottering about its shelf — the thread is open, nothing needs you.',
  arriving: 'Swimming out of the wreck to its shelf — a new thread just started.',
  leaving: 'Swimming back to the wreck — the thread was archived.',
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler(0, 0, 0, 'YXZ')
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _steer = new THREE.Vector3()
const _desired = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/** The fish material, shared by the school and the shoal — same swim, same patterns. */
function makeFishMaterial(key) {
  const { material, depth } = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.08, side: THREE.DoubleSide }), {
    key,
    vertexPars: FISH_VERTEX_PARS,
    vertex: FISH_VERTEX,
    fragmentPars: FISH_FRAGMENT_PARS,
    fragmentColor: FISH_FRAGMENT_COLOR,
    emissive: FISH_EMISSIVE,
    caustics: 0.55,
  })
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader) => {
    previous(shader)
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vBody = aBody; vFin = aFin; vLocal = position; vColorB = aColorB; vPattern = aPattern; vDrain = aSwim.w; vGlow = aGlow;`
    )
  }
  return { material, depth }
}

function fishAttributes(geo, max) {
  const attrs = {
    colorB: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
    pattern: new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3),
    swim: new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage),
    glow: new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage),
  }
  geo.setAttribute('aColorB', attrs.colorB)
  geo.setAttribute('aPattern', attrs.pattern)
  geo.setAttribute('aSwim', attrs.swim)
  geo.setAttribute('aGlow', attrs.glow)
  return attrs
}

export class School {
  constructor(scene, seabed, effects) {
    this.scene = scene
    this.seabed = seabed
    this.effects = effects
    this.fish = new Map()
    this.order = []
    this.free = []
    this.used = 0
    /** The fish under the pointer, which turns to look at you. Set by the page. */
    this.hoverId = null
    /** (fish) → boolean. Fish it rejects swim off-stage; null shows everyone. */
    this.filter = null

    const geo = buildFishGeometry()
    this.attrs = fishAttributes(geo, MAX_FISH)
    const { material, depth } = makeFishMaterial('fish')
    this.mesh = new THREE.InstancedMesh(geo, material, MAX_FISH)
    this.mesh.customDepthMaterial = depth
    this.mesh.castShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1))
    scene.add(this.mesh)

    // The working prop: a pebble carried in the mouth. Its own single draw for the whole school.
    const { material: pebbleMaterial } = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xe9e0cf, roughness: 0.7 }), { key: 'pebble' })
    this.props = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 1), pebbleMaterial, MAX_FISH)
    this.props.count = 0
    this.props.castShadow = true
    this.props.frustumCulled = false
    scene.add(this.props)

    this.stats = { frames: 0, penetrations: 0, groundHits: 0, overlaps: 0, minGap: Infinity, settled: 0, gaveUp: 0, legs: 0, flashes: 0, lifts: 0 }
    this.corals = []
    /** Height of the travelling lane, above every coral on the reef. Updated each frame. */
    this.lane = 6
    this._gapClock = 0
  }

  /**
   * Bring the school in line with the roster. `roster` is [{ id, thread, status, home, cells,
   * project, known }]. Fish missing from it swim back to the wreck.
   */
  setRoster(roster) {
    const seen = new Set()
    for (const r of roster) {
      seen.add(r.id)
      let fish = this.fish.get(r.id)
      if (!fish) fish = this._spawn(r)
      if (!fish) continue
      fish.thread = r.thread
      fish.cells = r.cells
      fish.home = r.home
      fish.project = r.project
      if (fish.mode === 'leaving') fish.mode = 'live'
      if (fish.status !== r.status) {
        fish.status = r.status
        fish.retarget = 0
        fish.settledAt = null
        fish.pause = 0
      }
    }
    for (const fish of this.fish.values()) {
      if (!seen.has(fish.id) && fish.mode !== 'leaving') {
        fish.mode = 'leaving'
        fish.retarget = 0
        fish.settledAt = null
        this.effects.burst(fish.pos, 'bubbles', 10)
      }
    }
  }

  _spawn(r) {
    const index = this.free.length ? this.free.pop() : this.used++
    if (index >= MAX_FISH) {
      this.used = MAX_FISH
      return null
    }
    const look = fishLook(r.id)
    const fish = {
      id: r.id,
      index,
      thread: r.thread,
      status: r.status,
      home: r.home,
      cells: r.cells,
      project: r.project,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      last: new THREE.Vector3(),
      target: new THREE.Vector3(),
      retarget: 0,
      yaw: look.yaw,
      pitch: 0,
      roll: 0,
      speed: 0,
      phase: look.phase,
      fin: look.fin,
      amp: 0.3,
      drain: 0,
      glow: 0,
      flash: 0,
      loop: look.loop,
      orbit: look.orbit,
      fade: 1,
      shown: 1,
      size: look.size,
      pace: look.pace,
      linger: look.linger,
      pause: 0,
      paused: false,
      pauseYaw: 0,
      gaze: 0,
      settledAt: null,
      best: Infinity,
      stuck: 0,
      look: null,
      lookFor: 0,
      random: look.random,
      mode: r.known ? 'live' : 'arriving',
    }
    if (r.known) {
      // Already on the reef's books: it is simply there, no entrance on every reload.
      const a = look.random() * Math.PI * 2
      fish.pos.set(r.home.position.x + Math.cos(a) * 2.2, 0, r.home.position.z + Math.sin(a) * 2.2)
      fish.pos.y = this.seabed.heightAt(fish.pos.x, fish.pos.z) + 1 + look.random()
    } else {
      fish.pos.copy(this.seabed.wreckMouth)
      fish.fade = 0
      this.effects.burst(fish.pos, 'bubbles', 14)
    }
    fish.last.copy(fish.pos)

    const a = new THREE.Color(look.body)
    const b = new THREE.Color(look.pattern)
    this.mesh.setColorAt(index, a)
    this.mesh.instanceColor.needsUpdate = true
    this.attrs.colorB.setXYZ(index, b.r, b.g, b.b)
    this.attrs.pattern.setXYZ(index, look.patternKind, look.patternFreq, look.patternPhase)
    this.attrs.colorB.needsUpdate = true
    this.attrs.pattern.needsUpdate = true
    fish.color = a

    this.fish.set(r.id, fish)
    this._rebuildOrder()
    return fish
  }

  _remove(fish) {
    this.fish.delete(fish.id)
    this.free.push(fish.index)
    // Parked out of sight with zero scale; the slot is reused by the next arrival.
    _m.makeScale(0, 0, 0)
    this.mesh.setMatrixAt(fish.index, _m)
    this.props.setMatrixAt(fish.index, _m)
    this._rebuildOrder()
  }

  _rebuildOrder() {
    this.order = [...this.fish.values()]
    this.mesh.count = this.used
    this.props.count = this.used
  }

  get(id) {
    return this.fish.get(id)
  }

  /** True when this fish is on stage: not filtered away, not on its way out. */
  isShown(fish) {
    return fish.mode !== 'leaving' && (!this.filter || this.filter(fish))
  }

  // ── behaviour ─────────────────────────────────────────────────────────────────────────

  /**
   * A spot on the sand beside its own coral, clear of every coral's blocked radius. Eight
   * headings are tried, starting from the fish's own, and the one with the most room wins — a
   * spot inside a neighbour's coral can never be reached, and whatever is sent there pushes at
   * that coral forever.
   */
  _restingSpot(fish, start, gap, lift) {
    const home = fish.home.position
    const r = fish.home.radius + gap
    let best = null
    let bestRoom = -Infinity
    for (let i = 0; i < 8; i++) {
      const a = start + (i * Math.PI) / 4
      const x = home.x + Math.cos(a) * r
      const z = home.z + Math.sin(a) * r
      let room = Infinity
      for (const c of this.corals) {
        if (c.growth < 0.05 && c.target < 0.05) continue
        room = Math.min(room, Math.hypot(x - c.position.x, z - c.position.z) - (c.radius * 0.8 + RADIUS + 0.35))
      }
      // Ground the shelf owns is preferred, so a fish does not settle down a cliff.
      if (this.seabed.ownerAt(x, z) !== fish.project) room -= 2
      if (room > bestRoom + 0.05) {
        bestRoom = room
        best = [x, z]
      }
    }
    this._settleAt(fish, best[0], this.seabed.heightAt(best[0], best[1]) + lift, best[1], lift)
  }

  /** A spot a still fish means to stay at: chosen once, then left alone. */
  _settleAt(fish, x, y, z, lift = null) {
    fish.target.set(x, y, z)
    fish.lift = lift
    fish.retarget = Infinity
    fish.best = Infinity
    fish.stuck = 0
  }

  /** Pick where this fish wants to be and how fast, from what its thread is doing. */
  _behave(fish, dt, elapsed) {
    const home = fish.home.position
    const coral = fish.home
    const ground = (x, z) => this.seabed.heightAt(x, z)
    fish.retarget -= dt
    const random = fish.random
    const dist = fish.pos.distanceTo(fish.target)

    if (fish.mode === 'arriving') {
      _w.set(home.x + 1.8, ground(home.x, home.z) + 1.8, home.z + 1.2)
      this._route(fish, _w)
      fish.cruise = 2.6
      if (fish.pos.distanceTo(_w) < 2) {
        fish.mode = 'live'
        fish.retarget = 0
      }
      return
    }
    if (fish.mode === 'leaving') {
      this._route(fish, this.seabed.wreckMouth)
      fish.cruise = 2.8
      return
    }

    switch (fish.status) {
      case 'working': {
        // Tight darting circuits round its own coral, touching down to pick at the sand.
        if (dist < DART_REACH || fish.retarget <= 0) {
          if (dist < DART_REACH && fish.pos.y - ground(fish.pos.x, fish.pos.z) < 0.7) {
            _v.set(fish.pos.x, ground(fish.pos.x, fish.pos.z) + 0.05, fish.pos.z)
            this.effects.burst(_v, 'sand', 8)
          }
          // Each dash carries on round the coral in the same direction, so the circuit flows
          // instead of doubling back — a fish reversing every leg reads as twitchy, not busy.
          fish.orbit += 0.6 + random() * 0.5
          const r = coral.radius + 0.8 + random() * 0.6
          const x = home.x + Math.cos(fish.orbit) * r
          const z = home.z + Math.sin(fish.orbit) * r
          const low = random() < 0.45
          fish.target.set(x, ground(x, z) + (low ? 0.4 : 0.6 + random() * coral.height * 0.8), z)
          fish.retarget = 0.7 + random() * 0.9
          this.stats.legs++
        }
        fish.cruise = 4
        break
      }
      case 'celebrating': {
        // Loops over its coral, with a flash every few seconds that its neighbours turn to see.
        fish.loop += dt * 2.1
        const top = home.y + coral.height + 2.2
        const r = 1.4
        const s = Math.sin(fish.loop + 0.5) * r
        fish.target.set(home.x + Math.sin(fish.orbit) * s, top + Math.cos(fish.loop + 0.5) * r, home.z + Math.cos(fish.orbit) * s)
        fish.cruise = 3.2
        fish.flash -= dt
        if (fish.flash <= 0) {
          fish.flash = 2.6 + random() * 1.6
          fish.glow = 1
          this.stats.flashes++
          this.effects.burst(fish.pos, 'sparkle', 16)
          this._drawAttention(fish)
        }
        break
      }
      case 'waiting': {
        // Up out of the reef where it can be seen, facing you. It bobs, but the spot is fixed.
        const bob = Math.sin(elapsed * 1.5 + fish.phase) * 0.15
        fish.target.set(home.x, home.y + coral.height + 3.2 + bob, home.z)
        fish.cruise = 1.8
        break
      }
      case 'blocked': {
        // Down by its coral, on its side — chosen once, then it stays.
        if (fish.retarget <= 0) this._restingSpot(fish, fish.orbit, 0.7, LIFT.blocked)
        fish.cruise = 0.9
        break
      }
      case 'sleeping': {
        // Settles on the sand and stays. Only a neighbour pushing it moves it.
        if (fish.retarget <= 0) this._restingSpot(fish, fish.orbit + 1.3, 1.2, LIFT.sleeping)
        fish.cruise = 0.45
        break
      }
      default: {
        // Idle: short legs about its own shelf at its own pace, pausing to look around between.
        if (fish.pause > 0) {
          fish.pause -= dt
          fish.gaze += dt
          fish.target.copy(fish.pos)
          break
        }
        if (dist < DART_REACH && !fish.paused) {
          // End of a leg: linger a moment, looking about, before the next.
          fish.pause = (1.2 + random() * 3) * fish.linger
          fish.paused = true
          fish.gaze = 0
          fish.pauseYaw = fish.yaw
          fish.target.copy(fish.pos)
          break
        }
        if (dist < DART_REACH || fish.retarget <= 0) {
          fish.paused = false
          const cell = fish.cells[Math.floor(random() * fish.cells.length)] || { q: 0, r: 0 }
          const c = hexToWorld(cell.q, cell.r)
          const a = random() * Math.PI * 2
          const d = random() * CELL * 0.62
          const x = c.x + Math.cos(a) * d
          const z = c.z + Math.sin(a) * d
          fish.target.set(x, ground(x, z) + 0.9 + random() * 2, z)
          fish.retarget = 6 + random() * 5
          this.stats.legs++
        }
        fish.cruise = 1.15 * fish.pace
      }
    }
  }

  /**
   * Long trips — out of the wreck to a shelf, back to the wreck — take a route rather than
   * trusting steering to find the way: up to a lane above the tallest coral, across, and down at
   * the far end. Steering alone can be pinned between two corals whose pushes cancel the pull,
   * and a fish must never be stuck because avoidance was all it had.
   */
  _route(fish, dest) {
    const dx = dest.x - fish.pos.x
    const dz = dest.z - fish.pos.z
    const far = Math.hypot(dx, dz)
    if (far > 4) {
      // Climb first, then cross: aim along the way at lane height, never straight through.
      const step = Math.min(far, 6)
      fish.target.set(fish.pos.x + (dx / far) * step, Math.max(this.lane, dest.y), fish.pos.z + (dz / far) * step)
      if (fish.pos.y < this.lane - 0.5) fish.target.set(fish.pos.x + (dx / far) * 1.5, this.lane, fish.pos.z + (dz / far) * 1.5)
    } else fish.target.copy(dest)
  }

  /** A celebration turns the heads of the quiet fish nearby. */
  _drawAttention(source) {
    for (const fish of this.order) {
      if (fish === source || fish.mode !== 'live') continue
      if (fish.status === 'working' || fish.status === 'celebrating') continue
      if (fish.pos.distanceTo(source.pos) > 9) continue
      fish.look = source.pos
      fish.lookFor = 2.2
    }
  }

  /**
   * Move a target out of any coral it landed in. Steering avoids corals on the way, but a target
   * inside one is a standing order to crash, and darting fish pick a new one every second.
   */
  _clearOfCorals(target, coralList) {
    // A few passes, because stepping out of one coral can step into its neighbour.
    for (let pass = 0; pass < 3; pass++) if (!this._clearOnce(target, coralList)) return
  }

  _clearOnce(target, coralList) {
    let moved = false
    for (const coral of coralList) {
      if (coral.growth < 0.05) continue
      const top = coral.position.y + coral.height * Math.min(1, coral.growth + 0.1)
      if (target.y > top + 0.3) continue
      const dx = target.x - coral.position.x
      const dz = target.z - coral.position.z
      const d = Math.hypot(dx, dz)
      const keep = coral.radius * 0.8 + RADIUS + 0.35
      if (d >= keep) continue
      const k = keep / (d || 1e-4)
      target.x = coral.position.x + (d ? dx * k : keep)
      target.z = coral.position.z + (d ? dz * k : 0)
      moved = true
    }
    return moved
  }

  /**
   * A fish that has stopped getting any closer gives up after a few seconds. A still fish adopts
   * the ground it reached; a moving one picks its next point. Without this, a spot a neighbour is
   * sitting on is a fish nudging at that neighbour forever.
   */
  _checkProgress(fish, dist, dt) {
    if (fish.mode !== 'live') {
      // On a trip, a fish making no headway for a few seconds is lifted straight up to the lane.
      if (dist < fish.best - 0.05) {
        fish.best = dist
        fish.stuck = 0
      } else if ((fish.stuck += dt) > GIVE_UP) {
        fish.stuck = 0
        fish.best = Infinity
        fish.vel.y += 3
        this.stats.lifts++
      }
      return
    }
    if (dist < fish.best - 0.05) {
      fish.best = dist
      fish.stuck = 0
      return
    }
    const still = fish.status === 'blocked' || fish.status === 'sleeping' || fish.status === 'waiting'
    if (still && dist < ARRIVE) return
    fish.stuck += dt
    if (fish.stuck < GIVE_UP) return
    this.stats.gaveUp++
    fish.gaveUp = (fish.gaveUp || 0) + 1
    fish.stuck = 0
    fish.best = Infinity
    // Adopting the ground it got to means the sand under where it stopped, not the water it was
    // passing through on the way down.
    if (still && fish.status !== 'waiting') {
      const lift = fish.lift ?? LIFT[fish.status]
      this._settleAt(fish, fish.pos.x, this.seabed.heightAt(fish.pos.x, fish.pos.z) + lift, fish.pos.z, lift)
    }
    else fish.retarget = 0
  }

  /**
   * Hard spacing, after steering. Steering keeps fish a body apart nearly all the time, but it is
   * a preference: two fish whose targets coincide can still meet. Nothing may ever sit inside
   * another, so any pair closer than this is pushed apart, half each, and the push is written into
   * the instance matrix so what is drawn is what was decided.
   */
  _separate(list) {
    const min = BODY * 0.6
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (a.mode === 'leaving' || a.mode === 'arriving') continue
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (b.mode === 'leaving' || b.mode === 'arriving') continue
        _v.subVectors(a.pos, b.pos)
        const d = _v.length()
        if (d >= min) continue
        if (d < 1e-5) _v.set(1, 0, 0)
        else _v.multiplyScalar(1 / d)
        const push = (min - d) / 2
        a.pos.addScaledVector(_v, push)
        b.pos.addScaledVector(_v, -push)
        this.stats.pushes = (this.stats.pushes || 0) + 1
        for (const f of [a, b]) {
          this.mesh.getMatrixAt(f.index, _m)
          _m.setPosition(f.pos)
          this.mesh.setMatrixAt(f.index, _m)
        }
      }
    }
  }

  update(dt, elapsed, camera, corals, selectedId) {
    if (dt <= 0) return
    const list = this.order
    const coralList = corals ? [...corals.entries.values()] : []
    this.corals = coralList
    this.stats.frames += list.length
    let tallest = 3
    for (const c of coralList) tallest = Math.max(tallest, c.position.y + c.height)
    this.lane = tallest + 1.5
    let settled = 0

    for (const fish of list) {
      this._behave(fish, dt, elapsed)
      if (fish.mode === 'live') {
        this._clearOfCorals(fish.target, coralList)
        // A resting spot moved clear of a coral may have moved over lower ground — off a shelf
        // edge, say. It is a spot on the sand, so it follows the sand down.
        if (fish.lift != null && (fish.status === 'blocked' || fish.status === 'sleeping')) {
          fish.target.y = this.seabed.heightAt(fish.target.x, fish.target.z) + fish.lift
        }
      }

      // Steering: arrive at the target, keep apart from neighbours, keep out of coral and rock.
      _desired.subVectors(fish.target, fish.pos)
      const dist = _desired.length()
      this._checkProgress(fish, dist, dt)
      const still = fish.mode === 'live' && (fish.status === 'blocked' || fish.status === 'sleeping')
      // A still fish inside its arrival radius has arrived: it stops reaching sideways for the
      // exact spot — that is what stops it shouldering a neighbour lying there — but it still
      // sinks the last of the way down onto the sand.
      const arrived = still && dist < ARRIVE
      // Darting fish brake late, so each dash is a dash; everyone else eases in.
      const brake = fish.status === 'working' && fish.mode === 'live' ? 0.6 : 1.8
      if (arrived) {
        // Inside the arrival radius: keep easing in while the way is clear, stop while a neighbour
        // is in it — and always settle down onto the sand.
        let crowded = false
        for (const other of list) {
          if (other !== fish && other.mode !== 'leaving' && other.pos.distanceToSquared(fish.pos) < BODY * BODY * 1.1) crowded = true
        }
        const ease = crowded ? 0 : Math.min(0.5, dist * 0.6)
        _desired.multiplyScalar(dist > 1e-4 ? ease / dist : 0)
        _desired.y = THREE.MathUtils.clamp((fish.target.y - fish.pos.y) * 1.5, -0.6, 0.6)
      }
      else _desired.multiplyScalar(dist > 1e-4 ? (fish.cruise * Math.min(1, dist / brake)) / dist : 0)
      _steer.subVectors(_desired, fish.vel)

      for (const other of list) {
        if (other === fish || other.mode === 'leaving') continue
        _v.subVectors(fish.pos, other.pos)
        const d2 = _v.lengthSq()
        if (d2 > BODY * BODY || d2 < 1e-8) continue
        const d = Math.sqrt(d2)
        _steer.addScaledVector(_v, ((BODY - d) / BODY) * 7 / d)
      }

      // Obstacles are judged where the fish is about to be, not where it is: a fish darting at
      // speed past a neighbour's coral needs to start turning before it is alongside.
      const ahead = Math.min(0.45, 0.6 / (fish.vel.length() + 0.5))
      const px = fish.pos.x + fish.vel.x * ahead
      const pz = fish.pos.z + fish.vel.z * ahead
      for (const coral of coralList) {
        if (coral.growth < 0.05) continue
        const dx = px - coral.position.x
        const dz = pz - coral.position.z
        const reach = coral.radius * 0.8 + RADIUS + 0.5
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue
        const top = coral.position.y + coral.height * Math.min(1, coral.growth + 0.1)
        if (fish.pos.y > top + 0.4) continue
        const d = Math.hypot(dx, dz) || 1e-4
        if (d < reach) {
          const push = ((reach - d) / reach) * 9
          _steer.x += (dx / d) * push
          _steer.z += (dz / d) * push
          // Swimming fish may lift over a coral; a resting one slides round it on the sand.
          if (!still) _steer.y += push * 0.3
        }
      }

      const floor = this.seabed.heightAt(fish.pos.x, fish.pos.z)
      const clearance = fish.pos.y - floor
      if (clearance < 0.6 && !still) _steer.y += (0.6 - clearance) * 8

      const maxAccel = fish.status === 'working' && fish.mode === 'live' ? 18 : 6 + fish.cruise * 2
      if (_steer.lengthSq() > maxAccel * maxAccel) _steer.setLength(maxAccel)
      fish.vel.addScaledVector(_steer, dt)
      const maxSpeed = fish.cruise * 1.25 + 0.2
      if (fish.vel.lengthSq() > maxSpeed * maxSpeed) fish.vel.setLength(maxSpeed)
      fish.vel.multiplyScalar(Math.exp(-(arrived ? 3 : 0.6) * dt))
      if (arrived) {
        fish.vel.x *= Math.exp(-4 * dt)
        fish.vel.z *= Math.exp(-4 * dt)
      }

      fish.last.copy(fish.pos)
      fish.pos.addScaledVector(fish.vel, dt)

      // Hard constraints, counted, and independent of steering: steering should have kept the
      // fish clear, so every correction here is a near miss the metrics want to know about.
      const ground = this.seabed.heightAt(fish.pos.x, fish.pos.z) + 0.22
      if (fish.pos.y < ground) {
        if (ground - fish.pos.y > 0.05) this.stats.groundHits++
        fish.pos.y = ground
        if (fish.vel.y < 0) fish.vel.y = 0
      }
      if (fish.mode !== 'leaving' && fish.mode !== 'arriving') {
        for (const coral of coralList) {
          if (coral.growth < 0.3) continue
          const solid = coral.radius * 0.55
          const top = coral.position.y + coral.height * coral.growth * 0.9
          if (fish.pos.y > top) continue
          const dx = fish.pos.x - coral.position.x
          const dz = fish.pos.z - coral.position.z
          const d = Math.hypot(dx, dz)
          if (d < solid) {
            // More than a centimetre in is a penetration; resting on the edge and being nudged by
            // floating-point noise is a touch. Both are corrected, and counted apart.
            const depth = solid - d
            if (depth > 0.01) {
              this.stats.penetrations++
              const log = (this.stats.penetrationLog ||= [])
              if (log.length < 20) log.push({ status: fish.status, mode: fish.mode, depth: +depth.toFixed(3), speed: +fish.speed.toFixed(2), own: coral === fish.home })
            } else this.stats.touches = (this.stats.touches || 0) + 1
            const nx = d ? dx / d : 1
            const nz = d ? dz / d : 0
            fish.pos.x = coral.position.x + nx * solid
            fish.pos.z = coral.position.z + nz * solid
            // Slide along it rather than stopping dead: drop only the part heading inwards.
            const into = fish.vel.x * nx + fish.vel.z * nz
            if (into < 0) {
              fish.vel.x -= into * nx
              fish.vel.z -= into * nz
            }
          }
        }
      }

      // Locomotion from distance actually covered. Rises at once, so setting off is caught on the
      // frame it happens; falls over about a tenth of a second, so a stroke gets to finish.
      const moved = fish.pos.distanceTo(fish.last) / dt
      if (moved > fish.speed) fish.speed = moved
      else fish.speed += (moved - fish.speed) * Math.min(1, dt / 0.1)
      const sleepy = fish.status === 'sleeping' || fish.status === 'blocked'
      const beat = 2.2 + fish.speed * 5.5
      fish.phase += dt * (sleepy ? beat * 0.4 : beat)
      fish.fin += dt * (3 + fish.speed * 3)
      const ampGoal = sleepy ? 0.12 : Math.min(1.25, 0.22 + fish.speed * 0.38)
      fish.amp += (ampGoal - fish.amp) * Math.min(1, dt * 4)
      if (fish.mode === 'live' && fish.speed < 0.35 && dist < ARRIVE) settled++

      // Where it faces: a hovered fish looks at you, a waiting fish faces you, a fish that saw a
      // neighbour celebrate looks at it, a pausing fish looks about. Otherwise, where it is going.
      fish.lookFor = Math.max(0, fish.lookFor - dt)
      const hx = fish.vel.x
      const hz = fish.vel.z
      const horizontal = Math.hypot(hx, hz)
      const looping = fish.status === 'celebrating' && fish.mode === 'live'
      const slow = fish.speed < 0.6
      let yawGoal = fish.yaw
      const faceCamera = () => Math.atan2(camera.position.x - fish.pos.x, camera.position.z - fish.pos.z)
      if (looping) yawGoal = fish.orbit
      else if (fish.id === this.hoverId && slow) yawGoal = faceCamera()
      else if (fish.status === 'waiting' && fish.mode === 'live' && slow) yawGoal = faceCamera()
      else if (fish.lookFor > 0 && fish.look && slow) yawGoal = Math.atan2(fish.look.x - fish.pos.x, fish.look.z - fish.pos.z)
      else if (fish.pause > 0) yawGoal = fish.pauseYaw + Math.sin(fish.gaze * 1.3) * 0.7
      else if (horizontal > 0.12) yawGoal = Math.atan2(hx, hz)
      const turn = wrapAngle(yawGoal - fish.yaw)
      fish.yaw += turn * Math.min(1, dt * (looping ? 8 : 4))
      const forward = looping ? hx * Math.sin(fish.orbit) + hz * Math.cos(fish.orbit) : horizontal
      let pitchGoal = Math.atan2(fish.vel.y, Math.max(forward, looping ? -99 : 0.05))
      if (!looping) pitchGoal = THREE.MathUtils.clamp(pitchGoal, -0.7, 0.7)
      if (fish.speed < 0.2 && !looping) pitchGoal = 0
      fish.pitch += wrapAngle(pitchGoal - fish.pitch) * Math.min(1, dt * (looping ? 10 : 3))
      const rollGoal = fish.status === 'blocked' && fish.mode === 'live' ? 1.25 : THREE.MathUtils.clamp(-turn * 0.8, -0.5, 0.5)
      fish.roll += (rollGoal - fish.roll) * Math.min(1, dt * 2.5)

      fish.drain += ((fish.status === 'blocked' ? 1 : 0) - fish.drain) * Math.min(1, dt * 1.5)
      fish.glow = Math.max(0, fish.glow - dt * 1.6)
      const selected = fish.id === selectedId ? 0.22 + 0.12 * Math.sin(elapsed * 4) : 0

      // Arrivals fade in leaving the wreck; departures fade into it; filtered fish fade away.
      if (fish.mode === 'leaving') {
        if (fish.pos.distanceTo(this.seabed.wreckMouth) < 1.4) fish.fade -= dt * 1.5
      } else fish.fade = Math.min(1, fish.fade + dt * 1.2)
      const showGoal = !this.filter || this.filter(fish) ? 1 : 0
      fish.shown += (showGoal - fish.shown) * Math.min(1, dt * 5)

      const scale = FISH_SCALE * fish.size * Math.max(0, fish.fade) * fish.shown
      _e.set(-fish.pitch, fish.yaw, fish.roll)
      _q.setFromEuler(_e)
      _s.setScalar(scale)
      _m.compose(fish.pos, _q, _s)
      this.mesh.setMatrixAt(fish.index, _m)
      this.attrs.swim.setXYZW(fish.index, fish.phase, fish.amp, fish.fin, fish.drain)
      this.attrs.glow.setX(fish.index, Math.max(fish.glow, selected))

      // The pebble rides in the mouth of a working fish only.
      if (fish.status === 'working' && fish.mode === 'live' && fish.shown > 0.05) {
        _w.set(0, -0.02, LENGTH * 0.52).multiplyScalar(scale).applyQuaternion(_q).add(fish.pos)
        _s.setScalar(fish.size * fish.shown)
        _m.compose(_w, _q, _s)
      } else _m.makeScale(0, 0, 0)
      this.props.setMatrixAt(fish.index, _m)

      if (fish.mode === 'arriving' && Math.random() < dt * 6) this.effects.burst(fish.pos, 'bubbles', 1)
    }

    for (const fish of list) if (fish.mode === 'leaving' && fish.fade <= 0) this._remove(fish)
    this._separate(list)

    this.mesh.instanceMatrix.needsUpdate = true
    this.props.instanceMatrix.needsUpdate = true
    this.attrs.swim.needsUpdate = true
    this.attrs.glow.needsUpdate = true
    this.stats.settled = settled

    // Closest approach between any two fish, and how many pairs sit closer than half a body,
    // sampled twice a second.
    this._gapClock += dt
    if (this._gapClock > 0.5) {
      this._gapClock = 0
      let gap = Infinity
      const live = list.filter((f) => f.mode !== 'leaving' && f.fade > 0.9)
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const d = live[i].pos.distanceTo(live[j].pos)
          gap = Math.min(gap, d)
          if (d < BODY * 0.5) this.stats.overlaps++
        }
      }
      this.stats.minGap = gap
    }
  }
}

/**
 * Traffic: a shoal of tiny silver fish crossing the reef high up, on no errand at all. It carries
 * no information and is drawn so it can never be mistaken for a thread — a third of the size,
 * all one colour, always together, always above the shelves where no thread's fish swims.
 * One draw for the whole shoal.
 */
export class Shoal {
  constructor(scene, count = 48) {
    this.count = count
    const geo = buildFishGeometry()
    this.attrs = fishAttributes(geo, count)
    const { material } = makeFishMaterial('shoal')
    this.mesh = new THREE.InstancedMesh(geo, material, count)
    this.mesh.frustumCulled = false
    const silver = new THREE.Color(0xc8d8e0)
    const random = rng('shoal')
    this.members = []
    for (let i = 0; i < count; i++) {
      this.mesh.setColorAt(i, silver)
      this.attrs.colorB.setXYZ(i, 0.55, 0.65, 0.75)
      this.attrs.pattern.setXYZ(i, 2, 3, 0)
      this.members.push({
        offset: new THREE.Vector3((random() - 0.5) * 5, (random() - 0.5) * 1.6, (random() - 0.5) * 5),
        phase: random() * 10,
        wobble: random() * Math.PI * 2,
        pos: new THREE.Vector3(),
        yaw: 0,
      })
    }
    this.centre = new THREE.Vector3()
    this.heading = new THREE.Vector3(1, 0, 0)
    this.t = random() * 100
    scene.add(this.mesh)
  }

  setVisible(on) {
    this.mesh.visible = on
  }

  update(dt, elapsed) {
    if (!this.mesh.visible) return
    // A slow figure-of-eight over the whole reef, well above the coral.
    this.t += dt * 0.035
    const t = this.t
    const next = _v.set(Math.sin(t) * 46, 9.5 + Math.sin(t * 2.3) * 1.2, Math.sin(t * 2) * 30)
    this.heading.subVectors(next, this.centre)
    this.centre.copy(next)
    const yaw = Math.atan2(this.heading.x, this.heading.z)
    for (let i = 0; i < this.count; i++) {
      const m = this.members[i]
      m.wobble += dt * 0.7
      _w.copy(m.offset).applyAxisAngle(UP, yaw)
      m.pos.set(this.centre.x + _w.x + Math.sin(m.wobble) * 0.4, this.centre.y + _w.y + Math.cos(m.wobble * 1.3) * 0.25, this.centre.z + _w.z)
      m.phase += dt * 9
      _q.setFromEuler(_e.set(0, yaw + Math.sin(m.wobble) * 0.15, 0))
      _s.setScalar(0.32)
      _m.compose(m.pos, _q, _s)
      this.mesh.setMatrixAt(i, _m)
      this.attrs.swim.setXYZW(i, m.phase, 0.9, m.phase, 0)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.attrs.swim.needsUpdate = true
  }
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// ── geometry ────────────────────────────────────────────────────────────────────────────

/**
 * A reef fish, nose at +Z. `aBody` runs 0 at the nose to 1 at the tip of the tail and is what
 * the swim wave is keyed on; `aFin` says which part a vertex belongs to (0 body, 1 tail,
 * 2 dorsal, 3 pectoral) so the fins can move on their own.
 */
function buildFishGeometry() {
  const RINGS = 22
  const AROUND = 16
  const BODY_END = 0.8
  const positions = []
  const body = []
  const fin = []
  const index = []
  const half = LENGTH / 2
  const zAt = (s) => half - s * LENGTH
  const profile = (s) => {
    const u = s / BODY_END
    const h = u < 0.28 ? Math.sqrt(u / 0.28) : 1 - Math.pow((u - 0.28) / 0.72, 1.5) * 0.82
    return { h: 0.36 * h, w: 0.15 * h + 0.004 }
  }
  for (let i = 0; i <= RINGS; i++) {
    const s = (i / RINGS) * BODY_END
    const { h, w } = profile(s)
    for (let j = 0; j < AROUND; j++) {
      const a = (j / AROUND) * Math.PI * 2
      // A little flatter on the belly than the back.
      const y = Math.cos(a) * h * (Math.cos(a) < 0 ? 0.85 : 1)
      positions.push(Math.sin(a) * w, y, zAt(s))
      body.push(s)
      fin.push(0)
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = i * AROUND + j
      const b = i * AROUND + ((j + 1) % AROUND)
      const c = (i + 1) * AROUND + j
      const d = (i + 1) * AROUND + ((j + 1) % AROUND)
      index.push(a, c, b, b, c, d)
    }
  }
  const bodyGeo = new THREE.BufferGeometry()
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  bodyGeo.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 1))
  bodyGeo.setAttribute('aFin', new THREE.Float32BufferAttribute(fin, 1))
  bodyGeo.setIndex(index)

  // Fins are flat polygons, fanned from a root.
  const fins = []
  const flat = (points, kind) => {
    const p = []
    const b = []
    const f = []
    for (const [x, y, s] of points) {
      p.push(x, y, zAt(s))
      b.push(s)
      f.push(kind)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    g.setAttribute('aBody', new THREE.Float32BufferAttribute(b, 1))
    g.setAttribute('aFin', new THREE.Float32BufferAttribute(f, 1))
    const idx = []
    for (let i = 1; i < points.length - 1; i++) idx.push(0, i, i + 1)
    g.setIndex(idx)
    fins.push(g)
  }
  // Forked tail.
  flat([[0, 0, 0.76], [0, 0.32, 1.02], [0, 0.1, 0.93], [0, 0, 0.9], [0, -0.1, 0.93], [0, -0.32, 1.02]], 1)
  // Dorsal.
  flat([[0, 0.3, 0.28], [0, 0.48, 0.38], [0, 0.4, 0.52], [0, 0.24, 0.62]], 2)
  // Anal fin.
  flat([[0, -0.24, 0.5], [0, -0.36, 0.6], [0, -0.16, 0.68]], 2)
  // Pectorals.
  flat([[0.13, -0.04, 0.24], [0.3, -0.12, 0.36], [0.14, -0.1, 0.34]], 3)
  flat([[-0.13, -0.04, 0.24], [-0.3, -0.12, 0.36], [-0.14, -0.1, 0.34]], 3)

  const geo = BufferGeometryUtils.mergeGeometries([bodyGeo, ...fins], false)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

const FISH_VERTEX_PARS = /* glsl */ `
  attribute float aBody;
  attribute float aFin;
  attribute vec3 aColorB;
  attribute vec3 aPattern;
  attribute vec4 aSwim; // phase, amplitude, fin phase, drain
  attribute float aGlow;
  varying float vBody;
  varying float vFin;
  varying vec3 vLocal;
  varying vec3 vColorB;
  varying vec3 vPattern;
  varying float vDrain;
  varying float vGlow;
`

/**
 * The swim: a wave travelling nose to tail, growing towards the tail, so the head holds its line
 * and the tail does the work. Pectorals flap on their own clock.
 */
const FISH_VERTEX = /* glsl */ `
  {
    float s = aBody;
    float wave = sin(aSwim.x - s * 5.2);
    float reach = 0.035 + s * s * 0.95;
    transformed.x += wave * reach * aSwim.y * 0.2;
    if (aFin > 2.5) {
      float side = sign(position.x);
      float flap = sin(aSwim.z) * 0.5 + 0.2;
      transformed.y += flap * (abs(position.x) - 0.13) * 1.1;
      transformed.z -= (abs(position.x) - 0.13) * 0.3 * (0.5 + 0.5 * sin(aSwim.z));
    }
  }
`

const FISH_FRAGMENT_PARS = /* glsl */ `
  varying float vBody;
  varying float vFin;
  varying vec3 vLocal;
  varying vec3 vColorB;
  varying vec3 vPattern;
  varying float vDrain;
  varying float vGlow;
`

/** Pattern, countershading, eyes, and the drained colour of an errored fish. */
const FISH_FRAGMENT_COLOR = /* glsl */ `
  {
    vec3 a = diffuseColor.rgb;
    vec3 b = vColorB;
    float mask = 0.0;
    float kind = vPattern.x;
    float freq = vPattern.y;
    if (kind < 0.5) {
      // Vertical bands.
      mask = smoothstep(0.42, 0.5, abs(fract(vBody * freq * 1.3 + vPattern.z) - 0.5) * 2.0);
    } else if (kind < 1.5) {
      // Spots.
      vec2 g = vec2(vLocal.z, vLocal.y) * (6.0 + freq * 2.0);
      vec2 cellv = fract(g + vPattern.z * 7.0) - 0.5;
      mask = 1.0 - smoothstep(0.18, 0.26, length(cellv));
    } else if (kind < 2.5) {
      // Two-tone, back to belly.
      mask = smoothstep(-0.02, 0.04, -vLocal.y + sin(vBody * 9.0) * 0.03);
    } else {
      // A saddle and a contrasting tail.
      mask = max(smoothstep(0.7, 0.74, vBody), step(abs(vBody - 0.4), 0.06));
    }
    vec3 col = mix(a, b, mask * 0.9);
    if (vFin > 0.5) col = mix(col, b, 0.35);
    // Countershading: a lighter belly, a darker back.
    col *= mix(1.15, 0.85, smoothstep(-0.25, 0.3, vLocal.y));
    // Eyes, one each side.
    vec2 e = vec2(vLocal.z - 0.38, vLocal.y - 0.07);
    float eyeD = length(e);
    float side = step(0.04, abs(vLocal.x)) * step(vFin, 0.5);
    float white = (1.0 - smoothstep(0.045, 0.055, eyeD)) * side;
    float pupil = (1.0 - smoothstep(0.024, 0.032, eyeD)) * side;
    col = mix(col, vec3(0.95), white);
    col = mix(col, vec3(0.02), pupil);
    // Errored: the colour drains to grey.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l * 0.8), vDrain * 0.85);
    diffuseColor.rgb = col;
  }
`

const FISH_EMISSIVE = /* glsl */ `
  {
    vec2 e = vec2(vLocal.z - 0.38, vLocal.y - 0.07);
    float pupil = (1.0 - smoothstep(0.024, 0.032, length(e))) * step(0.04, abs(vLocal.x)) * step(vFin, 0.5);
    // An errored fish's eyes go red, readable from across the map.
    totalEmissiveRadiance += vec3(1.0, 0.08, 0.05) * pupil * vDrain * 3.0;
    // Fin edges glow faintly after dark.
    totalEmissiveRadiance += vColorB * step(0.5, vFin) * uNight * 0.45;
    // Flash on a merge, and the gentle pulse of the selected fish.
    totalEmissiveRadiance += (diffuseColor.rgb + 0.4) * vGlow * 1.6;
  }
`
