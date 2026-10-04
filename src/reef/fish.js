import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { CELL, hexToWorld } from '../world/layout.js'
import { patchMaterial, rng } from './shading.js'

/**
 * The fish: one per thread, the whole school in a single instanced draw.
 *
 * The swim is done in the vertex shader, upstream of the instance transform — the same seam the
 * skill's baked-skeleton approach uses, and here the "animation" is a travelling wave down the
 * body rather than a sampled clip, so there is nothing to bake. Each instance carries one phase
 * and one amplitude; the CPU only advances those and the instance matrix.
 *
 * What a fish *does* comes from its thread's status. How hard its tail beats comes from how far
 * it actually moved last frame, never from how fast it wanted to go: when separation or a coral
 * refuses the step, intent and motion come apart, and a fish beating flat out against a coral
 * reads as broken.
 */

export const MAX_FISH = 400
const LENGTH = 1.2
const FISH_SCALE = 0.95
const RADIUS = 0.42 * FISH_SCALE
/** Fish come in pairs of colours, chosen per thread. Never gold, never red — those are signals. */
const BODY_COLORS = [0x2f7fd8, 0xf27a3d, 0x3cc4b4, 0xe8e8f0, 0x7b5cd6, 0x2bb3e6, 0xf09ac0, 0x5ad07a, 0x1f3c88, 0xff9f6e]
const PATTERN_COLORS = [0xffffff, 0x14213d, 0xf2f2f2, 0x0b0b1a, 0x7ee8fa, 0xfff1e0]

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler(0, 0, 0, 'YXZ')
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()
const _w = new THREE.Vector3()
const _steer = new THREE.Vector3()
const _desired = new THREE.Vector3()

export class School {
  constructor(scene, seabed, effects) {
    this.scene = scene
    this.seabed = seabed
    this.effects = effects
    this.fish = new Map()
    this.order = []
    this.free = []
    this.used = 0

    const geo = buildFishGeometry()
    this.attrs = {
      colorB: new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 3), 3),
      pattern: new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 3), 3),
      swim: new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH * 4), 4).setUsage(THREE.DynamicDrawUsage),
      glow: new THREE.InstancedBufferAttribute(new Float32Array(MAX_FISH), 1).setUsage(THREE.DynamicDrawUsage),
    }
    geo.setAttribute('aColorB', this.attrs.colorB)
    geo.setAttribute('aPattern', this.attrs.pattern)
    geo.setAttribute('aSwim', this.attrs.swim)
    geo.setAttribute('aGlow', this.attrs.glow)

    const { material, depth } = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.08, side: THREE.DoubleSide }), {
      key: 'fish',
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

    this.stats = { frames: 0, penetrations: 0, groundHits: 0, minGap: Infinity, settled: 0 }
    this._gapClock = 0
  }

  /**
   * Bring the school in line with the roster. `roster` is [{ id, thread, status, home, cells,
   * known }]. Fish missing from it swim back to the wreck.
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
      if (fish.mode === 'leaving') fish.mode = 'live'
      if (fish.status !== r.status) {
        fish.status = r.status
        fish.retarget = 0
      }
    }
    for (const fish of this.fish.values()) {
      if (!seen.has(fish.id) && fish.mode !== 'leaving') {
        fish.mode = 'leaving'
        fish.retarget = 0
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
    const random = rng(r.id)
    const fish = {
      id: r.id,
      index,
      thread: r.thread,
      status: r.status,
      home: r.home,
      cells: r.cells,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      last: new THREE.Vector3(),
      target: new THREE.Vector3(),
      retarget: 0,
      yaw: random() * Math.PI * 2,
      pitch: 0,
      roll: 0,
      speed: 0,
      phase: random() * 10,
      fin: random() * 10,
      amp: 0.3,
      drain: 0,
      glow: 0,
      flash: 0,
      loop: random() * Math.PI * 2,
      orbit: random() * Math.PI * 2,
      fade: 1,
      size: 0.85 + random() * 0.35,
      random,
      mode: r.known ? 'live' : 'arriving',
    }
    if (r.known) {
      // Already on the reef's books: it is simply there, no entrance on every reload.
      const a = random() * Math.PI * 2
      fish.pos.set(r.home.position.x + Math.cos(a) * 2.2, 0, r.home.position.z + Math.sin(a) * 2.2)
      fish.pos.y = this.seabed.heightAt(fish.pos.x, fish.pos.z) + 1 + random()
    } else {
      fish.pos.copy(this.seabed.wreckMouth)
      fish.fade = 0
      this.effects.burst(fish.pos, 'bubbles', 14)
    }
    fish.last.copy(fish.pos)

    const a = new THREE.Color(BODY_COLORS[Math.floor(random() * BODY_COLORS.length)])
    const b = new THREE.Color(PATTERN_COLORS[Math.floor(random() * PATTERN_COLORS.length)])
    this.mesh.setColorAt(index, a)
    this.mesh.instanceColor.needsUpdate = true
    this.attrs.colorB.setXYZ(index, b.r, b.g, b.b)
    this.attrs.pattern.setXYZ(index, Math.floor(random() * 4), 2 + Math.floor(random() * 4), random())
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

  // ── behaviour ─────────────────────────────────────────────────────────────────────────

  /** Pick where this fish wants to be and how fast, from what its thread is doing. */
  _behave(fish, dt, camera, coralList) {
    const home = fish.home.position
    const coral = fish.home
    const ground = (x, z) => this.seabed.heightAt(x, z)
    fish.retarget -= dt
    const random = fish.random
    const reached = fish.pos.distanceTo(fish.target) < 0.5

    if (fish.mode === 'arriving') {
      fish.target.set(home.x + 1.8, ground(home.x, home.z) + 1.8, home.z + 1.2)
      fish.cruise = 2.6
      if (fish.pos.distanceTo(fish.target) < 2) fish.mode = 'live'
      return
    }
    if (fish.mode === 'leaving') {
      fish.target.copy(this.seabed.wreckMouth)
      fish.cruise = 2.8
      return
    }

    switch (fish.status) {
      case 'working': {
        // Tight darting circuits round its own coral, touching down to pick at the sand.
        if (reached || fish.retarget <= 0) {
          fish.orbit += 0.9 + random() * 1.4
          const r = coral.radius + 0.7 + random() * 0.9
          const x = home.x + Math.cos(fish.orbit) * r
          const z = home.z + Math.sin(fish.orbit) * r
          const low = random() < 0.45
          fish.target.set(x, ground(x, z) + (low ? 0.4 : 0.6 + random() * coral.height * 0.8), z)
          fish.retarget = 0.7 + random() * 0.9
          if (reached && fish.pos.y - ground(fish.pos.x, fish.pos.z) < 0.7) {
            _v.set(fish.pos.x, ground(fish.pos.x, fish.pos.z) + 0.05, fish.pos.z)
            this.effects.burst(_v, 'sand', 8)
          }
        }
        fish.cruise = 3.4
        break
      }
      case 'celebrating': {
        // Loops over its coral, with a flash every few seconds.
        fish.loop += dt * 2.1
        const top = home.y + coral.height + 2.2
        const fx = Math.sin(fish.orbit)
        const fz = Math.cos(fish.orbit)
        const r = 1.4
        fish.target.set(home.x + fx * Math.sin(fish.loop + 0.5) * r, top + Math.cos(fish.loop + 0.5) * r, home.z + fz * Math.sin(fish.loop + 0.5) * r)
        fish.cruise = 3.2
        fish.flash -= dt
        if (fish.flash <= 0) {
          fish.flash = 2.6 + random() * 1.6
          fish.glow = 1
          this.effects.burst(fish.pos, 'sparkle', 16)
        }
        break
      }
      case 'waiting': {
        // Up out of the reef, hovering where it can be seen, facing you.
        const bob = Math.sin(performance.now() * 0.0015 + fish.phase) * 0.15
        fish.target.set(home.x, home.y + coral.height + 3.2 + bob, home.z)
        fish.cruise = 1.8
        break
      }
      case 'blocked': {
        // Down by its coral, on its side.
        if (fish.retarget <= 0) {
          const a = fish.orbit
          const r = coral.radius + 0.7
          const x = home.x + Math.cos(a) * r
          const z = home.z + Math.sin(a) * r
          fish.target.set(x, ground(x, z) + 0.32, z)
          fish.retarget = 999
        }
        fish.cruise = 0.9
        break
      }
      case 'sleeping': {
        if (fish.retarget <= 0) {
          const a = fish.orbit + 1.3
          const r = coral.radius + 1.2
          const x = home.x + Math.cos(a) * r
          const z = home.z + Math.sin(a) * r
          fish.target.set(x, ground(x, z) + 0.3, z)
          fish.retarget = 20 + random() * 20
        }
        fish.cruise = 0.45
        break
      }
      default: {
        // Idle: mills about its own shelf.
        if (reached || fish.retarget <= 0) {
          const cell = fish.cells[Math.floor(random() * fish.cells.length)] || { q: 0, r: 0 }
          const c = hexToWorld(cell.q, cell.r)
          const a = random() * Math.PI * 2
          const d = random() * CELL * 0.62
          const x = c.x + Math.cos(a) * d
          const z = c.z + Math.sin(a) * d
          fish.target.set(x, ground(x, z) + 0.9 + random() * 2, z)
          fish.retarget = 5 + random() * 6
        }
        fish.cruise = 1.15
      }
    }
  }

  /**
   * Move a target out of any coral it landed in. Steering avoids corals on the way, but a target
   * inside one is a standing order to crash, and darting fish pick a new one every second.
   */
  _clearOfCorals(target, coralList) {
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
    }
  }

  update(dt, elapsed, camera, corals, selectedId) {
    if (dt <= 0) return
    const list = this.order
    const coralList = corals ? [...corals.entries.values()] : []
    this.stats.frames += list.length
    let settled = 0

    for (const fish of list) {
      this._behave(fish, dt, camera, coralList)
      if (fish.mode === 'live') this._clearOfCorals(fish.target, coralList)

      // Steering: arrive at the target, keep apart from neighbours, keep out of coral and rock.
      _desired.subVectors(fish.target, fish.pos)
      const dist = _desired.length()
      const arrive = Math.min(1, dist / 1.8)
      _desired.multiplyScalar(dist > 1e-4 ? (fish.cruise * arrive) / dist : 0)
      _steer.subVectors(_desired, fish.vel)

      for (const other of list) {
        if (other === fish) continue
        _v.subVectors(fish.pos, other.pos)
        const d2 = _v.lengthSq()
        const keep = RADIUS * 2.4
        if (d2 > keep * keep || d2 < 1e-8) continue
        const d = Math.sqrt(d2)
        _steer.addScaledVector(_v, ((keep - d) / keep) * 6 / d)
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
          _steer.y += push * 0.3
        }
      }

      const floor = this.seabed.heightAt(fish.pos.x, fish.pos.z)
      const clearance = fish.pos.y - floor
      if (clearance < 0.6) _steer.y += (0.6 - clearance) * 8

      const maxAccel = 6 + fish.cruise * 2
      if (_steer.lengthSq() > maxAccel * maxAccel) _steer.setLength(maxAccel)
      fish.vel.addScaledVector(_steer, dt)
      const maxSpeed = fish.cruise * 1.25 + 0.2
      if (fish.vel.lengthSq() > maxSpeed * maxSpeed) fish.vel.setLength(maxSpeed)
      fish.vel.multiplyScalar(Math.exp(-0.6 * dt))

      fish.last.copy(fish.pos)
      fish.pos.addScaledVector(fish.vel, dt)

      // Hard constraints, counted: steering should have kept the fish clear, so every
      // correction here is a near miss the metrics want to know about.
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
            this.stats.penetrations++
            const k = solid / (d || 1e-4)
            fish.pos.x = coral.position.x + dx * k
            fish.pos.z = coral.position.z + dz * k
          }
        }
      }

      // Locomotion from distance actually covered, smoothed so a single corrected step does
      // not twitch the tail.
      const moved = fish.pos.distanceTo(fish.last) / dt
      fish.speed += (moved - fish.speed) * Math.min(1, dt * 6)
      const sleepy = fish.status === 'sleeping' || fish.status === 'blocked'
      const beat = 2.2 + fish.speed * 5.5
      fish.phase += dt * (sleepy ? beat * 0.4 : beat)
      fish.fin += dt * (3 + fish.speed * 3)
      const ampGoal = sleepy ? 0.12 : Math.min(1.25, 0.22 + fish.speed * 0.38)
      fish.amp += (ampGoal - fish.amp) * Math.min(1, dt * 4)
      if (fish.speed < 0.35 && dist < 0.8) settled++

      // Heading follows actual motion. A loop is ridden in its own vertical plane, so the
      // heading is held and only the pitch turns over.
      const hx = fish.vel.x
      const hz = fish.vel.z
      const horizontal = Math.hypot(hx, hz)
      const looping = fish.status === 'celebrating' && fish.mode === 'live'
      let yawGoal = fish.yaw
      if (looping) yawGoal = fish.orbit
      else if (fish.status === 'waiting' && fish.mode === 'live' && fish.speed < 0.6) {
        yawGoal = Math.atan2(camera.position.x - fish.pos.x, camera.position.z - fish.pos.z)
      } else if (horizontal > 0.12) yawGoal = Math.atan2(hx, hz)
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

      // Arrivals fade in leaving the wreck; departures fade into it.
      if (fish.mode === 'leaving') {
        if (fish.pos.distanceTo(this.seabed.wreckMouth) < 1.4) fish.fade -= dt * 1.5
      } else fish.fade = Math.min(1, fish.fade + dt * 1.2)

      const scale = FISH_SCALE * fish.size * Math.max(0, fish.fade)
      _e.set(-fish.pitch, fish.yaw, fish.roll)
      _q.setFromEuler(_e)
      _s.setScalar(scale)
      _m.compose(fish.pos, _q, _s)
      this.mesh.setMatrixAt(fish.index, _m)
      this.attrs.swim.setXYZW(fish.index, fish.phase, fish.amp, fish.fin, fish.drain)
      this.attrs.glow.setX(fish.index, Math.max(fish.glow, selected))

      // The pebble rides in the mouth of a working fish only.
      if (fish.status === 'working' && fish.mode === 'live') {
        _w.set(0, -0.02, LENGTH * 0.52).multiplyScalar(scale).applyQuaternion(_q).add(fish.pos)
        _s.setScalar(fish.size)
        _m.compose(_w, _q, _s)
      } else _m.makeScale(0, 0, 0)
      this.props.setMatrixAt(fish.index, _m)

      if (fish.mode === 'arriving' && Math.random() < dt * 6) this.effects.burst(fish.pos, 'bubbles', 1)
    }

    for (const fish of list) if (fish.mode === 'leaving' && fish.fade <= 0) this._remove(fish)

    this.mesh.instanceMatrix.needsUpdate = true
    this.props.instanceMatrix.needsUpdate = true
    this.attrs.swim.needsUpdate = true
    this.attrs.glow.needsUpdate = true
    this.stats.settled = settled

    // Closest approach between any two fish, sampled twice a second.
    this._gapClock += dt
    if (this._gapClock > 0.5) {
      this._gapClock = 0
      let gap = Infinity
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) gap = Math.min(gap, list[i].pos.distanceTo(list[j].pos))
      }
      this.stats.minGap = gap
    }
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
