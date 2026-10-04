import * as THREE from 'three'
import { CELL, hexToWorld, worldToHex } from '../world/layout.js'
import { HEX_DIRS, SHIP_CELL, cellKey } from '../world/plot-move.js'
import { patchMaterial, fbm, rng, waterUniforms } from './shading.js'

/**
 * The floor: one heightfield for sand, shelves and the channels between them, rebuilt only when
 * a territory's footprint changes. A repo's shelf stands on exactly the hex cells its colony plot
 * holds, and is raised only along edges that face somebody else — a repo spread over five cells
 * reads as one continuous reef, not five tables pushed together.
 */

export const SHELF_TOP = 1.6
const EXTENT = 220
const SEGMENTS = 400
const APOTHEM = (CELL * Math.sqrt(3)) / 2
/** Edge j of a flat-top hex → the neighbour across it (matches plots.js). */
const EDGE_TO_DIR = [0, 5, 4, 3, 2, 1]
const EDGE_NORMALS = [0, 1, 2, 3, 4, 5].map((j) => {
  const a = (Math.PI / 3) * j + Math.PI / 6
  return [Math.cos(a), Math.sin(a)]
})
/** How far in from a foreign edge the shelf reaches full height. */
const CLIFF = 3.2

const SAND = new THREE.Color(0xbfae84)
const SAND_DARK = new THREE.Color(0x9c8c66)
const ROCK = new THREE.Color(0x6e7b6c)
const ROCK_DARK = new THREE.Color(0x46534c)
const ALGAE = new THREE.Color(0x5f8a55)

export class Seabed {
  constructor(scene, settings) {
    this.scene = scene
    this.settings = settings
    this.heights = new Float32Array((SEGMENTS + 1) * (SEGMENTS + 1))
    this.owner = new Map()
    this.signature = ''

    const { material } = patchMaterial(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 }),
      { key: 'seabed' }
    )
    this.material = material
    this.mesh = null

    this.wreck = createWreck()
    const { x, z } = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)
    this.wreck.group.position.set(x, 0, z)
    scene.add(this.wreck.group)
    /** Where fish come out of the wreck and go back into it. */
    this.wreckMouth = new THREE.Vector3(x + 1.6, 1.4, z + 2.2)

    this.kelp = createKelp()
    scene.add(this.kelp.mesh)
  }

  /**
   * Rebuild the floor for this layout. `layout` is Map(project → cells), `accents` is
   * Map(project → THREE.Color). Returns false when nothing moved, which is the usual case.
   */
  setLayout(layout, accents) {
    const signature = JSON.stringify([...layout].map(([n, cells]) => [n, cells.map((c) => [c.q, c.r]), accents.get(n)?.getHex()]))
    if (signature === this.signature) return false
    this.signature = signature

    this.owner = new Map()
    for (const [name, cells] of layout) for (const c of cells) this.owner.set(cellKey(c.q, c.r), name)

    const geo = new THREE.PlaneGeometry(EXTENT, EXTENT, SEGMENTS, SEGMENTS)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    const colors = new Float32Array(pos.count * 3)
    const col = new THREE.Color()
    const wreck = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const { own, dEdge } = this._shelfAt(x, z)
      const sand = this._sand(x, z, wreck)
      let h = sand
      let plateau = 0
      if (own) {
        plateau = smooth(0, CLIFF, dEdge)
        // A rough top, and a rougher cliff face, so a shelf reads as rock rather than a cake.
        const rough = (fbm(x * 0.35, z * 0.35, 3) - 0.5) * 0.5 + (fbm(x * 1.4, z * 1.4, 2) - 0.5) * 0.08 * plateau
        h = sand * (1 - plateau) + (SHELF_TOP + rough) * plateau + (1 - plateau) * plateau * rough * 1.2
      }
      pos.setY(i, h)
      this.heights[i] = h

      // Colour: sand, cliff, rock top, and the project's colour encrusting the rim.
      const grain = fbm(x * 0.6, z * 0.6, 2)
      col.copy(SAND).lerp(SAND_DARK, grain * 0.7)
      if (own) {
        const accent = accents.get(own)
        const top = smooth(0.75, 1, plateau)
        const rock = col.clone().copy(ROCK_DARK).lerp(ROCK, top)
        rock.lerp(ALGAE, top * smooth(0.45, 0.75, fbm(x * 0.25 + 9, z * 0.25, 3)) * 0.6)
        // Rubble and turf: darker speckle and pale sand pockets, so a shelf top reads as reef flat.
        const speck = fbm(x * 3.1 + 4, z * 3.1, 2)
        rock.multiplyScalar(0.82 + speck * 0.36)
        rock.lerp(SAND, top * smooth(0.6, 0.72, fbm(x * 0.5 - 3, z * 0.5 + 8, 3)) * 0.7)
        if (accent) {
          // A band of sponge and encrusting coral where the shelf meets the channel.
          const rim = smooth(0.35, 0.9, plateau) * (1 - smooth(1.5, 3.4, dEdge))
          const speckle = 0.55 + 0.45 * smooth(0.4, 0.6, fbm(x * 2.2, z * 2.2, 2))
          rock.lerp(accent, rim * speckle * 0.75)
        }
        col.lerp(rock, smooth(0.08, 0.4, plateau))
      }
      colors[i * 3] = col.r
      colors[i * 3 + 1] = col.g
      colors[i * 3 + 2] = col.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()

    if (this.mesh) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
    }
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.receiveShadow = true
    this.scene.add(this.mesh)

    this.wreck.group.position.y = this.heightAt(wreck.x, wreck.z) - 0.2
    this.kelp.scatter(this, this.settings.get('scatterDensity'))
    return true
  }

  setDensity(density) {
    this.kelp.scatter(this, density)
  }

  _sand(x, z, wreck) {
    const dunes = (fbm(x * 0.028, z * 0.028, 4) - 0.5) * 1.5
    const warp = fbm(x * 0.09, z * 0.09, 2) * 5
    const ripples = Math.sin(x * 1.1 + z * 0.4 + warp) * 0.045
    const dw = Math.hypot(x - wreck.x, z - wreck.z)
    const scour = -0.5 * Math.exp(-(dw * dw) / 30)
    // The open floor slopes gently away beyond the reef, so the horizon is water, not an edge.
    const r = Math.hypot(x, z)
    const falloff = -Math.max(0, r - 95) * 0.06
    return dunes + ripples + scour + falloff
  }

  /** Which project owns the ground here, and how far it is to an edge facing anybody else. */
  _shelfAt(x, z) {
    const cell = worldToHex(x, z)
    const own = this.owner.get(cellKey(cell.q, cell.r))
    if (!own) return { own: null, dEdge: 0 }
    const c = hexToWorld(cell.q, cell.r)
    const lx = x - c.x
    const lz = z - c.z
    let dEdge = Infinity
    for (let j = 0; j < 6; j++) {
      const dir = HEX_DIRS[EDGE_TO_DIR[j]]
      if (this.owner.get(cellKey(cell.q + dir[0], cell.r + dir[1])) === own) continue
      const n = EDGE_NORMALS[j]
      dEdge = Math.min(dEdge, APOTHEM - (lx * n[0] + lz * n[1]))
    }
    return { own, dEdge: dEdge === Infinity ? CLIFF * 4 : Math.max(0, dEdge) }
  }

  /** Floor height at a world point, bilinear over the heightfield. */
  heightAt(x, z) {
    const step = EXTENT / SEGMENTS
    const fx = (x + EXTENT / 2) / step
    const fz = (z + EXTENT / 2) / step
    const ix = Math.max(0, Math.min(SEGMENTS - 1, Math.floor(fx)))
    const iz = Math.max(0, Math.min(SEGMENTS - 1, Math.floor(fz)))
    const tx = Math.max(0, Math.min(1, fx - ix))
    const tz = Math.max(0, Math.min(1, fz - iz))
    const row = SEGMENTS + 1
    const h = this.heights
    const a = h[iz * row + ix]
    const b = h[iz * row + ix + 1]
    const c = h[(iz + 1) * row + ix]
    const d = h[(iz + 1) * row + ix + 1]
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
  }

  ownerAt(x, z) {
    const cell = worldToHex(x, z)
    return this.owner.get(cellKey(cell.q, cell.r)) || null
  }

  update(dt, night) {
    this.wreck.setNight(night)
  }
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The wreck: a listing hull half sunk in the sand on the colony's ship cell. Its lantern comes on
 * after dark, because the reef is meant to be lit at night rather than only dimmed.
 */
function createWreck() {
  const group = new THREE.Group()
  const { material: wood } = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x5a4434, roughness: 0.9 }), { key: 'wreck' })
  const { material: rust } = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.7, metalness: 0.3 }), { key: 'wreck-rust' })

  // Hull: a lathe profile cut in half, stretched into a boat.
  const profile = []
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    profile.push(new THREE.Vector2(Math.sin(t * Math.PI) * 1.8 + 0.05, (t - 0.5) * 8))
  }
  const hullGeo = new THREE.LatheGeometry(profile, 20, Math.PI * 0.5, Math.PI)
  hullGeo.rotateZ(Math.PI / 2)
  const hull = new THREE.Mesh(hullGeo, wood)
  hull.material.side = THREE.DoubleSide
  hull.scale.set(1, 1.25, 1)
  hull.castShadow = true
  hull.receiveShadow = true
  group.add(hull)

  const deck = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.15, 2.6), wood)
  deck.position.y = 0.2
  deck.castShadow = true
  group.add(deck)

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 6, 8), wood)
  mast.position.set(0.6, 3, 0)
  mast.rotation.z = 0.5
  mast.castShadow = true
  group.add(mast)

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 2), wood)
  cabin.position.set(-2.2, 0.9, 0)
  cabin.castShadow = true
  group.add(cabin)

  const anchor = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.1, 6, 14, Math.PI), rust)
  anchor.position.set(3.6, 0.3, 1.5)
  anchor.rotation.set(Math.PI / 2, 0, 0.4)
  group.add(anchor)

  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0x302010, emissive: 0xffb860, emissiveIntensity: 0 })
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lampMaterial)
  lamp.position.set(-2.2, 1.9, 1.05)
  group.add(lamp)
  const light = new THREE.PointLight(0xffb860, 0, 14, 1.6)
  light.position.copy(lamp.position)
  group.add(light)

  group.rotation.set(0.12, 0.7, 0.32)
  return {
    group,
    setNight(night) {
      const flicker = 0.85 + 0.15 * Math.sin(waterUniforms.uTime.value * 7.3) * Math.sin(waterUniforms.uTime.value * 3.1)
      lampMaterial.emissiveIntensity = night * 6 * flicker
      light.intensity = night * 9 * flicker
    },
  }
}

/**
 * Kelp: tall ribbons swaying in the swell, all in one draw. Planted on open sand in clumps and
 * kept off the shelves, the channels next to them, and the wreck.
 */
function createKelp() {
  const MAX = 700
  const SEG = 10
  const geo = new THREE.PlaneGeometry(0.42, 1, 1, SEG)
  geo.translate(0, 0.5, 0)
  // Taper towards the tip and give it a slight twist so a stand of kelp is not a fence.
  const p = geo.attributes.position
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i)
    p.setX(i, p.getX(i) * (1 - y * 0.55) * (0.8 + Math.sin(y * 9) * 0.2))
  }
  geo.computeVertexNormals()
  const sway = new Float32Array(MAX)
  geo.setAttribute('aSway', new THREE.InstancedBufferAttribute(sway, 1))
  const { material, depth } = patchMaterial(
    new THREE.MeshStandardMaterial({ color: 0x5f8f3a, roughness: 0.6, side: THREE.DoubleSide }),
    {
      key: 'kelp',
      vertexPars: /* glsl */ `
        attribute float aSway;
        uniform float uTime;
      `,
      vertex: /* glsl */ `
        float kh = position.y;
        float bend = kh * kh;
        transformed.x += sin(uTime * 0.9 + aSway * 6.2831) * bend * 0.32;
        transformed.z += cos(uTime * 0.6 + aSway * 9.0) * bend * 0.22;
      `,
      fragmentColor: /* glsl */ `
        diffuseColor.rgb *= 0.55 + 0.45 * smoothstep(0.0, 0.6, vReefWorld.y * 0.12);
      `,
      caustics: 0.6,
    }
  )
  const mesh = new THREE.InstancedMesh(geo, material, MAX)
  mesh.customDepthMaterial = depth
  mesh.castShadow = true
  mesh.count = 0
  mesh.frustumCulled = false

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const v = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const tint = new THREE.Color()
  const wreck = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)
  return {
    mesh,
    scatter(seabed, density) {
      const random = rng('kelp')
      const want = Math.round(MAX * density)
      let n = 0
      for (let tries = 0; n < want && tries < want * 12; tries++) {
        const x = (random() - 0.5) * 170
        const z = (random() - 0.5) * 170
        // Clumped, not sprinkled.
        if (fbm(x * 0.05 + 3, z * 0.05 - 7, 3) < 0.52) continue
        if (Math.hypot(x - wreck.x, z - wreck.z) < 7) continue
        if (nearShelf(seabed, x, z)) continue
        const y = seabed.heightAt(x, z) - 0.1
        const height = 2.5 + random() * 4.5
        v.set(x, y, z)
        q.setFromAxisAngle(up, random() * Math.PI * 2)
        s.set(0.8 + random() * 0.8, height, 1)
        m.compose(v, q, s)
        mesh.setMatrixAt(n, m)
        tint.setHSL(0.2 + random() * 0.07, 0.5 + random() * 0.2, 0.36 + random() * 0.12)
        mesh.setColorAt(n, tint)
        sway[n] = random()
        n++
      }
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      geo.attributes.aSway.needsUpdate = true
      mesh.visible = n > 0
    },
  }
}

function nearShelf(seabed, x, z) {
  for (const [dx, dz] of [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
    if (seabed.ownerAt(x + dx, z + dz)) return true
  }
  return false
}
