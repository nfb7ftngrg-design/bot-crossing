import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { Navigation } from '../agents/navigation.js'
import { patchLab, rng } from './look.js'
import { roomCentre, HALF, DESK_SIZE, kindAt } from './floorplan.js'

/**
 * The staff: one person per thread, the whole floor in a single instanced draw.
 *
 * Each person is built from a dozen boxes, and the skeleton lives in the vertex shader — every
 * vertex knows which body part it belongs to, and each part turns about its joint before the
 * instance transform places the person. That is the seam the skill names for crowds (skinning
 * upstream of the instance matrix); there is no skeleton on the CPU at all. A pose is a set of
 * joint angles chosen by number, two poses are blended while one turns into the next, and the
 * walk cycle is driven by distance actually covered, so feet never slide.
 *
 * Where people go comes from what their thread is doing, routed through doorways by A* on a grid
 * of the floor, with every step also checked against the walls — routing can fail, walking
 * through a wall must not be what happens when it does.
 */

export const MAX_PEOPLE = 400
export const POSE = { stand: 0, walk: 1, sit: 2, type: 3, wave: 4, slump: 5, cheer: 6, sleep: 7, talk: 8 }
/** Shoulder width plus a little: people keep this far apart, centre to centre. */
export const BODY = 0.62
/** Close enough to a spot that is crowded by somebody already standing in it. */
export const ARRIVE = BODY * 1.2
const SEAT_SNAP = 0.35
const GIVE_UP = 3

/** What each person is doing, in plain words, for the card. */
export const DOING = {
  working: 'At their workstation, typing — the thread is running right now.',
  waiting: 'Standing at their desk, waving you over — the thread has replied and needs you.',
  blocked: 'Slumped at their desk, head in hands, a red screen — the thread stopped on an error.',
  celebrating: 'On their feet cheering, confetti in the air — the thread’s pull request merged.',
  sleeping: 'Asleep at their desk, screen dark — nothing has happened in this thread for three days.',
  idle: 'Off their desk — pottering about the department, or on a coffee break. Nothing needs you.',
  arriving: 'Just out of the elevator and through security, heading to their desk — a new thread.',
  leaving: 'Clearing out and heading for the elevator — the thread was archived.',
}

// Agency dress: dark suits, lab coats, shirtsleeves, the odd windbreaker. Never gold, never red.
// Whites are off-white on purpose: true white under the ceiling lights clears the bloom threshold.
const SHIRTS = [0x26303d, 0x1e2733, 0xbdbdb6, 0xb3bac3, 0x6a7f99, 0x3d4f3a, 0x4a3b2e, 0x2f2f36, 0x8aa0b8, 0x5c4b6e]
const PANTS = [0x1c2129, 0x2a2f38, 0x3b3f46, 0x463c32, 0x232a33]
const SKIN = [0xf1c9a5, 0xe0ac86, 0xc68b62, 0x9a6440, 0x6e4529, 0xf5d3b8]
const HAIR = [0x1b1612, 0x3b2a1e, 0x6b4a2b, 0xb38b5a, 0x8a8a8a, 0x2c2420, 0xd8c39a]

/** How a person looks, from their thread id alone — the same person every time. Pure. */
export function personLook(id) {
  const r = rng(`person:${id}`)
  return {
    shirt: SHIRTS[Math.floor(r() * SHIRTS.length)],
    pants: PANTS[Math.floor(r() * PANTS.length)],
    skin: SKIN[Math.floor(r() * SKIN.length)],
    hair: HAIR[Math.floor(r() * HAIR.length)],
    height: 0.94 + r() * 0.12,
    pace: 0.85 + r() * 0.35,
    linger: 0.7 + r() * 0.8,
    phase: r() * 10,
    random: r,
  }
}

// ── the body ──────────────────────────────────────────────────────────────────────────

const MAT = { skin: 0, shirt: 1, pants: 2, shoe: 3, hair: 4, badge: 5, headset: 6, cup: 7, folder: 8 }
const PART = { pelvis: 0, torso: 1, head: 2, upperL: 3, foreL: 4, upperR: 5, foreR: 6, thighL: 7, shinL: 8, thighR: 9, shinR: 10 }

function bit(geo, part, mat, x, y, z) {
  geo = geo.index ? geo.toNonIndexed() : geo
  geo.translate(x, y, z)
  const n = geo.attributes.position.count
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1))
  geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(mat), 1))
  if (geo.attributes.uv) geo.deleteAttribute('uv')
  return geo
}
const B = (w, h, d) => new THREE.BoxGeometry(w, h, d)

function buildBody() {
  const p = []
  // Legs: hip joints at y 0.92, knees at 0.48. Shoes at the bottom of the shins.
  for (const [side, thigh, shin] of [[-1, PART.thighL, PART.shinL], [1, PART.thighR, PART.shinR]]) {
    p.push(bit(B(0.15, 0.44, 0.16), thigh, MAT.pants, side * 0.1, 0.7, 0))
    p.push(bit(B(0.13, 0.42, 0.14), shin, MAT.pants, side * 0.1, 0.27, 0))
    p.push(bit(B(0.13, 0.07, 0.26), shin, MAT.shoe, side * 0.1, 0.035, 0.05))
  }
  p.push(bit(B(0.36, 0.18, 0.22), PART.pelvis, MAT.pants, 0, 0.95, 0))
  // Torso: pivots at the hips, so leaning tips the whole upper body.
  p.push(bit(B(0.42, 0.54, 0.24), PART.torso, MAT.shirt, 0, 1.28, 0))
  p.push(bit(B(0.08, 0.1, 0.012), PART.torso, MAT.badge, -0.1, 1.33, 0.126))
  p.push(bit(B(0.06, 0.24, 0.012), PART.torso, MAT.hair, 0, 1.36, 0.124)) // the tie, darkest thing on the shirt
  // Head on a neck.
  p.push(bit(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8), PART.head, MAT.skin, 0, 1.58, 0))
  p.push(bit(B(0.2, 0.24, 0.22), PART.head, MAT.skin, 0, 1.72, 0))
  p.push(bit(B(0.22, 0.09, 0.24), PART.head, MAT.hair, 0, 1.85, -0.01))
  p.push(bit(B(0.22, 0.16, 0.06), PART.head, MAT.hair, 0, 1.76, -0.11))
  // A headset, worn while working.
  p.push(bit(B(0.24, 0.025, 0.04), PART.head, MAT.headset, 0, 1.88, 0))
  p.push(bit(B(0.04, 0.09, 0.08), PART.head, MAT.headset, 0.12, 1.74, 0))
  p.push(bit(B(0.02, 0.02, 0.12), PART.head, MAT.headset, 0.11, 1.68, 0.08))
  // Arms: shoulders at y 1.5, elbows at 1.22, hands below.
  for (const [side, upper, fore] of [[-1, PART.upperL, PART.foreL], [1, PART.upperR, PART.foreR]]) {
    p.push(bit(B(0.11, 0.3, 0.12), upper, MAT.shirt, side * 0.27, 1.36, 0))
    p.push(bit(B(0.1, 0.26, 0.11), fore, MAT.shirt, side * 0.27, 1.08, 0))
    p.push(bit(B(0.08, 0.1, 0.09), fore, MAT.skin, side * 0.27, 0.9, 0))
  }
  // A coffee cup in the right hand, and a case folder under the left arm — shown when they apply.
  p.push(bit(new THREE.CylinderGeometry(0.04, 0.035, 0.1, 8), PART.foreR, MAT.cup, 0.27, 0.9, 0.08))
  p.push(bit(B(0.03, 0.3, 0.24), PART.foreL, MAT.folder, -0.33, 1.05, 0.04))
  const geo = BufferGeometryUtils.mergeGeometries(p, false)
  geo.computeVertexNormals()
  return geo
}

/**
 * The rig. Each pose is a set of joint angles (radians); `rig()` turns one vertex of one body
 * part through its own joint and then each parent's, for the two poses being blended.
 */
const RIG_GLSL = /* glsl */ `
  attribute float aPart;
  attribute float aMat;
  attribute vec4 aPose;   // pose A, pose B, blend A over B, phase
  attribute vec4 aMisc;   // head yaw, props (headset 1, cup 2, folder 4 as bits), height scale, highlight

  struct Pose { float lean; float headP; float shLx; float shLz; float elL; float shRx; float shRz; float elR; float thL; float knL; float thR; float knR; float drop; };

  Pose pose(float id, float ph) {
    Pose p = Pose(0.0, 0.0, 0.0, -0.06, -0.1, 0.0, 0.06, -0.1, 0.0, 0.0, 0.0, 0.0, 0.0);
    float s = sin(ph);
    if (id < 0.5) { // stand
      p.lean = sin(ph * 0.3) * 0.015;
    } else if (id < 1.5) { // walk
      p.thL = s * 0.55; p.thR = -s * 0.55;
      p.knL = max(0.0, -s) * 0.9; p.knR = max(0.0, s) * 0.9;
      p.shLx = -s * 0.45; p.shRx = s * 0.45; p.elL = -0.25; p.elR = -0.25;
      p.lean = 0.05;
    } else if (id < 4.5 && id > 3.5) { // wave: on their feet, right arm up and waving
      p.shRz = 2.6 + sin(ph * 2.5) * 0.25; p.elR = -0.2 - (0.5 + 0.5 * sin(ph * 5.0)) * 0.5;
      p.shRx = 0.0;
    } else if (id > 5.5 && id < 6.5) { // cheer: both arms up, bouncing
      p.shLz = -2.8; p.shRz = 2.8; p.elL = -0.2; p.elR = -0.2;
      float hop = abs(sin(ph * 3.0));
      p.drop = hop * 0.22; p.knL = (1.0 - hop) * 0.35; p.knR = (1.0 - hop) * 0.35;
    } else if (id > 7.5) { // talk: standing, one hand making a point
      p.shRx = -0.55 + sin(ph * 2.2) * 0.15; p.elR = -1.1 + sin(ph * 3.1) * 0.2;
      p.headP = sin(ph * 0.9) * 0.08;
    } else { // the seated family: sit, type, slump, sleep
      p.thL = -1.57; p.thR = -1.57; p.knL = 1.57; p.knR = 1.57; p.drop = -0.45;
      if (id > 2.5 && id < 3.5) { // typing
        p.shLx = -0.6; p.shRx = -0.6; p.shLz = 0.0; p.shRz = 0.0;
        p.elL = -1.0 + sin(ph * 14.0) * 0.07; p.elR = -1.0 + sin(ph * 14.0 + 1.7) * 0.07;
        p.headP = 0.05;
      } else if (id > 4.5 && id < 5.5) { // slumped, head in hands
        p.lean = 0.5; p.headP = 0.45;
        p.shLx = -2.4; p.shRx = -2.4; p.elL = -2.0; p.elR = -2.0; p.shLz = 0.25; p.shRz = -0.25;
      } else if (id > 6.5) { // asleep on the desk
        p.lean = 0.95 + sin(ph * 0.4) * 0.02; p.headP = 0.25;
        p.shLx = -1.45; p.shRx = -1.45; p.elL = -1.5; p.elR = -1.5;
      }
    }
    return p;
  }

  Pose mixPose(Pose a, Pose b, float t) {
    return Pose(mix(b.lean, a.lean, t), mix(b.headP, a.headP, t), mix(b.shLx, a.shLx, t), mix(b.shLz, a.shLz, t), mix(b.elL, a.elL, t),
      mix(b.shRx, a.shRx, t), mix(b.shRz, a.shRz, t), mix(b.elR, a.elR, t), mix(b.thL, a.thL, t), mix(b.knL, a.knL, t),
      mix(b.thR, a.thR, t), mix(b.knR, a.knR, t), mix(b.drop, a.drop, t));
  }

  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }

  void turn(inout vec3 p, inout vec3 n, vec3 pivot, mat3 r) { p = r * (p - pivot) + pivot; n = r * n; }

  void rig(inout vec3 p, inout vec3 n) {
    Pose q = mixPose(pose(aPose.x, aPose.w), pose(aPose.y, aPose.w), aPose.z);
    float part = aPart;
    // Props that are not in use fold away to nothing.
    float props = aMisc.y;
    if (aMat > 5.5 && aMat < 6.5 && mod(props, 2.0) < 0.5) p *= 0.0;
    if (aMat > 6.5 && aMat < 7.5 && mod(floor(props / 2.0), 2.0) < 0.5) p *= 0.0;
    if (aMat > 7.5 && mod(floor(props / 4.0), 2.0) < 0.5) p *= 0.0;
    if (p == vec3(0.0)) return;
    vec3 hip = vec3(0.0, 0.98, 0.0);
    if (part > 6.5) {
      // Legs: knee, then hip. The torso's lean does not move them.
      bool left = part < 8.5;
      float th = left ? q.thL : q.thR;
      float kn = left ? q.knL : q.knR;
      float side = left ? -0.1 : 0.1;
      if (part > 7.5 && part < 8.5 || part > 9.5) turn(p, n, vec3(side, 0.48, 0.0), rotX(kn));
      turn(p, n, vec3(side, 0.92, 0.0), rotX(th));
    } else if (part > 0.5) {
      if (part > 2.5) {
        // Arms: elbow, then shoulder.
        bool left = part < 4.5;
        float side = left ? -0.27 : 0.27;
        if (part > 3.5 && part < 4.5 || part > 5.5) turn(p, n, vec3(side, 1.22, 0.0), rotX(left ? q.elL : q.elR));
        turn(p, n, vec3(side, 1.5, 0.0), rotX(left ? q.shLx : q.shRx) * rotZ(left ? q.shLz : q.shRz));
      } else if (part > 1.5) {
        // Head: nod, then turn.
        turn(p, n, vec3(0.0, 1.56, 0.0), rotY(aMisc.x) * rotX(q.headP));
      }
      // Everything above the hips leans with the torso.
      turn(p, n, hip, rotX(q.lean));
    }
    p.y += q.drop;
    p *= aMisc.z;
  }
`

export class Staff {
  constructor(scene, facility, effects) {
    this.scene = scene
    this.facility = facility
    this.effects = effects
    this.people = new Map()
    this.order = []
    this.free = []
    this.used = 0
    this.hoverId = null
    this.filter = null
    this.nav = null
    this.plan = null

    const geo = buildBody()
    const make = (n, size) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEOPLE * size), size).setUsage(THREE.DynamicDrawUsage)
    this.attrs = { shirt: make(0, 3), pants: make(0, 3), skin: make(0, 3), hair: make(0, 3), pose: make(0, 4), misc: make(0, 4) }
    geo.setAttribute('aShirt', this.attrs.shirt)
    geo.setAttribute('aPants', this.attrs.pants)
    geo.setAttribute('aSkin', this.attrs.skin)
    geo.setAttribute('aHair', this.attrs.hair)
    geo.setAttribute('aPose', this.attrs.pose)
    geo.setAttribute('aMisc', this.attrs.misc)

    const { material, depth } = patchLab(new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 }), {
      key: 'people',
      vertexPars: `${RIG_GLSL}
        attribute vec3 aShirt; attribute vec3 aPants; attribute vec3 aSkin; attribute vec3 aHair;
        varying vec3 vBody; varying float vGlow; varying float vMat;
        vec3 _rn = vec3(0.0, 1.0, 0.0);`,
      normal: /* glsl */ `{ vec3 tmp = position; rig(tmp, objectNormal); }`,
      vertex: /* glsl */ `{ vec3 tmpN = vec3(0.0, 1.0, 0.0); rig(transformed, tmpN); }`,
      fragmentPars: /* glsl */ `varying vec3 vBody; varying float vGlow; varying float vMat;`,
      fragmentColor: /* glsl */ `diffuseColor.rgb = vBody;`,
      // The selected person gets a soft cool tint, the same whatever they wear.
      emissive: /* glsl */ `totalEmissiveRadiance += vec3(0.25, 0.45, 0.7) * vGlow;`,
    })
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader) => {
      previous(shader)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vMat = aMat; vGlow = aMisc.w;
        vBody = aMat < 0.5 ? aSkin : aMat < 1.5 ? aShirt : aMat < 2.5 ? aPants : aMat < 3.5 ? vec3(0.06, 0.06, 0.07)
          : aMat < 4.5 ? aHair : aMat < 5.5 ? vec3(0.78, 0.8, 0.82) : aMat < 6.5 ? vec3(0.08, 0.08, 0.09)
          : aMat < 7.5 ? vec3(0.8, 0.79, 0.75) : vec3(0.7, 0.57, 0.34);`
      )
    }
    this.mesh = new THREE.InstancedMesh(geo, material, MAX_PEOPLE)
    this.mesh.customDepthMaterial = depth
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    this.stats = { frames: 0, wallHits: 0, overlaps: 0, minGap: Infinity, paths: 0, pathFails: 0, gaveUp: 0, pushes: 0, seated: 0, legs: 0, flashes: 0 }
    this._gapClock = 0
  }

  // ── navigation ────────────────────────────────────────────────────────────────────────

  /** Rasterise the floor: walls, furniture, desks. Everything outside the plan is bedrock. */
  rebuildNav(plan, rects) {
    this.plan = plan
    const b = plan.bounds
    const half = Math.ceil(Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ))) + 2
    if (!this.nav || this.nav.half !== half) this.nav = new Navigation({ cell: 0.25, half, maxExpansions: 160000 })
    const nav = this.nav
    nav.rebuild([])
    nav.blocked.fill(1)
    // Open every square that is part of the plan…
    for (const c of plan.all.values()) {
      const { x, z } = roomCentre(c)
      this._fill(x - HALF, z - HALF, x + HALF, z + HALF, 0)
    }
    // …then close everything that stands on it.
    for (const r of rects) this._fill(r.x0, r.z0, r.x1, r.z1, 1)
    nav.version++
    this.navRects = rects
    for (const p of this.order) p.path = null
  }

  _fill(x0, z0, x1, z1, v) {
    const nav = this.nav
    const i0 = Math.max(0, nav.toCell(x0))
    const i1 = Math.min(nav.size - 1, nav.toCell(x1))
    const j0 = Math.max(0, nav.toCell(z0))
    const j1 = Math.min(nav.size - 1, nav.toCell(z1))
    for (let j = j0; j <= j1; j++) {
      const wz = nav.toWorld(j)
      if (wz < z0 || wz > z1) continue
      for (let i = i0; i <= i1; i++) {
        const wx = nav.toWorld(i)
        if (wx < x0 || wx > x1) continue
        nav.blocked[j * nav.size + i] = v
      }
    }
  }

  /** True if a point is inside a wall or a piece of furniture — what the metrics count. */
  insideSolid(x, z) {
    return this.nav ? this.nav.isBlocked(x, z) : false
  }

  // ── roster ────────────────────────────────────────────────────────────────────────────

  /** `roster` is [{ id, thread, status, desk: {x, z, chair, room}, project, known, onCase }]. */
  setRoster(roster) {
    const seen = new Set()
    for (const r of roster) {
      seen.add(r.id)
      let p = this.people.get(r.id)
      if (!p) p = this._spawn(r)
      if (!p) continue
      p.thread = r.thread
      p.desk = r.desk
      p.project = r.project
      p.onCase = r.onCase
      if (p.mode === 'leaving') p.mode = 'live'
      if (p.status !== r.status) {
        p.status = r.status
        p.goal = null
        p.path = null
        p.pause = 0
      }
    }
    for (const p of this.people.values()) {
      if (!seen.has(p.id) && p.mode !== 'leaving') {
        p.mode = 'leaving'
        p.goal = null
        p.path = null
        p.seated = false
        p.leaveTries = 0
      }
    }
  }

  _spawn(r) {
    const index = this.free.length ? this.free.pop() : this.used++
    if (index >= MAX_PEOPLE) {
      this.used = MAX_PEOPLE
      return null
    }
    const look = personLook(r.id)
    const p = {
      id: r.id,
      index,
      thread: r.thread,
      status: r.status,
      desk: r.desk,
      project: r.project,
      onCase: r.onCase,
      pos: new THREE.Vector3(),
      last: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      yaw: Math.PI,
      speed: 0,
      stride: look.phase,
      phase: look.phase,
      poseA: POSE.stand,
      poseB: POSE.stand,
      blend: 1,
      headYaw: 0,
      goal: null,
      path: null,
      pause: 0,
      paused: false,
      seated: false,
      best: Infinity,
      stuck: 0,
      fade: 1,
      shown: 1,
      flash: 0,
      look,
      mode: r.known ? 'live' : 'arriving',
      checkpointed: r.known,
    }
    const set = (attr, hex) => {
      const c = new THREE.Color(hex)
      attr.setXYZ(index, c.r, c.g, c.b)
      attr.needsUpdate = true
    }
    set(this.attrs.shirt, look.shirt)
    set(this.attrs.pants, look.pants)
    set(this.attrs.skin, look.skin)
    set(this.attrs.hair, look.hair)
    p.color = new THREE.Color(look.shirt)

    if (r.known) {
      // Already on the books: already at work, no entrance on every reload.
      p.pos.set(r.desk.chair.x, 0, r.desk.chair.z)
    } else {
      const e = this.plan.points.elevator
      p.pos.set(e.x, 0, e.z)
      p.fade = 0
      this.facility.ring()
    }
    p.last.copy(p.pos)
    this.people.set(r.id, p)
    this._rebuildOrder()
    return p
  }

  _remove(p) {
    this.people.delete(p.id)
    this.free.push(p.index)
    const m = new THREE.Matrix4().makeScale(0, 0, 0)
    this.mesh.setMatrixAt(p.index, m)
    this._rebuildOrder()
  }

  _rebuildOrder() {
    this.order = [...this.people.values()]
    this.mesh.count = this.used
  }

  get(id) {
    return this.people.get(id)
  }

  isShown(p) {
    return p.mode !== 'leaving' && (!this.filter || this.filter(p))
  }

  // ── behaviour ─────────────────────────────────────────────────────────────────────────

  /** A random walkable point inside one of this person's rooms. */
  _wanderPoint(p) {
    const room = p.desk.room
    const c = roomCentre(room)
    for (let i = 0; i < 12; i++) {
      const x = c.x + (p.look.random() - 0.5) * (HALF * 2 - 2)
      const z = c.z + (p.look.random() - 0.5) * (HALF * 2 - 2)
      if (!this.nav.isBlocked(x, z)) return { x, z }
    }
    return { x: p.desk.chair.x, z: p.desk.chair.z + 1 }
  }

  /** Decide where this person is headed, from what their thread is doing. */
  _goalFor(p) {
    const d = p.desk
    if (p.mode === 'leaving') return { x: this.plan.points.elevator.x, z: this.plan.points.elevator.z, kind: 'elevator' }
    if (p.mode === 'arriving' && !p.checkpointed) return { ...this.plan.points.checkpoint, kind: 'checkpoint' }
    switch (p.status) {
      case 'working':
      case 'blocked':
      case 'sleeping':
        return { x: d.chair.x, z: d.chair.z, kind: 'seat' }
      case 'waiting':
        return { x: d.x + DESK_SIZE.w / 2 + 0.45, z: d.z + 0.55, kind: 'stand' }
      case 'celebrating':
        return { x: d.x - DESK_SIZE.w / 2 - 0.45, z: d.z + 0.55, kind: 'stand' }
      default: {
        // Idle: a leg about the department, or now and then a trip to the break room.
        const r = p.look.random()
        if (r < 0.28) {
          const cups = this.plan.points.coffee
          const c = cups[Math.floor(p.look.random() * cups.length)]
          return { x: c.x + (p.look.random() - 0.5) * 0.8, z: c.z + (p.look.random() - 0.5) * 0.6, kind: 'coffee' }
        }
        return { ...this._wanderPoint(p), kind: 'wander' }
      }
    }
  }

  _route(p) {
    const g = p.goal
    const path = this.nav.findPath(p.pos.x, p.pos.z, g.x, g.z)
    this.stats.paths++
    if (!path || !path.length) {
      this.stats.pathFails++
      p.path = [{ x: g.x, z: g.z }]
    } else p.path = path
    p.best = Infinity
    p.stuck = 0
  }

  update(dt, elapsed, camera, selectedId) {
    if (dt <= 0 || !this.nav) return
    const list = this.order
    this.stats.frames += list.length
    let seated = 0

    for (const p of list) {
      // ── where to ──
      if (!p.goal && !(p.pause > 0)) {
        p.goal = this._goalFor(p)
        p.path = null
        p.seated = false
        p.arrived = false
        if (p.goal.kind === 'wander' || p.goal.kind === 'coffee') this.stats.legs++
      }
      if (p.pause > 0) {
        p.pause -= dt
        if (p.pause <= 0) {
          p.goal = null
          p.pause = 0
        }
      }
      if (p.goal && !p.path && !p.seated) this._route(p)

      // ── steer along the path ──
      const target = p.path?.[0]
      let want = 0
      let dirX = 0
      let dirZ = 0
      const pace = p.mode === 'leaving' || p.mode === 'arriving' ? 1.35 : p.status === 'idle' ? 0.95 * p.look.pace : 1.25
      if (target && !p.seated && !(p.pause > 0)) {
        const dx = target.x - p.pos.x
        const dz = target.z - p.pos.z
        const dist = Math.hypot(dx, dz)
        const last = p.path.length === 1
        if (dist < (last ? 0.12 : 0.35)) {
          p.path.shift()
          // Each new waypoint is a new leg: progress is measured afresh.
          p.best = Infinity
          p.stuck = 0
          if (!p.path.length) this._arrive(p)
        } else {
          dirX = dx / dist
          dirZ = dz / dist
          want = last ? Math.min(pace, dist * 2.5 + 0.2) : pace
        }
        // Progress: a person who stops getting closer for a few seconds gives up on this leg.
        const remaining = dist + (p.path.length > 1 ? 1 : 0)
        if (remaining < p.best - 0.05) {
          p.best = remaining
          p.stuck = 0
        } else if ((p.stuck += dt) > GIVE_UP) {
          this.stats.gaveUp++
          p.gaveUp = (p.gaveUp || 0) + 1
          p.stuck = 0
          // A spot somebody else is standing in: finish arriving where they got to. A wander:
          // pick another. Anything else: route again from here.
          if (p.mode === 'leaving') p.leaveTries = (p.leaveTries || 0) + 1
          if (p.goal && Math.hypot(p.goal.x - p.pos.x, p.goal.z - p.pos.z) < ARRIVE * 2) this._arrive(p)
          else if (p.goal?.kind === 'wander' || p.goal?.kind === 'coffee') p.goal = null
          else p.path = null
        }
      }

      // Separation from everyone standing or walking near.
      let sx = 0
      let sz = 0
      if (!p.seated) {
        for (const o of list) {
          if (o === p || o.mode === 'leaving' && o.fade < 0.5) continue
          const ox = p.pos.x - o.pos.x
          const oz = p.pos.z - o.pos.z
          const d2 = ox * ox + oz * oz
          if (d2 > BODY * BODY * 1.6 || d2 < 1e-8) continue
          const d = Math.sqrt(d2)
          const push = (BODY * 1.26 - d) / (BODY * 1.26)
          sx += (ox / d) * push * 2.2
          sz += (oz / d) * push * 2.2
        }
      }

      // Velocity, eased a little so turns are not instant, then every step checked against walls.
      const vx = dirX * want + sx
      const vz = dirZ * want + sz
      const k = Math.min(1, dt * 10)
      p.vel.x += (vx - p.vel.x) * k
      p.vel.z += (vz - p.vel.z) * k
      p.last.copy(p.pos)
      if (!p.seated) {
        this.nav.slide(p.pos, p.vel.x * dt, p.vel.z * dt)
        if (this.insideSolid(p.pos.x, p.pos.z)) this.stats.wallHits++
      }

      // ── body ──
      const moved = Math.hypot(p.pos.x - p.last.x, p.pos.z - p.last.z)
      const speed = moved / dt
      if (speed > p.speed) p.speed = speed
      else p.speed += (speed - p.speed) * Math.min(1, dt / 0.1)
      // The walk cycle advances by distance covered: a stride per ~1.3 m, so feet never slide.
      p.stride += moved * 4.8
      if (p.seated) seated++

      const walking = p.speed > 0.18 && !p.seated
      let pose = POSE.stand
      if (walking) pose = POSE.walk
      else if (p.seated) pose = p.status === 'working' ? POSE.type : p.status === 'blocked' ? POSE.slump : p.status === 'sleeping' ? POSE.sleep : POSE.sit
      else if (p.mode === 'live' && p.goal?.kind === 'stand' && p.arrived) pose = p.status === 'waiting' ? POSE.wave : p.status === 'celebrating' ? POSE.cheer : POSE.stand
      else if (p.pause > 0 && p.goal?.kind === 'coffee') pose = POSE.talk
      if (pose !== p.poseA) {
        p.poseB = p.blend > 0.5 ? p.poseA : p.poseB
        p.poseA = pose
        p.blend = 0
      }
      p.blend = Math.min(1, p.blend + dt / 0.35)
      p.phase += dt * (pose === POSE.walk ? 0 : 1)
      const phase = pose === POSE.walk ? p.stride : p.phase

      // Facing: along the walk; at the desk towards the screen; waiting and hovered, at you.
      const faceCam = Math.atan2(camera.position.x - p.pos.x, camera.position.z - p.pos.z)
      let yawGoal = p.yaw
      if (walking && Math.hypot(p.vel.x, p.vel.z) > 0.1) yawGoal = Math.atan2(p.vel.x, p.vel.z)
      else if (p.seated) yawGoal = Math.PI // desks face north (−z)
      else if (pose === POSE.wave || (p.id === this.hoverId && !p.seated)) yawGoal = faceCam
      else if (p.lookAt && p.lookFor > 0) yawGoal = Math.atan2(p.lookAt.x - p.pos.x, p.lookAt.z - p.pos.z)
      p.yaw += wrap(yawGoal - p.yaw) * Math.min(1, dt * 7)
      // A seated person who is hovered turns their head, not their chair.
      p.headYaw += ((p.seated && p.id === this.hoverId ? THREE.MathUtils.clamp(wrap(faceCam - p.yaw), -1.1, 1.1) : 0) - p.headYaw) * Math.min(1, dt * 5)
      p.lookFor = Math.max(0, (p.lookFor || 0) - dt)

      // Celebration: confetti now and then, and the people around turn to look.
      if (p.status === 'celebrating' && pose === POSE.cheer) {
        p.flash -= dt
        if (p.flash <= 0) {
          p.flash = 2.4 + p.look.random() * 1.6
          this.stats.flashes++
          this.effects.burst(new THREE.Vector3(p.pos.x, 2.2, p.pos.z), 'confetti', 26)
          for (const o of list) {
            if (o === p || o.seated || o.mode !== 'live' || o.pos.distanceTo(p.pos) > 8) continue
            o.lookAt = p.pos
            o.lookFor = 2
          }
        }
      }
      // Steam off the cup of a working person's coffee, now and then: work leaves traces.
      if (p.status === 'working' && p.seated && Math.random() < dt * 0.6) {
        this.effects.burst(new THREE.Vector3(p.desk.x + 0.5, 0.92, p.desk.z + 0.12), 'steam', 1)
      }

      // Fades: out of the elevator, back into it, filtered away.
      if (p.mode === 'leaving') {
        // Out through the elevator — or, when the way there is gone (their department's rooms
        // closed under them) or keeps being blocked, out of sight where they stand.
        const atLift = Math.hypot(p.pos.x - this.plan.points.elevator.x, p.pos.z - this.plan.points.elevator.z) < 0.6
        if (atLift || p.leaveTries >= 3 || !kindAt(this.plan, p.pos.x, p.pos.z)) {
          if (p.fade > 0.98 && atLift) this.facility.ring()
          p.fade -= dt * 1.4
        }
      } else p.fade = Math.min(1, p.fade + dt * 1.5)
      const showGoal = !this.filter || this.filter(p) ? 1 : 0
      p.shown += (showGoal - p.shown) * Math.min(1, dt * 5)

      const selected = p.id === selectedId ? 0.18 + 0.1 * Math.sin(elapsed * 4) : 0
      const props = (p.status === 'working' && p.seated ? 1 : 0) + (p.pause > 0 && p.goal?.kind === 'coffee' ? 2 : 0) + (p.onCase && !p.seated ? 4 : 0)
      const scale = p.look.height * Math.max(0.001, p.fade * p.shown)
      const m = _m.compose(_v.set(p.pos.x, 0, p.pos.z), _q.setFromAxisAngle(UP, p.yaw), _s.setScalar(1))
      this.mesh.setMatrixAt(p.index, m)
      this.attrs.pose.setXYZW(p.index, p.poseA, p.poseB, p.blend, phase)
      this.attrs.misc.setXYZW(p.index, p.headYaw, props, scale, selected)
    }

    for (const p of list) if (p.mode === 'leaving' && p.fade <= 0) this._remove(p)
    this._separate(list)

    this.mesh.instanceMatrix.needsUpdate = true
    this.attrs.pose.needsUpdate = true
    this.attrs.misc.needsUpdate = true
    this.stats.seated = seated

    this._gapClock += dt
    if (this._gapClock > 0.5) {
      this._gapClock = 0
      let gap = Infinity
      const active = list.filter((p) => p.mode === 'live' && !p.seated && p.fade > 0.9)
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const d = Math.hypot(active[i].pos.x - active[j].pos.x, active[i].pos.z - active[j].pos.z)
          gap = Math.min(gap, d)
          if (d < BODY * 0.5) this.stats.overlaps++
        }
      }
      this.stats.minGap = gap
    }
  }

  /** Reached the end of the path. */
  _arrive(p) {
    p.path = []
    const g = p.goal
    if (!g) return
    if (g.kind === 'checkpoint') {
      p.checkpointed = true
      p.mode = 'live'
      p.goal = null
      return
    }
    if (g.kind === 'seat') {
      if (Math.hypot(g.x - p.pos.x, g.z - p.pos.z) < SEAT_SNAP + 0.4) {
        p.pos.set(g.x, 0, g.z)
        p.seated = true
      } else p.path = null // not there yet: route again from here
      return
    }
    if (g.kind === 'stand') {
      p.arrived = true
      return
    }
    if (g.kind === 'elevator') return
    // A wander or a coffee: linger, then go again.
    p.pause = (1.5 + p.look.random() * 3.5) * p.look.linger
    p.arrived = true
  }

  /** Hard spacing for people on their feet; the seated never move. */
  _separate(list) {
    const min = BODY * 0.7
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (a.seated || a.mode === 'leaving') continue
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        if (b.mode === 'leaving') continue
        let dx = a.pos.x - b.pos.x
        let dz = a.pos.z - b.pos.z
        const d = Math.hypot(dx, dz)
        if (d >= min) continue
        if (d < 1e-5) {
          dx = 1
          dz = 0
        } else {
          dx /= d
          dz /= d
        }
        const push = min - d
        // Push only those on their feet, and only where the floor allows.
        if (b.seated) this.nav.slide(a.pos, dx * push, dz * push)
        else {
          this.nav.slide(a.pos, (dx * push) / 2, (dz * push) / 2)
          this.nav.slide(b.pos, (-dx * push) / 2, (-dz * push) / 2)
        }
        this.stats.pushes++
      }
    }
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
