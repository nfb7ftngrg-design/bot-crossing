import * as THREE from 'three'
import { OVERLAY_LAYER } from '../core/engine.js'

/**
 * The reef's signals and small ceremonies, each one draw:
 *
 * - **Beacons** — a gold column of light over every fish that is waiting on you. Gold is used
 *   nowhere else, it ignores depth so a shelf never hides it, and it is the one thing on screen
 *   meant to be seen from anywhere.
 * - **Badges** — `?`, `!`, `✓` over the fish that want something, and over nothing else.
 * - **Effects** — bubbles, sand puffs and sparkles: arrivals, departures, work, a merge.
 */

export const WAITING_GOLD = new THREE.Color(1.0, 0.78, 0.22)

// ── beacons ─────────────────────────────────────────────────────────────────────────────

export class Beacons {
  constructor(scene, max = 256) {
    this.max = max
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1)
    geo.translate(0, 0.5, 0)
    this.data = new Float32Array(max * 4)
    this.attr = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aBeacon', this.attr)
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: WAITING_GOLD.clone().multiplyScalar(1.6) } },
      vertexShader: /* glsl */ `
        attribute vec4 aBeacon; // x, base y, z, strength
        varying vec2 vUv;
        varying float vStrength;
        varying float vHeight;
        void main() {
          vUv = uv;
          vStrength = aBeacon.w;
          // Billboard about the vertical axis: always as wide as it can be, whichever way you look.
          vec3 base = aBeacon.xyz;
          vec3 toCam = cameraPosition - base;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
          float width = 1.3;
          float height = 46.0;
          vec3 p = base + right * position.x * width + vec3(0.0, position.y * height, 0.0);
          vHeight = position.y * height;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vStrength;
        varying float vHeight;
        void main() {
          float x = abs(vUv.x - 0.5) * 2.0;
          float core = pow(1.0 - x, 3.0);
          float halo = pow(1.0 - x, 1.2) * 0.35;
          // Rings of light climbing the column, so it reads as alive rather than as a pole.
          float rings = 0.75 + 0.25 * sin(vHeight * 1.4 - uTime * 4.0);
          float fade = smoothstep(0.0, 0.03, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
          float a = (core + halo) * rings * fade * vStrength;
          gl_FragColor = vec4(uColor * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 20
    scene.add(this.mesh)
    /** id → { pos, strength, wanted } */
    this.items = new Map()
  }

  /** `wanted` is Map(id → base position). Columns fade in and out rather than popping. */
  update(dt, elapsed, wanted) {
    this.material.uniforms.uTime.value = elapsed
    for (const [id, pos] of wanted) {
      let item = this.items.get(id)
      if (!item) this.items.set(id, (item = { pos: pos.clone(), strength: 0 }))
      item.pos.lerp(pos, Math.min(1, dt * 4))
      item.wanted = true
    }
    let n = 0
    for (const [id, item] of this.items) {
      const goal = wanted.has(id) ? 1 : 0
      item.strength += (goal - item.strength) * Math.min(1, dt * 3)
      if (!goal && item.strength < 0.01) {
        this.items.delete(id)
        continue
      }
      if (n >= this.max) continue
      this.data.set([item.pos.x, item.pos.y, item.pos.z, item.strength], n * 4)
      n++
    }
    this.mesh.count = n
    this.attr.needsUpdate = true
  }
}

// ── badges ──────────────────────────────────────────────────────────────────────────────

export const BADGE = { none: -1, waiting: 0, blocked: 1, done: 2 }

function badgeAtlas() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size * 3
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const draw = (i, fill, glyph) => {
    const cx = i * size + size / 2
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.beginPath()
    ctx.arc(cx, size / 2 + 4, size * 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(cx, size / 2, size * 0.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 7
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.font = `800 ${size * 0.5}px system-ui, -apple-system, Segoe UI, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(glyph, cx, size / 2 + 3)
  }
  draw(0, '#e7a91c', '?')
  draw(1, '#e0453a', '!')
  draw(2, '#2fae6a', '✓')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

export class Badges {
  constructor(scene, max = 400) {
    this.max = max
    const geo = new THREE.PlaneGeometry(1, 1)
    this.data = new Float32Array(max * 4)
    this.attr = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aBadge', this.attr)
    this.material = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: badgeAtlas() }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aBadge; // position, icon
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = vec2((uv.x + aBadge.w) / 3.0, uv.y);
          vec4 mv = viewMatrix * vec4(aBadge.xyz, 1.0);
          // Grows a little with distance so a badge stays legible zoomed out, without
          // swamping the fish up close.
          float size = 0.55 + clamp(-mv.z, 0.0, 120.0) * 0.014;
          size *= 1.0 + 0.06 * sin(uTime * 3.0 + aBadge.x);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uAtlas, vUv);
          if (c.a < 0.02) discard;
          gl_FragColor = vec4(c.rgb, c.a);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
    this.mesh = new THREE.InstancedMesh(geo, this.material, max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 30
    this.mesh.layers.set(OVERLAY_LAYER)
    scene.add(this.mesh)
  }

  /** `items` is [{ pos, icon }]. */
  update(elapsed, items) {
    this.material.uniforms.uTime.value = elapsed
    let n = 0
    for (const item of items) {
      if (n >= this.max) break
      this.data.set([item.pos.x, item.pos.y, item.pos.z, item.icon], n * 4)
      n++
    }
    this.mesh.count = n
    this.attr.needsUpdate = true
  }
}

// ── bubbles, sand, sparkle ──────────────────────────────────────────────────────────────

const KIND = { bubbles: 0, sand: 1, sparkle: 2 }

export class Effects {
  constructor(scene, max = 3000) {
    this.max = max
    this.budget = max
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.life = new Float32Array(max) // seconds left
    this.span = new Float32Array(max)
    this.kind = new Float32Array(max)
    this.size = new Float32Array(max)
    this.alpha = new Float32Array(max)
    this.cursor = 0
    this.alive = 0

    const geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)
    this.kindAttr = new THREE.BufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage)
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage)
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', this.posAttr)
    geo.setAttribute('aKind', this.kindAttr)
    geo.setAttribute('aSize', this.sizeAttr)
    geo.setAttribute('aAlpha', this.alphaAttr)
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aKind;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying float vKind;
        varying float vAlpha;
        void main() {
          vKind = aKind;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale * 300.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vKind;
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5 || vAlpha <= 0.0) discard;
          vec4 col;
          if (vKind < 0.5) {
            // A bubble: a bright rim and a highlight.
            float rim = smoothstep(0.3, 0.45, d) * (1.0 - smoothstep(0.45, 0.5, d));
            float spec = 1.0 - smoothstep(0.0, 0.12, length(c - vec2(-0.15, -0.15)));
            col = vec4(vec3(0.85, 0.97, 1.0) * 1.3, (rim * 0.8 + spec) * vAlpha);
          } else if (vKind < 1.5) {
            col = vec4(0.86, 0.78, 0.6, smoothstep(0.5, 0.0, d) * 0.55 * vAlpha);
          } else {
            col = vec4(vec3(0.75, 1.0, 1.0) * 3.0, smoothstep(0.5, 0.0, d) * vAlpha);
          }
          gl_FragColor = col;
        }
      `,
      transparent: true,
      depthWrite: false,
    })
    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = 8
    scene.add(this.points)
  }

  setBudget(budget) {
    this.budget = Math.max(0, Math.min(this.max, budget))
    this.points.visible = this.budget > 0
  }

  burst(at, kind, count) {
    if (!this.budget) return
    const k = KIND[kind]
    for (let n = 0; n < count; n++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % this.budget
      const span = k === 0 ? 2.5 + Math.random() * 2 : k === 1 ? 1.4 + Math.random() * 0.8 : 0.7 + Math.random() * 0.5
      this.life[i] = span
      this.span[i] = span
      this.kind[i] = k
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 0.3
      this.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * 0.2
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 0.3
      const a = Math.random() * Math.PI * 2
      if (k === 0) {
        this.vel.set([Math.cos(a) * 0.15, 0.8 + Math.random() * 0.8, Math.sin(a) * 0.15], i * 3)
        this.size[i] = 0.06 + Math.random() * 0.1
      } else if (k === 1) {
        const s = 0.6 + Math.random() * 0.9
        this.vel.set([Math.cos(a) * s, 0.25 + Math.random() * 0.35, Math.sin(a) * s], i * 3)
        this.size[i] = 0.25 + Math.random() * 0.3
      } else {
        const s = 1.5 + Math.random() * 2
        const b = Math.random() * Math.PI
        this.vel.set([Math.cos(a) * Math.sin(b) * s, Math.cos(b) * s, Math.sin(a) * Math.sin(b) * s], i * 3)
        this.size[i] = 0.05 + Math.random() * 0.06
      }
    }
  }

  update(dt, elapsed) {
    this.material.uniforms.uScale.value = window.devicePixelRatio || 1
    let alive = 0
    for (let i = 0; i < this.budget; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      alive++
      this.life[i] -= dt
      const k = this.kind[i]
      const t = 1 - this.life[i] / this.span[i]
      if (k === 0) {
        // Bubbles wobble as they rise and swell a touch nearer the surface.
        this.pos[i * 3] += (this.vel[i * 3] + Math.sin(elapsed * 6 + i) * 0.25) * dt
        this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
        this.pos[i * 3 + 2] += (this.vel[i * 3 + 2] + Math.cos(elapsed * 5 + i) * 0.25) * dt
        this.size[i] += dt * 0.01
        this.alpha[i] = Math.min(1, t * 6) * (1 - Math.max(0, t - 0.7) / 0.3)
      } else {
        const drag = Math.exp(-(k === 1 ? 2.2 : 3) * dt)
        this.vel[i * 3] *= drag
        this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - (k === 1 ? 0.15 : 0) * dt
        this.vel[i * 3 + 2] *= drag
        this.pos[i * 3] += this.vel[i * 3] * dt
        this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
        this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
        if (k === 1) this.size[i] += dt * 0.35
        this.alpha[i] = (1 - t) * Math.min(1, t * 8)
      }
    }
    this.alive = alive
    this.posAttr.needsUpdate = true
    this.kindAttr.needsUpdate = true
    this.sizeAttr.needsUpdate = true
    this.alphaAttr.needsUpdate = true
    this.points.geometry.setDrawRange(0, this.budget)
  }
}
