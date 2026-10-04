import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { patchMaterial, rng, hash } from './shading.js'

/**
 * Coral: each thread's structure, grown in proportion to how much work it has done.
 *
 * Growth is a shader offset, never a rebuild. Every branch carries the point it springs from and
 * the growth at which it appears; below that it is folded down onto its own base, and as growth
 * passes it the branch unfolds to full length. A young coral is therefore a *whole* coral with
 * fewer branches — never a big one sliced off or half buried, which the colony learned reads as a
 * rendering fault. Folded branches fold in the shadow pass too, so a sapling throws a sapling's
 * shadow.
 *
 * Five forms, one instanced draw each, however many threads there are.
 */

const MAX_PER_KIND = 320
/** The palette deliberately leaves out gold and red: those mean "waiting" and "errored". */
const CORAL_COLORS = [0xf08ab4, 0xb48cf0, 0x6fd6c8, 0xf5f0e6, 0x7fb2f0, 0xe36f9a, 0x9bd66f, 0xf0a0d0, 0x5cc6e0, 0xc6a0f5]

const KINDS = ['branching', 'brain', 'fan', 'tubes', 'table']

export class Corals {
  constructor(scene) {
    this.scene = scene
    this.entries = new Map()
    this.kinds = KINDS.map((name) => this._makeKind(name))
    for (const kind of this.kinds) scene.add(kind.mesh)
  }

  _makeKind(name) {
    const geo = BUILDERS[name]()
    const growth = new Float32Array(MAX_PER_KIND)
    geo.setAttribute('aGrowth', new THREE.InstancedBufferAttribute(growth, 1).setUsage(THREE.DynamicDrawUsage))
    const { material, depth } = patchMaterial(
      new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 }),
      {
        key: `coral-${name}`,
        vertexPars: /* glsl */ `
          attribute float aGrow;
          attribute vec3 aBase;
          attribute float aTip;
          attribute float aGrowth;
          uniform float uTime;
          varying float vTip;
        `,
        vertex: /* glsl */ `
          float unfold = smoothstep(aGrow, aGrow + 0.14, aGrowth);
          transformed = aBase + (transformed - aBase) * unfold;
          // The outermost tips stir in the current.
          transformed.x += sin(uTime * 1.1 + aBase.y * 3.0 + aBase.x) * aTip * aTip * 0.05;
        `,
        fragmentPars: /* glsl */ `varying float vTip;`,
        fragmentColor: /* glsl */ `
          diffuseColor.rgb = mix(diffuseColor.rgb * 0.62, mix(diffuseColor.rgb, vec3(1.0), 0.35), vTip);
        `,
        emissive: /* glsl */ `
          #if defined( USE_COLOR )
            // After dark the tips glow with their own colour — bioluminescence, for bloom to find.
            totalEmissiveRadiance += vColor.rgb * pow(vTip, 3.0) * uNight * 2.2;
          #endif
        `,
      }
    )
    // vTip has to be written in the colour pass's vertex shader only; the depth pass has no use for it.
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader) => {
      previous(shader)
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTip = aTip;')
    }
    const mesh = new THREE.InstancedMesh(geo, material, MAX_PER_KIND)
    mesh.customDepthMaterial = depth
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.setColorAt(0, new THREE.Color(1, 1, 1))
    geo.computeBoundingBox()
    const size = geo.boundingBox.getSize(new THREE.Vector3())
    return { name, mesh, growth, slots: [], free: [], radius: Math.max(size.x, size.z) / 2, height: size.y }
  }

  /**
   * Make sure thread `id` has a coral at `position`, aiming for `progress` (0..1). Returns the
   * entry, which the fish use as home and obstacle.
   */
  sync(id, position, progress) {
    let entry = this.entries.get(id)
    if (!entry) {
      const random = rng(id)
      const kindIndex = hash(id) % this.kinds.length
      const kind = this.kinds[kindIndex]
      const slot = kind.free.length ? kind.free.pop() : kind.mesh.count++
      if (slot >= MAX_PER_KIND) {
        kind.mesh.count = MAX_PER_KIND
        return null
      }
      entry = {
        id,
        kind,
        slot,
        position: position.clone(),
        yaw: random() * Math.PI * 2,
        scale: 1.45 + random() * 0.55,
        color: new THREE.Color(CORAL_COLORS[Math.floor(random() * CORAL_COLORS.length)]),
        growth: 0,
        target: 0,
        leaving: false,
      }
      kind.slots[slot] = entry
      kind.mesh.setColorAt(slot, entry.color)
      kind.mesh.instanceColor.needsUpdate = true
      this.entries.set(id, entry)
      this._place(entry)
    } else if (!entry.position.equals(position)) {
      entry.position.copy(position)
      this._place(entry)
    }
    entry.leaving = false
    // Never below a sapling, so even a brand-new thread has something to call home.
    entry.target = 0.34 + 0.66 * progress
    return entry
  }

  /** The thread left: the coral folds back down, then gives its slot back. */
  retire(id) {
    const entry = this.entries.get(id)
    if (entry) entry.leaving = true
  }

  _place(entry) {
    const m = new THREE.Matrix4()
    const s = entry.scale * (0.85 + 0.3 * entry.target)
    m.compose(entry.position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), entry.yaw), new THREE.Vector3(s, s, s))
    entry.kind.mesh.setMatrixAt(entry.slot, m)
    entry.kind.mesh.instanceMatrix.needsUpdate = true
    entry.radius = entry.kind.radius * s
    entry.height = entry.kind.height * s
  }

  update(dt) {
    for (const kind of this.kinds) {
      let dirty = false
      for (let slot = 0; slot < kind.mesh.count; slot++) {
        const entry = kind.slots[slot]
        if (!entry) continue
        const goal = entry.leaving ? 0 : entry.target
        const next = THREE.MathUtils.damp(entry.growth, goal, entry.leaving ? 1.6 : 0.7, dt)
        if (Math.abs(next - entry.growth) > 1e-4) {
          entry.growth = next
          kind.growth[slot] = next
          dirty = true
        }
        if (entry.leaving && entry.growth < 0.01) {
          kind.growth[slot] = 0
          kind.slots[slot] = null
          kind.free.push(slot)
          this.entries.delete(entry.id)
          dirty = true
        }
      }
      if (dirty) kind.mesh.geometry.attributes.aGrowth.needsUpdate = true
    }
  }

  /** Count of corals actually drawn, for the stats readout. */
  get count() {
    return this.entries.size
  }
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────

/**
 * A tapered tube from `a` to `b`, tagged with where it grows from and when it appears.
 * `tip` runs 0 at the trunk to 1 at the outermost growth, and drives colour and night glow.
 */
function segment(parts, a, b, r0, r1, grow, tip0, tip1, radial = 7, cap = true) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const geo = new THREE.CylinderGeometry(r1, r0, len, radial, 2, !cap)
  geo.translate(0, len / 2, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  geo.applyQuaternion(q)
  geo.translate(a.x, a.y, a.z)
  if (cap) {
    const ball = new THREE.SphereGeometry(r1 * 1.05, radial, 4)
    ball.translate(b.x, b.y, b.z)
    parts.push(tag(ball, a, grow, tip1, tip1))
  }
  parts.push(tag(geo.index ? geo.toNonIndexed() : geo, a, grow, tip0, tip1, a, b))
}

function tag(geo, base, grow, tip0, tip1, a, b) {
  geo = geo.index ? geo.toNonIndexed() : geo
  const n = geo.attributes.position.count
  const aGrow = new Float32Array(n).fill(grow)
  const aBase = new Float32Array(n * 3)
  const aTip = new Float32Array(n)
  const p = geo.attributes.position
  const axis = a && b ? new THREE.Vector3().subVectors(b, a) : null
  const len2 = axis ? axis.lengthSq() : 1
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    aBase[i * 3] = base.x
    aBase[i * 3 + 1] = base.y
    aBase[i * 3 + 2] = base.z
    let t = 1
    if (axis) t = Math.min(1, Math.max(0, v.set(p.getX(i), p.getY(i), p.getZ(i)).sub(a).dot(axis) / len2))
    aTip[i] = tip0 + (tip1 - tip0) * t
  }
  geo.setAttribute('aGrow', new THREE.BufferAttribute(aGrow, 1))
  geo.setAttribute('aBase', new THREE.BufferAttribute(aBase, 3))
  geo.setAttribute('aTip', new THREE.BufferAttribute(aTip, 1))
  if (geo.attributes.uv) geo.deleteAttribute('uv')
  return geo
}

function finish(parts) {
  const geo = BufferGeometryUtils.mergeGeometries(parts, false)
  geo.computeVertexNormals()
  return geo
}

const BUILDERS = {
  /** Staghorn: a short trunk forking three or four times. */
  branching() {
    const random = rng('branching')
    const parts = []
    const grow = (a, dir, len, rad, depth, at) => {
      const b = a.clone().addScaledVector(dir, len)
      const tip0 = depth / 5
      segment(parts, a, b, rad, rad * 0.72, at, tip0, Math.min(1, tip0 + 0.25))
      if (depth >= 4) return
      const children = depth === 0 ? 4 : 2 + (random() < 0.4 ? 1 : 0)
      for (let i = 0; i < children; i++) {
        const spin = (i / children) * Math.PI * 2 + random() * 0.8
        const tilt = 0.35 + random() * 0.4
        const d = new THREE.Vector3(Math.sin(spin) * Math.sin(tilt), Math.cos(tilt), Math.cos(spin) * Math.sin(tilt))
        d.lerp(dir, 0.35).normalize()
        grow(b, d, len * (0.72 + random() * 0.15), rad * 0.72, depth + 1, Math.min(0.86, at + 0.17 + random() * 0.05))
      }
    }
    grow(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, 1, 0), 0.45, 0.2, 0, 0)
    return finish(parts)
  },

  /** Brain coral: a grooved dome, with smaller domes budding off it as it grows. */
  brain() {
    const parts = []
    const dome = (cx, cz, r, at, tipBias) => {
      const geo = new THREE.SphereGeometry(r, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.6)
      const p = geo.attributes.position
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i)
        const y = p.getY(i)
        const z = p.getZ(i)
        // Meandering grooves.
        const g = Math.sin(x * 9 + Math.sin(z * 7) * 2) * Math.sin(z * 8 + Math.sin(y * 6))
        const k = 1 + g * 0.035
        p.setXYZ(i, x * k, y * 0.75 * k - r * 0.25, z * k)
      }
      geo.translate(cx, 0, cz)
      const t = tag(geo, new THREE.Vector3(cx, -0.3, cz), at, 0, 0)
      // Tipness by height on the dome, so the crown glows at night.
      const pos = t.attributes.position
      const tip = t.attributes.aTip
      for (let i = 0; i < pos.count; i++) tip.setX(i, Math.min(1, Math.max(0, pos.getY(i) / (r * 0.6))) * tipBias)
      parts.push(t)
    }
    dome(0, 0, 1.25, 0, 0.9)
    dome(1.2, 0.5, 0.65, 0.35, 0.8)
    dome(-0.9, 0.9, 0.55, 0.55, 0.8)
    dome(-0.4, -1.1, 0.6, 0.72, 0.85)
    return finish(parts)
  },

  /** Sea fan: a flat lattice of fine branches facing the current. */
  fan() {
    const random = rng('fan')
    const parts = []
    const grow = (a, angle, len, rad, depth, at) => {
      const dir = new THREE.Vector3(Math.sin(angle), Math.cos(angle), (random() - 0.5) * 0.08).normalize()
      const b = a.clone().addScaledVector(dir, len)
      const tip0 = depth / 6
      segment(parts, a, b, rad, rad * 0.8, at, tip0, Math.min(1, tip0 + 0.2), 5)
      if (depth >= 5) return
      grow(b, angle - 0.32 - random() * 0.2, len * 0.82, rad * 0.8, depth + 1, Math.min(0.86, at + 0.15))
      grow(b, angle + 0.32 + random() * 0.2, len * 0.82, rad * 0.8, depth + 1, Math.min(0.86, at + 0.15 + random() * 0.04))
    }
    segment(parts, new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, 0.5, 0), 0.12, 0.1, 0, 0, 0.1, 6)
    grow(new THREE.Vector3(0, 0.5, 0), -0.2, 0.75, 0.09, 1, 0.12)
    grow(new THREE.Vector3(0, 0.5, 0), 0.25, 0.75, 0.09, 1, 0.14)
    return finish(parts)
  },

  /** Tube sponges: a clump of open tubes, the tallest last to rise. */
  tubes() {
    const random = rng('tubes')
    const parts = []
    const tubes = []
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + random()
      const r = i === 0 ? 0 : 0.35 + random() * 0.45
      tubes.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, h: 0.8 + random() * 2.1, w: 0.17 + random() * 0.12 })
    }
    tubes.sort((a, b) => a.h - b.h)
    tubes.forEach((t, i) => {
      const at = (i / tubes.length) * 0.8
      const base = new THREE.Vector3(t.x, -0.2, t.z)
      const top = new THREE.Vector3(t.x * 1.15, t.h, t.z * 1.15)
      segment(parts, base, top, t.w * 0.8, t.w * 1.2, at, 0.1, 1, 10, false)
      // A lip, so the open end reads as a tube.
      const lip = new THREE.TorusGeometry(t.w * 1.2, 0.035, 5, 12)
      lip.rotateX(Math.PI / 2)
      lip.translate(top.x, top.y, top.z)
      parts.push(tag(lip, base, at, 1, 1))
    })
    return finish(parts)
  },

  /** Table coral: a stalk, then a plate, then a second plate above it. */
  table() {
    const parts = []
    segment(parts, new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, 1.1, 0), 0.22, 0.16, 0, 0, 0.2, 8, false)
    const plate = (y, r, at) => {
      const geo = new THREE.CylinderGeometry(r, r * 0.25, 0.18, 22, 1)
      const p = geo.attributes.position
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i)
        const z = p.getZ(i)
        const wobble = 1 + Math.sin(Math.atan2(z, x) * 7) * 0.06
        p.setXYZ(i, x * wobble, p.getY(i) + (x * x + z * z) * 0.04, z * wobble)
      }
      geo.translate(0, y, 0)
      const t = tag(geo, new THREE.Vector3(0, y, 0), at, 0.4, 0.4)
      const pos = t.attributes.position
      const tip = t.attributes.aTip
      for (let i = 0; i < pos.count; i++) tip.setX(i, Math.min(1, Math.hypot(pos.getX(i), pos.getZ(i)) / r))
      parts.push(t)
    }
    plate(1.15, 1.5, 0.25)
    segment(parts, new THREE.Vector3(0.3, 1.2, 0.2), new THREE.Vector3(0.45, 1.9, 0.3), 0.12, 0.1, 0.55, 0.3, 0.5, 6, false)
    plate(1.95, 0.85, 0.65)
    return finish(parts)
  },
}
