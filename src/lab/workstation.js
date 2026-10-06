import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { patchLab } from './look.js'

/**
 * Workstations: one per thread, every one of them in a single instanced draw.
 *
 * How built-up a desk looks is how much work its thread has done. A fresh thread gets a bare
 * desk with one monitor, a keyboard and a landline (no mobiles in a secure space). As the
 * transcript grows the desk fills in, a piece at a time: a mug, paper stacks, a second monitor,
 * binders, a third monitor, sticky notes and a photo. Each piece unfolds from where it sits as
 * growth passes it, in the vertex shader and in the shadow pass alike, so a young desk is a
 * whole tidy desk rather than a cluttered one sliced off.
 *
 * The screens say what the thread is doing, readable from across the floor: code scrolling
 * while it works, amber and pulsing when it is waiting on you, red when it errored, green when
 * its pull request merged, a screensaver when idle, dark when dormant. A manila case folder
 * appears on the desk of anyone you have put on a case.
 */

export const SCREEN = { off: 0, working: 1, waiting: 2, blocked: 3, celebrating: 4, idle: 5, sleeping: 6 }
export const MAX_DESKS = 400

/** Growth from work: never below a bare desk, full clutter at the top of the log scale. */
export const deskGrowth = (progress) => 0.12 + 0.88 * progress

// ── geometry ──────────────────────────────────────────────────────────────────────────

/**
 * A piece of the desk, tagged with when it appears (`grow`), the point it unfolds from (`base`),
 * whether it is a screen (and which), and whether it is the case folder.
 */
function piece(geo, color, grow, base, { screen = -1, folder = 0, lamp = 0 } = {}) {
  geo = geo.index ? geo.toNonIndexed() : geo
  const n = geo.attributes.position.count
  const c = new THREE.Color(color)
  const col = new Float32Array(n * 3)
  const aGrow = new Float32Array(n).fill(grow)
  const aBase = new Float32Array(n * 3)
  const aScreen = new Float32Array(n).fill(screen)
  const aFolder = new Float32Array(n).fill(folder)
  const aLamp = new Float32Array(n).fill(lamp)
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3)
    aBase.set([base.x, base.y, base.z], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setAttribute('aGrow', new THREE.BufferAttribute(aGrow, 1))
  geo.setAttribute('aBase', new THREE.BufferAttribute(aBase, 3))
  geo.setAttribute('aScreen', new THREE.BufferAttribute(aScreen, 1))
  geo.setAttribute('aFolder', new THREE.BufferAttribute(aFolder, 1))
  geo.setAttribute('aLamp', new THREE.BufferAttribute(aLamp, 1))
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  return geo
}

const V = (x, y, z) => new THREE.Vector3(x, y, z)
function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** A monitor: stand, bezel, and a screen face (uv'd) facing the person at +z. */
function monitor(parts, x, grow, index, w = 0.56) {
  const base = V(x, 0.76, -0.22)
  parts.push(piece(boxAt(0.18, 0.02, 0.14, x, 0.77, -0.22), 0x22262b, grow, base))
  parts.push(piece(boxAt(0.04, 0.26, 0.04, x, 0.89, -0.25), 0x22262b, grow, base))
  parts.push(piece(boxAt(w, 0.34, 0.03, x, 1.12, -0.24), 0x111317, grow, base))
  const screen = new THREE.PlaneGeometry(w - 0.04, 0.3)
  screen.translate(x, 1.12, -0.224)
  parts.push(piece(screen, 0x000000, grow, base, { screen: index }))
}

function buildDesk() {
  const parts = []
  const floor = V(0, 0, 0)
  const top = V(0, 0.75, 0)
  // The desk and its chair are always there.
  parts.push(piece(boxAt(1.7, 0.05, 0.85, 0, 0.735, 0), 0x6f5844, 0, floor))
  parts.push(piece(boxAt(0.05, 0.71, 0.75, -0.8, 0.355, 0), 0x3a3e44, 0, floor))
  parts.push(piece(boxAt(0.05, 0.71, 0.75, 0.8, 0.355, 0), 0x3a3e44, 0, floor))
  parts.push(piece(boxAt(1.6, 0.4, 0.03, 0, 0.5, -0.4), 0x3a3e44, 0, floor))
  // A low privacy screen along the back edge, like a watch-floor console.
  parts.push(piece(boxAt(1.7, 0.32, 0.04, 0, 0.92, -0.44), 0x4b5a6a, 0, floor))
  // Chair, behind the desk, facing it.
  const chair = V(0, 0, 0.95)
  parts.push(piece(boxAt(0.5, 0.08, 0.5, 0, 0.46, 0.95), 0x1e2227, 0, chair))
  parts.push(piece(boxAt(0.5, 0.6, 0.07, 0, 0.82, 1.2), 0x1e2227, 0, chair))
  parts.push(piece(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8).translate(0, 0.21, 0.95), 0x50555c, 0, chair))
  parts.push(piece(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 12).translate(0, 0.02, 0.95), 0x50555c, 0, chair))
  // Keyboard, mouse, landline, lamp: from the first day.
  parts.push(piece(boxAt(0.46, 0.02, 0.15, 0, 0.77, 0.12), 0x2a2d31, 0, top))
  parts.push(piece(boxAt(0.06, 0.02, 0.1, 0.33, 0.77, 0.14), 0x2a2d31, 0, top))
  parts.push(piece(boxAt(0.2, 0.06, 0.18, -0.62, 0.79, 0.05), 0xd9d4c7, 0, top))
  parts.push(piece(boxAt(0.18, 0.03, 0.07, -0.62, 0.835, 0.02), 0x2a2d31, 0, top))
  const lampBase = V(0.72, 0.76, -0.25)
  parts.push(piece(new THREE.CylinderGeometry(0.07, 0.08, 0.02, 10).translate(0.72, 0.77, -0.25), 0x2b2f35, 0, lampBase))
  parts.push(piece(boxAt(0.02, 0.36, 0.02, 0.72, 0.95, -0.25), 0x2b2f35, 0, lampBase))
  parts.push(piece(new THREE.ConeGeometry(0.09, 0.12, 10, 1, true).rotateX(Math.PI).translate(0.66, 1.12, -0.2), 0x2b2f35, 0, lampBase))
  parts.push(piece(new THREE.SphereGeometry(0.04, 8, 6).translate(0.66, 1.08, -0.2), 0xfff1c9, 0, lampBase, { lamp: 1 }))
  monitor(parts, 0, 0, 0)
  // And then the work piles up.
  parts.push(piece(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 10).translate(0.5, 0.81, 0.12), 0xe8e3d6, 0.15, V(0.5, 0.76, 0.12)))
  parts.push(piece(boxAt(0.24, 0.05, 0.32, -0.34, 0.785, -0.05), 0xf2efe6, 0.25, V(-0.34, 0.76, -0.05)))
  monitor(parts, -0.58, 0.35, 1, 0.5)
  for (let i = 0; i < 3; i++) {
    const c = [0x2e5fa8, 0xb23a2e, 0x2f7d4f][i]
    parts.push(piece(boxAt(0.05, 0.28, 0.22, -0.78 + i * 0.06, 0.9, -0.3), c, 0.5 + i * 0.03, V(-0.78 + i * 0.06, 0.76, -0.3)))
  }
  parts.push(piece(boxAt(0.22, 0.12, 0.3, 0.36, 0.82, -0.08), 0xf2efe6, 0.6, V(0.36, 0.76, -0.08)))
  monitor(parts, 0.58, 0.7, 2, 0.5)
  // Sticky notes on the monitor bezel and a framed photo: the long-running desk.
  for (let i = 0; i < 3; i++) {
    const c = [0xf5e34a, 0xf59ac0, 0x8fe3a8][i]
    parts.push(piece(boxAt(0.06, 0.06, 0.005, -0.22 + i * 0.08, 1.31, -0.222), c, 0.8 + i * 0.04, V(-0.22 + i * 0.08, 1.31, -0.222)))
  }
  parts.push(piece(boxAt(0.12, 0.15, 0.02, 0.28, 0.84, -0.32), 0x6b4a2f, 0.88, V(0.28, 0.76, -0.32)))
  // The case folder: shown only when this thread is on a case.
  parts.push(piece(boxAt(0.24, 0.02, 0.31, 0.08, 0.77, -0.02).rotateY(0.18), 0xc9a560, 0, top, { folder: 1 }))
  parts.push(piece(boxAt(0.12, 0.006, 0.04, 0.08, 0.782, -0.15).rotateY(0.18), 0xb03a2e, 0, top, { folder: 1 }))
  const geo = BufferGeometryUtils.mergeGeometries(parts, false)
  geo.computeVertexNormals()
  return geo
}

const SCREEN_GLSL = /* glsl */ `
  float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  /** What a monitor shows, by state. uv is the screen face; t is time; seed varies per desk. */
  vec3 screenColor(float state, vec2 uv, float t, float seed, float monitorIndex) {
    float s = seed * 13.0 + monitorIndex * 7.0;
    if (state < 0.5) return vec3(0.0);
    if (state < 1.5) {
      // Working: lines of code scrolling up, each line its own length and indent.
      float rows = 14.0;
      float y = uv.y * rows + t * (1.6 + h11(s) * 1.2);
      float line = floor(y);
      float indent = floor(h11(line + s) * 4.0) * 0.06;
      float len = 0.25 + h11(line * 1.7 + s) * 0.6;
      float on = step(indent + 0.04, uv.x) * step(uv.x, indent + len) * step(0.25, fract(y)) * step(fract(y), 0.75);
      vec3 ink = mix(vec3(0.3, 0.95, 0.75), vec3(0.45, 0.75, 1.0), step(0.6, h11(line + 3.0 + s)));
      return vec3(0.02, 0.05, 0.07) + ink * on * 0.9;
    }
    if (state < 2.5) {
      // Waiting on you: amber, a prompt and a blinking cursor, pulsing.
      float pulse = 0.65 + 0.35 * sin(t * 4.0);
      float cursor = step(0.45, uv.x) * step(uv.x, 0.55) * step(0.42, uv.y) * step(uv.y, 0.58) * step(0.5, fract(t * 1.5));
      return vec3(0.55, 0.36, 0.02) * pulse + vec3(1.0, 0.85, 0.4) * cursor;
    }
    if (state < 3.5) {
      // Errored: red, with a white bar where the stack trace would be.
      float bar = step(0.1, uv.x) * step(uv.x, 0.9) * step(0.45, uv.y) * step(uv.y, 0.55);
      float flash = 0.75 + 0.25 * step(0.5, fract(t * 1.2));
      return vec3(0.6, 0.04, 0.03) * flash + bar * vec3(0.9);
    }
    if (state < 4.5) {
      // Merged: green, a tick.
      vec2 p = uv - vec2(0.5);
      float tick = smoothstep(0.05, 0.0, abs(p.y + p.x * 0.9 + 0.05)) * step(-0.05, p.x) * step(p.x, 0.25)
                 + smoothstep(0.05, 0.0, abs(p.y - p.x * 0.7 + 0.02)) * step(-0.18, p.x) * step(p.x, -0.02);
      return vec3(0.03, 0.4, 0.15) + vec3(0.7, 1.0, 0.75) * clamp(tick, 0.0, 1.0);
    }
    if (state < 5.5) {
      // Idle: a slow screensaver — a dim seal drifting about.
      vec2 c = vec2(0.5 + 0.3 * sin(t * 0.21 + s), 0.5 + 0.25 * sin(t * 0.17 + s * 2.0));
      float ring = smoothstep(0.02, 0.0, abs(length((uv - c) * vec2(1.6, 1.0)) - 0.16));
      return vec3(0.02, 0.04, 0.08) + vec3(0.2, 0.35, 0.6) * ring;
    }
    // Dormant: dark, one standby light.
    float led = step(length((uv - vec2(0.94, 0.08)) * vec2(1.6, 1.0)), 0.02);
    return vec3(0.0) + vec3(0.9, 0.5, 0.1) * led * 0.6;
  }
`

export class Workstations {
  constructor(scene) {
    const geo = buildDesk()
    this.growth = new Float32Array(MAX_DESKS)
    this.state = new Float32Array(MAX_DESKS)
    this.extra = new Float32Array(MAX_DESKS * 2) // seed, has-case
    geo.setAttribute('aGrowth', new THREE.InstancedBufferAttribute(this.growth, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aState', new THREE.InstancedBufferAttribute(this.state, 1).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aExtra', new THREE.InstancedBufferAttribute(this.extra, 2).setUsage(THREE.DynamicDrawUsage))
    const vertexPars = /* glsl */ `
      attribute float aGrow;
      attribute vec3 aBase;
      attribute float aScreen;
      attribute float aFolder;
      attribute float aLamp;
      attribute float aGrowth;
      attribute float aState;
      attribute vec2 aExtra;
      varying float vScreen;
      varying vec2 vUvS;
      varying float vState;
      varying float vSeed;
      varying float vLamp;
    `
    const vertex = /* glsl */ `
      {
        float shown = smoothstep(aGrow, aGrow + 0.08, aGrowth);
        // The folder is there only while this thread is on a case.
        shown *= mix(1.0, aExtra.y, aFolder);
        transformed = aBase + (transformed - aBase) * shown;
      }
    `
    const { material, depth } = patchLab(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }), {
      key: 'desk',
      vertexPars,
      vertex,
      fragmentPars: /* glsl */ `
        varying float vScreen;
        varying vec2 vUvS;
        varying float vState;
        varying float vSeed;
        varying float vLamp;
        ${SCREEN_GLSL}
      `,
      emissive: /* glsl */ `
        if (vScreen > -0.5) {
          totalEmissiveRadiance += screenColor(vState, vUvS, uTime, vSeed, vScreen) * 1.6;
        }
        // The desk lamp is on while the thread works — faint by day, bright on the night shift.
        totalEmissiveRadiance += vec3(1.0, 0.86, 0.6) * vLamp * step(0.5, vState) * step(vState, 1.5) * (0.8 + uNight * 4.0);
      `,
    })
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader) => {
      previous(shader)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvScreen = aScreen; vUvS = uv; vState = aState; vSeed = aExtra.x; vLamp = aLamp;'
      )
    }
    this.mesh = new THREE.InstancedMesh(geo, material, MAX_DESKS)
    this.mesh.customDepthMaterial = depth
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    // Pools of lamplight on the floor under the desks of working threads, on the night shift.
    this.pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: { uStrength: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uStrength; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.0, 1.0, d)); gl_FragColor = vec4(vec3(1.0, 0.82, 0.55) * a * a * uStrength * 0.35, 1.0); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_DESKS
    )
    this.pools.count = 0
    this.pools.frustumCulled = false
    this.pools.renderOrder = 3
    scene.add(this.pools)

    this.entries = new Map()
    this.slots = []
    this.free = []
    this.used = 0
  }

  /** Make sure thread `id` has a desk at `pos` ({ x, z }), aiming for `progress`, showing `state`. */
  sync(id, pos, progress, status, onCase, seed) {
    let e = this.entries.get(id)
    if (!e) {
      const slot = this.free.length ? this.free.pop() : this.used++
      if (slot >= MAX_DESKS) {
        this.used = MAX_DESKS
        return null
      }
      e = { id, slot, x: pos.x, z: pos.z, growth: 0, target: 0, leaving: false }
      this.slots[slot] = e
      this.entries.set(id, e)
      this._place(e)
    } else if (e.x !== pos.x || e.z !== pos.z) {
      e.x = pos.x
      e.z = pos.z
      this._place(e)
    }
    e.leaving = false
    e.target = deskGrowth(progress)
    e.status = status
    this.state[e.slot] = SCREEN[status] ?? SCREEN.idle
    this.extra[e.slot * 2] = seed
    this.extra[e.slot * 2 + 1] = onCase ? 1 : 0
    e.onCase = Boolean(onCase)
    this.mesh.geometry.attributes.aState.needsUpdate = true
    this.mesh.geometry.attributes.aExtra.needsUpdate = true
    this.mesh.count = this.used
    return e
  }

  /** The thread left: its desk clears down, then the slot is free for the next arrival. */
  retire(id) {
    const e = this.entries.get(id)
    if (e) {
      e.leaving = true
      this.state[e.slot] = SCREEN.off
      this.extra[e.slot * 2 + 1] = 0
      this.mesh.geometry.attributes.aState.needsUpdate = true
      this.mesh.geometry.attributes.aExtra.needsUpdate = true
    }
  }

  _place(e) {
    const m = new THREE.Matrix4().makeTranslation(e.x, 0, e.z)
    this.mesh.setMatrixAt(e.slot, m)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  /** Desks block walking; the chair behind each one does not (somebody sits there). */
  obstacles(pad = 0.28) {
    const out = []
    for (const e of this.entries.values()) out.push({ x0: e.x - 0.85 - pad, x1: e.x + 0.85 + pad, z0: e.z - 0.43 - pad, z1: e.z + 0.43 + pad * 0.5 })
    return out
  }

  update(dt, night) {
    let dirty = false
    let pools = 0
    const m = new THREE.Matrix4()
    for (let slot = 0; slot < this.used; slot++) {
      const e = this.slots[slot]
      if (!e) continue
      const goal = e.leaving ? 0 : e.target
      const next = THREE.MathUtils.damp(e.growth, goal, e.leaving ? 1.5 : 0.8, dt)
      if (Math.abs(next - e.growth) > 1e-4) {
        e.growth = next
        this.growth[slot] = next
        dirty = true
      }
      if (e.leaving && e.growth < 0.01) {
        this.growth[slot] = 0
        this.slots[slot] = null
        this.free.push(slot)
        this.entries.delete(e.id)
        m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(slot, m)
        this.mesh.instanceMatrix.needsUpdate = true
        dirty = true
        continue
      }
      if (e.status === 'working' && !e.leaving && night > 0.05) {
        m.makeTranslation(e.x + 0.4, 0.015, e.z)
        this.pools.setMatrixAt(pools++, m)
      }
    }
    this.pools.count = pools
    this.pools.instanceMatrix.needsUpdate = true
    this.pools.material.uniforms.uStrength.value = night
    if (dirty) this.mesh.geometry.attributes.aGrowth.needsUpdate = true
  }

  get count() {
    return this.entries.size
  }
}
