import * as THREE from 'three'
import { waterUniforms } from './shading.js'

/**
 * The water column: what the reef has instead of a sky.
 *
 * The dome is drawn twice from the same uniforms — once behind the scene, once into a small
 * cube scene that is prefiltered into the environment map. That second copy is what every PBR
 * surface reflects and is lit by, so the reef changes *character* through the day (a bright
 * Snell's window overhead at noon, a warm cast at dusk, deep blue at night) instead of just
 * getting darker.
 */

/** Palette stops through the day. Each row: surface glow, mid-water, deep. */
const PALETTE = [
  // t, top, mid, deep
  [0.0, 0x10294a, 0x06182c, 0x020a14],
  [0.2, 0x1d3f63, 0x0b2741, 0x03101e],
  [0.27, 0xd99a7a, 0x2a5a78, 0x0a2236],
  [0.36, 0x8fe3f0, 0x2a9ab5, 0x0b4560],
  [0.5, 0xa8f0ff, 0x35b2c8, 0x0c5470],
  [0.64, 0x8fe3f0, 0x2a9ab5, 0x0b4560],
  [0.73, 0xe8a07a, 0x2c5f7c, 0x0a2236],
  [0.8, 0x1d3f63, 0x0b2741, 0x03101e],
  [1.0, 0x10294a, 0x06182c, 0x020a14],
]

const colA = new THREE.Color()
const colB = new THREE.Color()

function samplePalette(t, column, out) {
  for (let i = 0; i < PALETTE.length - 1; i++) {
    const a = PALETTE[i]
    const b = PALETTE[i + 1]
    if (t >= a[0] && t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0] || 1)
      colA.setHex(a[column])
      colB.setHex(b[column])
      return out.copy(colA).lerp(colB, k * k * (3 - 2 * k))
    }
  }
  return out.setHex(PALETTE[0][column])
}

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
    gl_Position.z = gl_Position.w; // pinned to the far plane
  }
`

const DOME_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uDeep;
  uniform vec3 uSunDir;
  uniform float uDaylight;
  uniform float uTime;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uMid, uTop, smoothstep(0.0, 0.85, h));
    col = mix(col, uDeep, smoothstep(0.0, -0.6, h));
    // Snell's window: the whole sky squeezed into a bright disc overhead, rippling.
    float win = smoothstep(0.62, 0.9, h);
    float ripple = 0.85 + 0.15 * sin(d.x * 40.0 + uTime * 1.3) * sin(d.z * 37.0 - uTime * 1.1);
    col += uTop * win * 0.9 * ripple * (0.35 + 0.65 * uDaylight);
    // The sun, smeared by the surface into a soft hot spot.
    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    col += vec3(1.0, 0.95, 0.8) * pow(sun, 24.0) * 2.4 * uDaylight * step(0.0, h);
    gl_FragColor = vec4(col, 1.0);
  }
`

export class Water {
  constructor(scene, renderer, settings) {
    this.scene = scene
    this.renderer = renderer
    this.settings = settings

    this.uniforms = {
      uTop: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color() },
      uSunDir: waterUniforms.uSunDir,
      uDaylight: waterUniforms.uDaylight,
      uTime: waterUniforms.uTime,
    }
    const domeMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(400, 48, 24), domeMaterial)
    this.dome.renderOrder = -10
    this.dome.frustumCulled = false
    scene.add(this.dome)

    // The second copy, for the environment map. Same material, same uniforms.
    this.envScene = new THREE.Scene()
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), domeMaterial))
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.envTarget = null
    this._envStamp = -1
    this._envClock = 0

    this.fog = new THREE.FogExp2(0x1a6f8f, 0.012)
    scene.fog = this.fog
    scene.background = null

    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.2)
    this.sun.castShadow = true
    this.sun.shadow.camera.left = -34
    this.sun.shadow.camera.right = 34
    this.sun.shadow.camera.top = 34
    this.sun.shadow.camera.bottom = -34
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 140
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.04
    scene.add(this.sun, this.sun.target)

    // Only used when image-based lighting is off: something has to fill the shadows.
    this.hemi = new THREE.HemisphereLight(0x8fdcf0, 0x0b3a4a, 0.9)
    scene.add(this.hemi)

    this.shafts = createShafts()
    scene.add(this.shafts.mesh)
    this.snow = createSnow()
    scene.add(this.snow.points)

    this.time = settings.get('timeOfDay')
    this.applySettings()
  }

  applySettings() {
    const s = this.settings
    const ibl = s.get('ibl')
    if (!ibl && this.envTarget) {
      this.envTarget.dispose()
      this.envTarget = null
      this.scene.environment = null
    }
    this._envStamp = -1
    this.hemi.visible = !ibl
    this.snow.setBudget(s.particleBudget)
    const size = s.shadowSize
    this.sun.castShadow = size > 0
    if (size) this.sun.shadow.mapSize.setScalar(size)
  }

  /** 0..1 — midnight, dawn, noon, dusk. */
  currentTime(dt) {
    const s = this.settings
    if (s.get('clockTime')) {
      const d = new Date()
      this.time = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400
    } else if (s.get('autoTime')) {
      this.time = (this.time + dt / Math.max(10, s.get('dayLength'))) % 1
    } else {
      this.time = s.get('timeOfDay')
    }
    return this.time
  }

  update(dt, elapsed, focus, camera) {
    const t = this.currentTime(dt)
    waterUniforms.uTime.value = elapsed

    // The sun swings low across the south and never climbs straight overhead, so upright faces
    // always have something to catch. Below the horizon a dim moon takes over the same light.
    const angle = (t - 0.25) * Math.PI * 2
    const height = Math.sin(angle)
    const daylight = THREE.MathUtils.smoothstep(height, -0.12, 0.25)
    const night = 1 - THREE.MathUtils.smoothstep(height, -0.25, 0.05)
    const elevation = THREE.MathUtils.degToRad(18 + 44 * Math.max(0, height))
    const azimuth = Math.cos(angle) * 1.1 + 0.6
    const sunDir = waterUniforms.uSunDir.value
    sunDir.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth))
    waterUniforms.uDaylight.value = daylight
    waterUniforms.uNight.value = night

    samplePalette(t, 1, this.uniforms.uTop.value)
    samplePalette(t, 2, this.uniforms.uMid.value)
    samplePalette(t, 3, this.uniforms.uDeep.value)
    this.fog.color.copy(this.uniforms.uMid.value)
    this.fog.density = 0.0135 + night * 0.004

    this.sun.color.setHex(0xfff2dc).lerp(colA.setHex(0x9fc4ff), night)
    this.sun.intensity = 0.2 + 1.9 * daylight
    // The shadow box rides along with the view, so detail goes where you are looking.
    this.sun.target.position.set(focus.x, 0, focus.z)
    this.sun.position.copy(this.sun.target.position).addScaledVector(sunDir, 70)
    this.hemi.intensity = 0.25 + 0.5 * daylight
    this.hemi.color.copy(this.uniforms.uTop.value)
    this.hemi.groundColor.copy(this.uniforms.uDeep.value)

    this.dome.position.copy(camera.position)
    this.shafts.update(elapsed, focus, sunDir, daylight, this.settings.get('reducedMotion'))
    this.snow.update(dt, elapsed, focus, night, this.uniforms.uTop.value)

    // The environment is re-filtered when the light has visibly moved, and at most every couple
    // of seconds — PMREM is a handful of passes, not something to do per frame.
    this._envClock += dt
    if (this.settings.get('ibl')) {
      const stamp = Math.round(t * 400)
      if (stamp !== this._envStamp && (this._envClock > 2 || this._envStamp < 0)) {
        this._envStamp = stamp
        this._envClock = 0
        const target = this.pmrem.fromScene(this.envScene, 0, 0.1, 50)
        this.envTarget?.dispose()
        this.envTarget = target
        this.scene.environment = target.texture
      }
      this.scene.environmentIntensity = this.settings.get('iblIntensity') * (0.3 + 0.22 * daylight)
    }
    return { daylight, night, time: t }
  }
}

/**
 * God rays: a handful of tall additive ribbons slanting down from the surface along the sun.
 * Faded at the top and bottom and by distance from the view, so they read as light in the water
 * rather than as planes.
 */
function createShafts() {
  const COUNT = 26
  const geo = new THREE.PlaneGeometry(1, 1, 1, 8)
  geo.translate(0, 0.5, 0)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 1 },
      uFocus: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aShaft; // x, z offset, width, phase
      uniform vec3 uFocus;
      uniform float uTime;
      varying float vV;
      varying float vFade;
      varying float vPhase;
      varying float vU;
      void main() {
        vV = uv.y;
        vU = uv.x;
        vPhase = aShaft.w;
        vec4 world = instanceMatrix * vec4(position, 1.0);
        float d = length(world.xz - uFocus.xz);
        vFade = 1.0 - smoothstep(18.0, 46.0, d);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uStrength;
      varying float vV;
      varying float vFade;
      varying float vPhase;
      varying float vU;
      void main() {
        float edge = sin(vU * 3.14159);
        float flicker = 0.6 + 0.4 * sin(uTime * 0.7 + vPhase * 6.0) * sin(uTime * 0.31 + vPhase * 11.0);
        float a = edge * edge * smoothstep(0.0, 0.35, vV) * (1.0 - smoothstep(0.75, 1.0, vV));
        gl_FragColor = vec4(vec3(0.75, 0.95, 1.0) * a * flicker * vFade * uStrength * 0.11, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
  const mesh = new THREE.InstancedMesh(geo, material, COUNT)
  mesh.frustumCulled = false
  mesh.renderOrder = 5
  const shaft = new Float32Array(COUNT * 4)
  const seeds = []
  for (let i = 0; i < COUNT; i++) {
    const s = { x: (Math.random() - 0.5) * 70, z: (Math.random() - 0.5) * 70, w: 1.2 + Math.random() * 3.2, p: Math.random() }
    seeds.push(s)
    shaft.set([s.x, s.z, s.w, s.p], i * 4)
  }
  geo.setAttribute('aShaft', new THREE.InstancedBufferAttribute(shaft, 4))

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const scale = new THREE.Vector3()
  const pos = new THREE.Vector3()
  return {
    mesh,
    update(elapsed, focus, sunDir, daylight, still) {
      material.uniforms.uTime.value = still ? 0 : elapsed
      material.uniforms.uStrength.value = daylight
      material.uniforms.uFocus.value.copy(focus)
      mesh.visible = daylight > 0.02
      if (!mesh.visible) return
      // Lean the shafts along the sun, and keep them facing the camera around their own axis.
      const lean = Math.atan2(Math.hypot(sunDir.x, sunDir.z), sunDir.y)
      const heading = Math.atan2(sunDir.x, sunDir.z)
      for (let i = 0; i < COUNT; i++) {
        const s = seeds[i]
        // Tiled around the focus, so wherever you look there are shafts.
        const x = focus.x + wrap(s.x - focus.x, 70)
        const z = focus.z + wrap(s.z - focus.z, 70)
        pos.set(x, -1, z)
        e.set(0, heading + Math.PI / 2, -lean, 'YXZ')
        q.setFromEuler(e)
        scale.set(s.w, 44, 1)
        m.compose(pos, q, scale)
        mesh.setMatrixAt(i, m)
      }
      mesh.instanceMatrix.needsUpdate = true
    },
  }
}

/** Wrap a value into [-size/2, size/2). */
const wrap = (v, size) => ((((v + size / 2) % size) + size) % size) - size / 2

/**
 * Marine snow by day, bioluminescent plankton by night. One draw; the count follows the
 * particle budget, and the box wraps around the view so the density never thins out.
 */
function createSnow() {
  const MAX = 3000
  const BOX = 60
  const positions = new Float32Array(MAX * 3)
  const seeds = new Float32Array(MAX)
  for (let i = 0; i < MAX; i++) {
    positions[i * 3] = (Math.random() - 0.5) * BOX
    positions[i * 3 + 1] = Math.random() * 16
    positions[i * 3 + 2] = (Math.random() - 0.5) * BOX
    seeds[i] = Math.random()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFocus: { value: new THREE.Vector3() },
      uNight: { value: 0 },
      uTint: { value: new THREE.Color() },
      uScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uFocus;
      uniform float uNight;
      uniform float uScale;
      varying float vSeed;
      varying float vFade;
      void main() {
        vSeed = aSeed;
        vec3 p = position;
        p.x += sin(uTime * 0.21 + aSeed * 40.0) * 0.8;
        p.z += cos(uTime * 0.17 + aSeed * 31.0) * 0.8;
        p.y = mod(p.y - uTime * (0.05 + aSeed * 0.08), 16.0);
        // Wrap the box around the focus.
        p.xz = uFocus.xz + mod(p.xz - uFocus.xz + 30.0, 60.0) - 30.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vFade = 1.0 - smoothstep(25.0, 70.0, -mv.z);
        gl_PointSize = uScale * (1.0 + aSeed * 1.6 + uNight * 1.2) * 34.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      uniform float uTime;
      uniform vec3 uTint;
      varying float vSeed;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c));
        // At night a share of them pulse blue-green, bright enough for bloom to pick out.
        float pulse = step(0.72, vSeed) * (0.5 + 0.5 * sin(uTime * (1.0 + vSeed * 2.0) + vSeed * 50.0));
        vec3 day = mix(vec3(0.85, 0.95, 1.0), uTint, 0.3) * 0.35;
        vec3 glow = vec3(0.2, 1.0, 0.85) * (0.15 + pulse * 2.6);
        vec3 col = mix(day, glow, uNight);
        gl_FragColor = vec4(col * a * vFade, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const points = new THREE.Points(geo, material)
  points.frustumCulled = false
  points.renderOrder = 6
  return {
    points,
    setBudget(budget) {
      const n = Math.min(MAX, Math.round(budget * 0.5))
      geo.setDrawRange(0, n)
      points.visible = n > 0
    },
    update(dt, elapsed, focus, night, tint) {
      material.uniforms.uTime.value = elapsed
      material.uniforms.uFocus.value.copy(focus)
      material.uniforms.uNight.value = night
      material.uniforms.uTint.value.copy(tint)
      material.uniforms.uScale.value = window.devicePixelRatio || 1
    },
  }
}
