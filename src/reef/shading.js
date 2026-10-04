import * as THREE from 'three'

/**
 * Light shared by everything that stands in the water: the caustic net the surface throws onto
 * whatever is below it, and the night glow. One set of uniforms, so the sand, the rock, the coral
 * and the fish all ripple with the same light at the same moment.
 */
export const waterUniforms = {
  uTime: { value: 0 },
  /** 0 at night, 1 in full day — how much sun reaches the floor to make caustics with. */
  uDaylight: { value: 1 },
  /** Sun direction, pointing *towards* the sun. Caustics only land on faces turned up into it. */
  uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2).normalize() },
  uCausticStrength: { value: 1 },
  /** 0 by day, 1 at night: bioluminescence. */
  uNight: { value: 0 },
}

/**
 * The classic warped-tile caustic. Periodic in 2π, so a world-space pattern never shows a seam,
 * and cheap enough to run on every lit fragment in the scene.
 */
export const CAUSTIC_GLSL = /* glsl */ `
  float reefCaustic(vec2 p, float t) {
    vec2 i = p;
    float c = 1.0;
    const float inten = 0.005;
    for (int n = 0; n < 4; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return pow(abs(c), 8.0);
  }
`

/**
 * Patch a standard material (and, optionally, the depth material its shadow is cast with) so it
 * picks up caustics plus whatever vertex deformation the caller injects.
 *
 * The deformation has to reach the shadow pass too. A coral whose unbuilt branches are folded
 * away in colour but not in depth throws the shadow of a finished coral; a fish's tail would beat
 * while its shadow stood still. So `vertex` goes into both, and the caller hands back a pair.
 *
 * @param material   a MeshStandardMaterial
 * @param opts.uniforms  extra uniforms the snippets read
 * @param opts.vertexPars / vertex  GLSL declared before main / run after `begin_vertex`
 * @param opts.normal   GLSL run after `beginnormal_vertex` (may read/modify `objectNormal`)
 * @param opts.fragmentPars / fragmentColor  GLSL; `fragmentColor` runs after `color_fragment`
 * @param opts.emissive  GLSL run after `emissivemap_fragment` (may add to `totalEmissiveRadiance`)
 * @param opts.caustics  multiplier for the caustic light; 0 turns it off
 */
export function patchMaterial(material, opts = {}) {
  const uniforms = { ...waterUniforms, ...(opts.uniforms || {}) }
  const caustics = opts.caustics ?? 1
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vReefWorld;
        varying vec3 vReefNormal;
        ${opts.vertexPars || ''}`
      )
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${opts.normal || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertex || ''}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          vReefWorld = (modelMatrix * wp).xyz;
          vReefNormal = normalize(mat3(modelMatrix) * wn);
        }`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uDaylight;
        uniform vec3 uSunDir;
        uniform float uCausticStrength;
        uniform float uNight;
        varying vec3 vReefWorld;
        varying vec3 vReefNormal;
        ${CAUSTIC_GLSL}
        ${opts.fragmentPars || ''}`
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${opts.fragmentColor || ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.emissive || ''}`)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        if (${caustics.toFixed(3)} > 0.0) {
          // Two samples a hair apart in time and space give the net its soft chromatic edge.
          vec2 cp = vReefWorld.xz * 0.21 + uSunDir.xz * vReefWorld.y * 0.12;
          float k = reefCaustic(mod(cp, 6.2831853), uTime * 0.55);
          k = k * 0.65 + reefCaustic(mod(cp * 1.31 + 1.7, 6.2831853), uTime * 0.43) * 0.35;
          float facing = smoothstep(0.05, 0.85, dot(normalize(vReefNormal), vec3(0.0, 1.0, 0.0)));
          // Deeper water spreads the net out; nothing dances on the shaded side of a shelf.
          float depthFade = clamp(1.0 - max(0.0, 2.0 - vReefWorld.y) * 0.04, 0.6, 1.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.8, 1.0, 0.95)
            * min(k, 1.5) * 0.55 * facing * depthFade * uDaylight * uCausticStrength * ${caustics.toFixed(3)};
        }
        // Water eats red first: everything under it leans blue-green, more so at night.
        vec3 absorb = mix(vec3(0.78, 0.93, 1.0), vec3(0.55, 0.75, 1.0), uNight);
        reflectedLight.directDiffuse *= absorb;
        reflectedLight.indirectDiffuse *= absorb;`
      )
  }
  // Each distinct patch needs its own program, or three hands every patched material the first one.
  material.customProgramCacheKey = () => `reef:${opts.key || 'default'}`

  if (!opts.vertex && !opts.vertexPars) return { material, depth: null }

  // The depth material mirrors the deformation so the shadow moves with the mesh.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${opts.vertexPars || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertex || ''}`)
  }
  depth.customProgramCacheKey = () => `reef-depth:${opts.key || 'default'}`
  return { material, depth }
}

/** Deterministic PRNG, seeded from a string or number. */
export function rng(seed) {
  let h = typeof seed === 'number' ? seed >>> 0 : hash(seed)
  return () => {
    h |= 0
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Smooth value noise, for terrain. */
export function noise2(x, z) {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const xf = x - xi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = zf * zf * (3 - 2 * zf)
  const a = lattice(xi, zi)
  const b = lattice(xi + 1, zi)
  const c = lattice(xi, zi + 1)
  const d = lattice(xi + 1, zi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function lattice(x, z) {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export function fbm(x, z, octaves = 4) {
  let sum = 0
  let amp = 0.5
  let f = 1
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * f, z * f)
    f *= 2.03
    amp *= 0.5
  }
  return sum
}
