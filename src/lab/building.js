import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js'
import { ROOM, HALF, DOOR, WALL, FACILITY, roomCentre, doorAlong } from './floorplan.js'
import { patchLab, labUniforms, canvasTexture, drawEmblem, SIGN_FONT, MONO_FONT, AGENCY, rng } from './look.js'

/**
 * The facility itself: floors, walls, doorways and everything bolted down. Rebuilt only when the
 * floor plan changes; everything that moves or means something (people, workstations, screens,
 * case boards) lives elsewhere and stands on top of it.
 *
 * Laid out after the real thing at a toy scale — a lobby with the elevators, a security desk, a
 * metal-detector arch and turnstiles; an operations room with a video wall facing a conference
 * table and the case boards on its walls; a server room in cold and hot aisles; an evidence
 * archive with shelving and pass-through lockers; a break room. Department rooms are watch floors
 * behind glass. Every prop kind is one instanced draw, however many there are.
 */

const WALL_H = 2.9
/** How low a wall drops when it stands between the camera and what you are looking at. */
const CUT_H = 0.75
const SEGMENT = 3

/** Floor kinds, as the shader numbers them. */
const FLOOR_KIND = { dept: 0, corridor: 1, lobby: 2, ops: 3, servers: 4, archive: 5, break: 6 }

/** Fictional wartime-style posters for the corridors. No real agency, no real slogans. */
const POSTERS = [
  ['LOOSE THREADS', 'SINK SHIPS', '#b23a2e'],
  ['IS IT MERGED?', 'IS IT TESTED?', '#2e5fa8'],
  ['NEED TO KNOW', 'CHECK YOUR THREADS', '#2f7d4f'],
  ['REPORT EVERY', 'ERROR', '#a87a1f'],
  ['QUIET HALLS', 'BUSY DESKS', '#5a3e8c'],
  ['CLEAN DESK', 'CLEAN DIFF', '#37707a'],
]

// ── a tiny kit: boxes and cylinders with vertex colour, merged into one geometry per prop ──

function part(geo, color, x = 0, y = 0, z = 0, ry = 0) {
  geo = geo.index ? geo.toNonIndexed() : geo
  if (ry) geo.rotateY(ry)
  geo.translate(x, y, z)
  const c = new THREE.Color(color)
  const n = geo.attributes.position.count
  const col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3)
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  if (geo.attributes.uv) geo.deleteAttribute('uv')
  return geo
}
const box = (w, h, d, color, x = 0, y = h / 2, z = 0, ry = 0) => part(new THREE.BoxGeometry(w, h, d), color, x, y, z, ry)
const cyl = (rt, rb, h, color, x = 0, y = h / 2, z = 0, seg = 12) => part(new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y, z)
const merge = (parts) => {
  const g = BufferGeometryUtils.mergeGeometries(parts, false)
  g.computeVertexNormals()
  return g
}

/** Every bolted-down thing in the building, as geometry. Units are metres; +z is the front. */
const PROPS = {
  plant: () => merge([cyl(0.22, 0.18, 0.4, 0x6b6f75), part(new THREE.IcosahedronGeometry(0.42, 0), 0x3f7a4a, 0, 0.85, 0), part(new THREE.IcosahedronGeometry(0.3, 0), 0x4f9a5a, 0.15, 1.15, 0.05)]),
  cabinet: () => merge([box(0.5, 1.32, 0.62, 0x8a9096), ...[0.3, 0.62, 0.94, 1.22].map((y) => box(0.44, 0.02, 0.02, 0x40454b, 0, y, 0.315))]),
  confTable: () => merge([box(5.2, 0.06, 1.7, 0x5a3b2a, 0, 0.74), box(0.1, 0.72, 1.2, 0x2b2f35, -2, 0.36), box(0.1, 0.72, 1.2, 0x2b2f35, 2, 0.36), box(1.2, 0.02, 0.4, 0x1c1f24, 0, 0.78)]),
  chair: () => merge([box(0.5, 0.08, 0.5, 0x23272d, 0, 0.46), box(0.5, 0.6, 0.07, 0x23272d, 0, 0.8, 0.22), cyl(0.04, 0.04, 0.42, 0x50555c, 0, 0.21), cyl(0.28, 0.28, 0.04, 0x50555c, 0, 0.02)]),
  rack: () => merge([box(0.62, 2.05, 1.05, 0x15181c), box(0.58, 1.9, 0.02, 0x0b0d10, 0, 1.03, 0.53), box(0.62, 0.06, 1.05, 0x2b3038, 0, 2.08)]),
  crac: () => merge([box(1.8, 2.0, 0.9, 0xd6d9dd), box(1.5, 0.6, 0.02, 0x8c939b, 0, 1.4, 0.46)]),
  shelving: () => {
    const parts = [0, 0.55, 1.1, 1.65, 2.15].map((y) => box(2.4, 0.04, 0.62, 0x9aa1a8, 0, y + 0.02))
    for (const x of [-1.18, 1.18]) for (const z of [-0.29, 0.29]) parts.push(box(0.04, 2.2, 0.04, 0x6b7179, x, 1.1, z))
    return merge(parts)
  },
  evidenceBox: () => merge([box(0.44, 0.3, 0.34, 0xb08a5a), box(0.2, 0.08, 0.005, 0xf2efe6, 0, 0.16, 0.172)]),
  lockers: () => {
    const parts = [box(3.2, 2.1, 0.5, 0x6d7f8c)]
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) parts.push(box(0.74, 0.62, 0.01, 0x5c6c78, -1.2 + i * 0.8, 0.4 + j * 0.68, 0.255))
    return merge(parts)
  },
  counter: () => merge([box(2.6, 1.05, 0.7, 0x7a8590), box(2.7, 0.05, 0.8, 0xc9ccd0, 0, 1.08)]),
  elevator: () =>
    merge([
      box(3.0, WALL_H, 2.2, 0x8f979f, 0, WALL_H / 2, -0.2),
      box(1.5, 2.25, 0.02, 0x2b3038, 0, 1.125, 0.91),
      box(0.12, 0.2, 0.03, 0xd8d0b0, 1.05, 1.2, 0.92),
      box(3.0, 0.3, 0.05, 0x3b4048, 0, 2.55, 0.92),
    ]),
  door: () => box(0.68, 2.22, 0.06, 0xb7bdc3, 0, 1.11),
  securityDesk: () => merge([box(3.0, 1.05, 0.7, 0x3b4654), box(0.7, 1.05, 1.6, 0x3b4654, -1.15, 0.525, 0.45), box(3.1, 0.05, 0.8, 0x9aa3ad, 0, 1.08), box(0.55, 0.35, 0.04, 0x10141a, 0.6, 1.32, -0.1), box(0.55, 0.35, 0.04, 0x10141a, -0.2, 1.32, -0.1)]),
  arch: () => merge([box(0.12, 2.15, 0.6, 0xc4c9ce, -0.5, 1.075), box(0.12, 2.15, 0.6, 0xc4c9ce, 0.5, 1.075), box(1.12, 0.14, 0.6, 0xc4c9ce, 0, 2.2)]),
  turnstile: () => merge([box(0.22, 1.0, 1.0, 0x9aa1a8, 0, 0.5), box(0.6, 0.04, 0.04, 0x50555c, 0.4, 0.95, 0)]),
  bench: () => merge([box(1.8, 0.06, 0.45, 0x6a4b35, 0, 0.45), box(0.08, 0.45, 0.4, 0x3b3f45, -0.8, 0.22), box(0.08, 0.45, 0.4, 0x3b3f45, 0.8, 0.22)]),
  couch: () => merge([box(2.0, 0.42, 0.85, 0x3c5a7a, 0, 0.21), box(2.0, 0.5, 0.2, 0x34506e, 0, 0.67, -0.32), box(0.2, 0.3, 0.85, 0x34506e, -0.9, 0.55), box(0.2, 0.3, 0.85, 0x34506e, 0.9, 0.55)]),
  roundTable: () => merge([cyl(0.5, 0.5, 0.04, 0xd7d2c8, 0, 0.74, 0, 20), cyl(0.05, 0.05, 0.72, 0x50555c, 0, 0.36), cyl(0.3, 0.3, 0.03, 0x50555c, 0, 0.015)]),
  stool: () => merge([cyl(0.18, 0.18, 0.05, 0x8a5a3a, 0, 0.48), cyl(0.03, 0.03, 0.46, 0x50555c, 0, 0.23)]),
  vending: () => merge([box(0.95, 1.85, 0.8, 0x24364f), box(0.6, 1.3, 0.02, 0x0d1520, -0.1, 1.05, 0.41), box(0.18, 0.5, 0.02, 0x9aa1a8, 0.33, 1.1, 0.41)]),
  coffee: () => merge([box(1.4, 0.9, 0.6, 0x6a4b35), box(1.5, 0.05, 0.7, 0xc9ccd0, 0, 0.92), box(0.42, 0.55, 0.38, 0x1f2227, -0.3, 1.22), cyl(0.05, 0.05, 0.1, 0xffffff, 0.3, 0.99)]),
  cooler: () => merge([box(0.34, 1.0, 0.34, 0xe9ecef), cyl(0.15, 0.15, 0.38, 0x9cc8ee, 0, 1.19)]),
  printer: () => merge([box(0.62, 0.95, 0.55, 0xdadde1), box(0.5, 0.06, 0.3, 0x40454b, 0, 0.98, 0.1)]),
  extinguisher: () => merge([cyl(0.08, 0.08, 0.5, 0xc0392b, 0, 0.75), box(0.32, 0.6, 0.04, 0xeeeeee, 0, 0.8, -0.06)]),
  frame: () => merge([box(0.14, 2.3, WALL + 0.06, 0x5c636b, -DOOR / 2 - 0.07, 1.15), box(0.14, 2.3, WALL + 0.06, 0x5c636b, DOOR / 2 + 0.07, 1.15), box(DOOR + 0.28, 0.16, WALL + 0.06, 0x5c636b, 0, 2.38)]),
  reader: () => merge([box(0.12, 0.18, 0.04, 0x1d2126), box(0.05, 0.02, 0.005, 0x39d98a, 0, 0.13, 0.022)]),
}

export class Facility {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.group = new THREE.Group()
    scene.add(this.group)
    this.signature = ''
    this.obstacles = []
    this.screens = {}
    this.boardSlots = []
    this.uniforms = {
      uCam: { value: new THREE.Vector3() },
      uFocus: { value: new THREE.Vector3() },
      uCut: { value: 16 },
      uActivity: { value: 0.3 },
    }
    this._materials()
  }

  _materials() {
    const vertexColors = true
    this.propMaterial = patchLab(new THREE.MeshStandardMaterial({ vertexColors, roughness: 0.62, metalness: 0.15 }), { key: 'prop' }).material

    // Walls drop to waist height when they stand between the camera and the point it orbits —
    // the Sims cutaway — so a room can always be seen into without taking the walls away.
    const cut = {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        uniform vec3 uCam;
        uniform vec3 uFocus;
        uniform float uCut;
        attribute float aHeight;
        varying float vTop;
      `,
      vertex: /* glsl */ `
        {
          vec3 c = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          vec2 view = normalize(uFocus.xz - uCam.xz + vec2(1e-4));
          vec2 d = c.xz - uFocus.xz;
          float front = -dot(d, view);
          float side = abs(dot(d, vec2(-view.y, view.x)));
          float lowered = smoothstep(-2.5, 1.0, front) * (1.0 - smoothstep(uCut * 0.75, uCut, side)) * (1.0 - smoothstep(uCut * 1.2, uCut * 1.6, front));
          float top = position.y > 0.0 ? 1.0 : 0.0;
          float lowY = ${CUT_H.toFixed(2)} / aHeight - 0.5;
          transformed.y = mix(transformed.y, mix(position.y, lowY, lowered), top);
          vTop = step(0.9, normal.y);
        }
      `,
      fragmentPars: /* glsl */ `varying float vTop;`,
    }
    this.wallMaterial = patchLab(new THREE.MeshStandardMaterial({ color: 0x9da3aa, roughness: 0.85 }), {
      ...cut,
      key: 'wall',
      fragmentColor: /* glsl */ `
        // A darker skirting at the foot, and the cut top reads as a wall's thickness.
        diffuseColor.rgb *= mix(1.0, 0.55, step(vLabWorld.y, 0.12));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.18, 0.21), vTop);
      `,
    })
    this.glassMaterial = patchLab(
      new THREE.MeshPhysicalMaterial({ color: 0x9fc3d6, roughness: 0.08, metalness: 0, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false }),
      { ...cut, key: 'glass', pools: 0 }
    )

    // One floor for the whole facility; each room kind gets its own surface in the shader.
    this.floorMaterial = patchLab(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }), {
      key: 'floor',
      vertexPars: /* glsl */ `attribute float aKind; varying float vKind;`,
      vertex: /* glsl */ `vKind = aKind;`,
      fragmentPars: /* glsl */ `
        varying float vKind;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      `,
      fragmentColor: /* glsl */ `
        {
          vec2 p = vLabWorld.xz;
          vec3 col;
          float k = vKind;
          if (k < 0.5) {
            // Department: carpet tiles, quarter-turned, in a dark blue-grey.
            vec2 t = floor(p / 0.6);
            float n = h21(t) * 0.08 + h21(floor(p * 9.0)) * 0.05;
            col = vec3(0.19, 0.23, 0.29) + n;
          } else if (k < 1.5) {
            // Corridor: polished concrete, and a wayfinding stripe down the middle of the run.
            float n = h21(floor(p * 3.0)) * 0.04;
            col = vec3(0.36, 0.37, 0.38) + n;
            vec2 local = abs(fract(p / ${ROOM.toFixed(1)} + 0.5) - 0.5) * ${ROOM.toFixed(1)};
            float stripe = (1.0 - smoothstep(0.08, 0.12, local.x)) + (1.0 - smoothstep(0.08, 0.12, local.y));
            col = mix(col, vec3(0.83, 0.65, 0.18), clamp(stripe, 0.0, 1.0) * 0.8);
          } else if (k < 2.5) {
            // Lobby: large stone slabs.
            vec2 t = floor(p / 1.5);
            vec2 g = abs(fract(p / 1.5) - 0.5);
            col = vec3(0.5, 0.48, 0.45) + h21(t) * 0.05;
            col *= 1.0 - (1.0 - smoothstep(0.47, 0.5, max(g.x, g.y))) * 0.0 - smoothstep(0.485, 0.5, max(g.x, g.y)) * 0.25;
          } else if (k < 3.5) {
            // Operations: a deep carpet, darker than the departments.
            col = vec3(0.13, 0.15, 0.2) + h21(floor(p * 7.0)) * 0.04;
          } else if (k < 4.5) {
            // Server room: raised floor tiles, perforated down the cold aisles.
            vec2 g = abs(fract(p / 0.6) - 0.5);
            col = vec3(0.46, 0.48, 0.5) - smoothstep(0.47, 0.5, max(g.x, g.y)) * 0.2;
            float cold = step(0.5, fract(p.x / 3.0));
            vec2 holes = abs(fract(p / 0.06) - 0.5);
            col -= cold * (1.0 - smoothstep(0.15, 0.25, length(holes))) * 0.18;
          } else if (k < 5.5) {
            // Archive: plain grey vinyl.
            col = vec3(0.34, 0.35, 0.36) + h21(floor(p * 2.0)) * 0.03;
          } else {
            // Break room: warm wood planks.
            float plank = floor(p.x / 0.2);
            col = vec3(0.55, 0.38, 0.24) * (0.85 + h21(vec2(plank, floor(p.y / 1.4 + plank * 0.37))) * 0.3);
          }
          diffuseColor.rgb = col;
        }
      `,
    }).material
  }

  /** Rebuild the building for a plan. Returns false when nothing changed. */
  setPlan(plan) {
    const signature = JSON.stringify([...plan.all.values()].map((c) => [c.q, c.r, c.kind, c.project || '']))
    if (signature === this.signature) return false
    this.signature = signature
    this.plan = plan
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      child.geometry?.dispose?.()
    }
    this.obstacles = []
    this.screens = {}
    this.boardSlots = []
    this._floors(plan)
    this._walls(plan)
    this._doors(plan)
    this._rooms(plan)
    return true
  }

  _floors(plan) {
    const parts = []
    for (const c of plan.all.values()) {
      const g = new THREE.PlaneGeometry(ROOM, ROOM)
      g.rotateX(-Math.PI / 2)
      const { x, z } = roomCentre(c)
      g.translate(x, 0, z)
      const kind = new Float32Array(g.attributes.position.count).fill(FLOOR_KIND[c.kind] ?? 1)
      g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1))
      g.deleteAttribute('uv')
      parts.push(g)
    }
    const floor = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(parts, false), this.floorMaterial)
    floor.receiveShadow = true
    this.group.add(floor)
  }

  _walls(plan) {
    const solid = []
    const glass = []
    for (const w of plan.walls) {
      const len = w.to - w.from
      const n = Math.max(1, Math.ceil(len / SEGMENT))
      for (let i = 0; i < n; i++) {
        const a = w.from + (len * i) / n
        const b = w.from + (len * (i + 1)) / n
        const mid = (a + b) / 2
        const seg = { x: w.axis === 'x' ? w.x + mid : w.x, z: w.axis === 'z' ? w.z + mid : w.z, len: b - a, axis: w.axis }
        ;(w.glass ? glass : solid).push(seg)
        // Walls block walking, inflated by a body's half-width.
        const r = 0.34
        this.obstacles.push(
          w.axis === 'x'
            ? { x0: seg.x - seg.len / 2 - r, x1: seg.x + seg.len / 2 + r, z0: seg.z - WALL / 2 - r, z1: seg.z + WALL / 2 + r }
            : { x0: seg.x - WALL / 2 - r, x1: seg.x + WALL / 2 + r, z0: seg.z - seg.len / 2 - r, z1: seg.z + seg.len / 2 + r }
        )
      }
    }
    const make = (list, material, height) => {
      if (!list.length) return
      const geo = new THREE.BoxGeometry(1, 1, 1)
      geo.setAttribute('aHeight', new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(height), 1))
      const mesh = new THREE.InstancedMesh(geo, material.material, list.length)
      if (material.depth) mesh.customDepthMaterial = material.depth
      const m = new THREE.Matrix4()
      list.forEach((s, i) => {
        const sx = s.axis === 'x' ? s.len : WALL
        const sz = s.axis === 'z' ? s.len : WALL
        m.compose(new THREE.Vector3(s.x, height / 2, s.z), new THREE.Quaternion(), new THREE.Vector3(sx, height, sz))
        mesh.setMatrixAt(i, m)
      })
      mesh.castShadow = material === this.wallMaterial
      mesh.receiveShadow = true
      this.group.add(mesh)
      return mesh
    }
    this.wallMesh = make(solid, this.wallMaterial, WALL_H)
    this.glassMesh = make(glass, this.glassMaterial, WALL_H)
    if (this.glassMesh) this.glassMesh.renderOrder = 4
    this.wallCount = solid.length + glass.length
  }

  _doors(plan) {
    const frames = []
    const readers = []
    for (const d of plan.doors) {
      const ry = d.axis === 'x' ? 0 : Math.PI / 2
      frames.push({ x: d.x, z: d.z, ry })
      if (d.secure) {
        // A badge reader beside every secure door, on both faces: two checks to get in.
        const off = DOOR / 2 + 0.45
        for (const side of [-1, 1]) {
          const along = d.axis === 'x' ? [d.x + off, d.z + side * (WALL / 2 + 0.03)] : [d.x + side * (WALL / 2 + 0.03), d.z + off]
          readers.push({ x: along[0], z: along[1], y: 1.2, ry: d.axis === 'x' ? (side > 0 ? 0 : Math.PI) : side > 0 ? Math.PI / 2 : -Math.PI / 2 })
        }
      }
    }
    this._place('frame', frames)
    this._place('reader', readers)
  }

  /** Instance a prop kind at a list of { x, z, y?, ry?, s? }, optionally blocking where it stands. */
  _place(kind, list, block = null) {
    if (!list.length) return null
    const geo = PROPS[kind]()
    const mesh = new THREE.InstancedMesh(geo, this.propMaterial, list.length)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.ry || 0)
      const s = p.s || 1
      m.compose(new THREE.Vector3(p.x, p.y || 0, p.z), q, new THREE.Vector3(s, s, s))
      mesh.setMatrixAt(i, m)
      if (block) {
        // The footprint, turned with the prop, as an axis-aligned rectangle plus a body's width.
        const hw = ((bb.max.x - bb.min.x) / 2) * s
        const hd = ((bb.max.z - bb.min.z) / 2) * s
        const turned = Math.abs(Math.sin(p.ry || 0)) > 0.7
        const ex = (turned ? hd : hw) + block
        const ez = (turned ? hw : hd) + block
        const cx = p.x + (bb.max.x + bb.min.x) / 2
        const cz = p.z + (bb.max.z + bb.min.z) / 2
        this.obstacles.push({ x0: cx - ex, x1: cx + ex, z0: cz - ez, z1: cz + ez })
      }
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.kind = kind
    this.group.add(mesh)
    return mesh
  }

  _rooms(plan) {
    const B = 0.28 // half a body: what furniture is inflated by for walking
    const lists = {}
    const add = (kind, p, block = true) => {
      ;(lists[kind] ||= { items: [], block }).items.push(p)
    }
    const random = rng('furnishing')

    // ── the lobby ──
    const L = roomCentre(FACILITY.lobby)
    // Everything keeps clear of the four doorways (north and south ones sit east of centre).
    add('elevator', { x: L.x - 3.6, z: L.z - HALF + 1.3 })
    add('securityDesk', { x: L.x - 3.9, z: L.z + 3.7, ry: Math.PI })
    add('arch', { x: L.x + 0.4, z: L.z + 0.2 }, false)
    add('turnstile', { x: L.x - 1.1, z: L.z + 0.2 })
    add('turnstile', { x: L.x + 1.9, z: L.z + 0.2 })
    add('bench', { x: L.x + 4.9, z: L.z - 3.4, ry: -Math.PI / 2 })
    add('plant', { x: L.x - 1.4, z: L.z - 5.2 })
    add('plant', { x: L.x + 5.3, z: L.z + 5.3 })
    add('extinguisher', { x: L.x + 5.75, z: L.z + 2.5, ry: -Math.PI / 2 }, false)
    this._elevatorDoors(L)
    this._emblem(L)
    this._sign(`${AGENCY.name.toUpperCase()}`, L.x - 3.6, 2.68, L.z - HALF + 2.43, 0, 2.9, 0.22, '#e8dcb5', '#1a2738')

    // ── operations ──
    const O = roomCentre(FACILITY.ops)
    add('confTable', { x: O.x, z: O.z + 0.8 })
    for (const dx of [-1.8, -0.6, 0.6, 1.8]) {
      add('chair', { x: O.x + dx, z: O.z + 0.8 - 1.25, ry: 0 }, false)
      add('chair', { x: O.x + dx, z: O.z + 0.8 + 1.25, ry: Math.PI }, false)
    }
    this.screens.ops = this._screen(O.x, 1.75, O.z - HALF + WALL / 2 + 0.03, 0, 8.4, 2.5, 1024, 305)
    // The case boards: four along each side wall and four on the back wall, flanking the door.
    const bx = HALF - WALL / 2 - 0.04
    for (const z of [-4.2, -2.3, 2.3, 4.2]) this.boardSlots.push({ x: O.x - bx, z: O.z + z, ry: Math.PI / 2 })
    for (const z of [-4.2, -2.3, 2.3, 4.2]) this.boardSlots.push({ x: O.x + bx, z: O.z + z, ry: -Math.PI / 2 })
    // The back wall's door sits east of centre, so its boards hang to the west of it.
    for (const x of [-4.5, -2.7, -0.9, 0.9]) this.boardSlots.push({ x: O.x + x, z: O.z + bx, ry: Math.PI })
    this._sign('OPERATIONS CENTER', O.x, 2.75, O.z - HALF + 0.16, 0, 4.0, 0.3, '#ff6b5e', '#141820')

    // ── server room ──
    const S = roomCentre(FACILITY.servers)
    for (const row of [-3.6, -0.6, 2.4]) {
      for (let i = 0; i < 7; i++) add('rack', { x: S.x - 3.0 + i * 0.65, z: S.z + row, ry: row < 0 ? 0 : Math.PI })
    }
    add('crac', { x: S.x - 4.95, z: S.z - 4.2, ry: Math.PI / 2 })
    add('crac', { x: S.x - 4.95, z: S.z + 4.2, ry: Math.PI / 2 })
    this.rackCount = 21

    // ── evidence archive ──
    const A = roomCentre(FACILITY.archive)
    this.shelves = []
    for (const z of [-3.4, -0.6, 2.2]) {
      for (const x of [-2.6, 0.6]) {
        add('shelving', { x: A.x + x, z: A.z + z })
        this.shelves.push({ x: A.x + x, z: A.z + z })
      }
    }
    // Pass-through lockers built into the east wall, and the intake counter by the south door.
    add('lockers', { x: A.x + HALF - 0.38, z: A.z - 3.4, ry: -Math.PI / 2 }, true)
    add('counter', { x: A.x + 4.75, z: A.z + 2.6, ry: Math.PI / 2 })
    this._sign('EVIDENCE · CHAIN OF CUSTODY', A.x, 2.6, A.z - HALF + 0.16, 0, 4.2, 0.26, '#f2d06b', '#1d1f24')

    // ── break room ──
    const K = roomCentre(FACILITY.break)
    add('coffee', { x: K.x - 3.6, z: K.z - HALF + 0.6 })
    add('vending', { x: K.x - 1.6, z: K.z - HALF + 0.6 })
    add('vending', { x: K.x - 0.55, z: K.z - HALF + 0.6 })
    add('cooler', { x: K.x - 5.3, z: K.z - HALF + 0.5 })
    add('couch', { x: K.x - 3.4, z: K.z + 4.7, ry: Math.PI })
    add('couch', { x: K.x - 0.2, z: K.z + 4.7, ry: Math.PI })
    for (const [x, z] of [[-2.4, 0.4], [2.4, 0.4]]) {
      add('roundTable', { x: K.x + x, z: K.z + z })
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4
        add('stool', { x: K.x + x + Math.cos(a) * 0.8, z: K.z + z + Math.sin(a) * 0.8 }, false)
      }
    }
    this.screens.tv = this._screen(K.x + HALF - WALL / 2 - 0.03, 1.9, K.z + 3.6, -Math.PI / 2, 2.2, 1.24, 512, 288)

    // ── departments and corridors ──
    this.deptScreens = new Map()
    const seenProject = new Set()
    for (const c of plan.cells.values()) {
      if (c.kind !== 'dept') continue
      const { x, z } = roomCentre(c)
      // Corner plants and cabinets along the side walls — kept out of the aisles and doorways.
      add('plant', { x: x - HALF + 0.6, z: z - HALF + 0.6 })
      add('plant', { x: x + HALF - 0.6, z: z + HALF - 0.6 })
      add('cabinet', { x: x - HALF + 0.45, z: z + 3.8, ry: Math.PI / 2 })
      add('cabinet', { x: x - HALF + 0.45, z: z + 4.5, ry: Math.PI / 2 })
      add('printer', { x: x + HALF - 0.5, z: z - 4.2, ry: -Math.PI / 2 })
      // The first room of each department carries its wall screen.
      if (!seenProject.has(c.project)) {
        seenProject.add(c.project)
        const screen = this._screen(x, 1.85, z - HALF + WALL / 2 + 0.03, 0, 4.2, 1.35, 640, 206)
        this.deptScreens.set(c.project, screen)
      }
    }
    let poster = 0
    for (const c of plan.corridors.values()) {
      const { x, z } = roomCentre(c)
      // A poster on a wall that is really there, now and then.
      if (random() < 0.45) {
        const wall = plan.walls.find((w) => w.axis === 'x' && Math.abs(w.x - x) < 0.01 && Math.abs(w.z - (z - HALF)) < 0.01 && w.to - w.from > 3)
        if (wall) {
          const p = POSTERS[poster++ % POSTERS.length]
          this._poster(p, x + (wall.from + wall.to) / 2, 1.6, z - HALF + WALL / 2 + 0.02, 0)
        }
      }
      if (random() < 0.3) add('extinguisher', { x: x - HALF + WALL / 2 + 0.1, z: z + 2.4, ry: Math.PI / 2 }, false)
      if (random() < 0.25) add('bench', { x: x + HALF - 0.6, z: z + 2.6, ry: -Math.PI / 2 })
    }

    for (const [kind, { items, block }] of Object.entries(lists)) {
      const mesh = this._place(kind, items, block ? B : null)
      if (kind === 'rack') this.rackMesh = mesh
    }
    this._evidence()
  }

  /** The elevator's two door leaves, slid open by `elevatorOpen`. */
  _elevatorDoors(L) {
    const geo = PROPS.door()
    this.elevatorLeaves = new THREE.InstancedMesh(geo, this.propMaterial, 2)
    this.elevatorBase = [
      [L.x - 3.6 - 0.36, L.z - HALF + 1.3 + 0.94],
      [L.x - 3.6 + 0.36, L.z - HALF + 1.3 + 0.94],
    ]
    this.elevatorOpen = 0
    this.elevatorGoal = 0
    this._syncElevator()
    this.group.add(this.elevatorLeaves)
  }

  _syncElevator() {
    const m = new THREE.Matrix4()
    this.elevatorBase.forEach(([x, z], i) => {
      const dir = i % 2 ? 1 : -1
      m.makeTranslation(x + dir * this.elevatorOpen * 0.62, 0, z)
      this.elevatorLeaves.setMatrixAt(i, m)
    })
    this.elevatorLeaves.instanceMatrix.needsUpdate = true
  }

  /** Someone is coming or going: the elevator opens for a few seconds. */
  ring() {
    this.elevatorGoal = 1
    this._elevatorClose = 3.5
  }

  _emblem(L) {
    const tex = canvasTexture(1024, 1024, (ctx, w, h) => drawEmblem(ctx, w / 2, h / 2, w * 0.46))
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.35, metalness: 0.2 })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.4, 64), mat)
    disc.rotation.x = -Math.PI / 2
    disc.position.set(L.x + 0.4, 0.012, L.z + 3.0)
    disc.receiveShadow = true
    this.group.add(disc)
  }

  _sign(text, x, y, z, ry, w, h, ink, ground) {
    const tex = canvasTexture(1024, Math.round((1024 * h) / w), (ctx, cw, ch) => {
      ctx.fillStyle = ground
      ctx.fillRect(0, 0, cw, ch)
      ctx.fillStyle = ink
      ctx.font = `700 ${ch * 0.62}px ${SIGN_FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, cw / 2, ch / 2 + ch * 0.04, cw * 0.94)
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }))
    mesh.position.set(x, y, z)
    mesh.rotation.y = ry
    this.group.add(mesh)
    return mesh
  }

  _poster([a, b, color], x, y, z, ry) {
    const tex = canvasTexture(256, 360, (ctx, w, h) => {
      ctx.fillStyle = '#efe6d2'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = color
      ctx.fillRect(14, 14, w - 28, h * 0.55)
      drawEmblem(ctx, w / 2, h * 0.3, w * 0.22, { ink: '#efe6d2', ground: color })
      ctx.fillStyle = '#1d1d1d'
      ctx.textAlign = 'center'
      ctx.font = `800 ${w * 0.13}px ${SIGN_FONT}`
      ctx.fillText(a, w / 2, h * 0.7, w * 0.9)
      ctx.fillText(b, w / 2, h * 0.82, w * 0.9)
      ctx.font = `600 ${w * 0.05}px ${SIGN_FONT}`
      ctx.fillText(AGENCY.name.toUpperCase(), w / 2, h * 0.94, w * 0.9)
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.98), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }))
    mesh.position.set(x, y, z)
    mesh.rotation.y = ry
    this.group.add(mesh)
  }

  /** A wall screen: a canvas the page redraws, lit from within so it reads in the dark. */
  _screen(x, y, z, ry, w, h, cw, ch) {
    const tex = canvasTexture(cw, ch, (ctx) => {
      ctx.fillStyle = '#05080c'
      ctx.fillRect(0, 0, cw, ch)
    })
    const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    mesh.position.set(x, y, z)
    mesh.rotation.y = ry
    // A bezel behind it.
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.06), new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.4 }))
    bezel.position.set(0, 0, -0.035)
    mesh.add(bezel)
    this.group.add(mesh)
    return { mesh, texture: tex, w: cw, h: ch }
  }

  /**
   * Evidence boxes on the archive shelves: one per archived thread. A thread that leaves the floor
   * leaves its file behind, so how full the archive is says how much has been closed out.
   */
  _evidence() {
    const slots = []
    for (const s of this.shelves) {
      for (let level = 0; level < 4; level++) {
        for (let i = 0; i < 5; i++) slots.push({ x: s.x - 0.96 + i * 0.48, y: 0.06 + level * 0.55, z: s.z })
      }
    }
    this.evidenceSlots = slots
    const mesh = new THREE.InstancedMesh(PROPS.evidenceBox(), this.propMaterial, slots.length)
    const m = new THREE.Matrix4()
    slots.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z)
      mesh.setMatrixAt(i, m)
    })
    mesh.count = 0
    mesh.castShadow = true
    this.evidenceMesh = mesh
    this.group.add(mesh)
    this.setArchived(this._archived || 0)
  }

  setArchived(n) {
    this._archived = n
    if (this.evidenceMesh) this.evidenceMesh.count = Math.min(n, this.evidenceSlots.length)
  }

  /** How busy the floor is (0..1): the server racks blink faster the more threads are working. */
  setActivity(a) {
    this.uniforms.uActivity.value = a
  }

  update(dt, elapsed, camera, focus) {
    this.uniforms.uCam.value.copy(camera.position)
    this.uniforms.uFocus.value.copy(focus)
    this.uniforms.uCut.value = 12 + camera.position.distanceTo(focus) * 0.22
    if (this.elevatorLeaves) {
      if (this._elevatorClose > 0) {
        this._elevatorClose -= dt
        if (this._elevatorClose <= 0) this.elevatorGoal = 0
      }
      const next = THREE.MathUtils.damp(this.elevatorOpen, this.elevatorGoal, 4, dt)
      if (Math.abs(next - this.elevatorOpen) > 1e-4) {
        this.elevatorOpen = next
        this._syncElevator()
      }
    }
  }
}

/** Server rack fronts: rows of LEDs that blink faster the busier the floor is. */
export function createRackLights(facility) {
  if (!facility.rackMesh) return null
  const count = facility.rackMesh.count
  const per = 24
  const geo = new THREE.PlaneGeometry(0.03, 0.03)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: labUniforms.uTime, uActivity: facility.uniforms.uActivity },
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      varying vec2 vSeed;
      void main() {
        vSeed = aSeed;
        gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uActivity;
      varying vec2 vSeed;
      void main() {
        float rate = 0.6 + uActivity * 9.0;
        float on = step(0.45, fract(sin(floor(uTime * rate * (0.5 + vSeed.x)) * 91.7 + vSeed.y * 311.0) * 4375.5));
        vec3 col = mix(vec3(0.15, 0.9, 0.4), vec3(1.0, 0.65, 0.15), step(0.85, vSeed.y));
        gl_FragColor = vec4(col * (0.3 + on * 2.6), 1.0);
      }
    `,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, count * per)
  const seeds = new Float32Array(count * per * 2)
  const m = new THREE.Matrix4()
  const rm = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const random = rng('rack-lights')
  let n = 0
  for (let i = 0; i < count; i++) {
    facility.rackMesh.getMatrixAt(i, rm)
    rm.decompose(p, q, s)
    for (let j = 0; j < per; j++) {
      const local = new THREE.Vector3(-0.22 + (j % 4) * 0.14, 0.3 + Math.floor(j / 4) * 0.28, 0.545).applyQuaternion(q).add(p)
      m.compose(local, q, s.set(1, 1, 1))
      mesh.setMatrixAt(n, m)
      seeds[n * 2] = random()
      seeds[n * 2 + 1] = random()
      n++
    }
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 2))
  mesh.frustumCulled = false
  facility.group.add(mesh)
  return mesh
}
