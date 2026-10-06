import * as THREE from 'three'

/**
 * Shared light for everything in the facility: the pools under the ceiling fixtures, and the
 * shift. By day every fixture is on; on the night shift the rooms drop to a fraction and what
 * stays lit is what someone is actually using — a working desk's lamp, a screen, the server
 * racks. One set of uniforms, so the whole floor dims together.
 */
export const labUniforms = {
  uTime: { value: 0 },
  /** 1 on the day shift, down to ~0.3 at night. */
  uShift: { value: 1 },
  /** 0 by day, 1 at night: what emissive things use to brighten when the room goes dark. */
  uNight: { value: 0 },
}

/** Ceiling fixtures sit on a 4 m grid; each throws a soft pool on whatever is beneath it. */
export const POOL_GLSL = /* glsl */ `
  float labPool(vec3 w) {
    vec2 f = fract(w.xz / 4.0 + 0.5) - 0.5;
    float pool = 1.0 - smoothstep(0.08, 0.62, length(f));
    // Fades with height: the floor gets the full pool, the top of a cabinet a little.
    return pool * (1.0 - smoothstep(0.0, 2.6, w.y) * 0.6);
  }
`

/**
 * Patch a standard material with the facility light, plus whatever the caller injects — the same
 * seams as the reef's patch, and the deformation reaches the shadow pass too.
 */
export function patchLab(material, opts = {}) {
  const uniforms = { ...labUniforms, ...(opts.uniforms || {}) }
  const pools = opts.pools ?? 1
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLabWorld;\n${opts.vertexPars || ''}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${opts.normal || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertex || ''}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          vLabWorld = (modelMatrix * wp).xyz;
        }`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uShift;
        uniform float uNight;
        varying vec3 vLabWorld;
        ${POOL_GLSL}
        ${opts.fragmentPars || ''}`
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${opts.fragmentColor || ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.emissive || ''}`)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // The fixtures' pools ride on top of the general light, and everything dims on the
          // night shift.
          float pool = labPool(vLabWorld) * ${pools.toFixed(3)};
          reflectedLight.directDiffuse += diffuseColor.rgb * pool * 0.28 * uShift;
          reflectedLight.directDiffuse *= mix(0.35, 1.0, uShift);
          reflectedLight.indirectDiffuse *= mix(0.45, 1.0, uShift);
        }`
      )
  }
  material.customProgramCacheKey = () => `lab:${opts.key || 'default'}`
  if (!opts.vertex && !opts.vertexPars) return { material, depth: null }
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${opts.vertexPars || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertex || ''}`)
  }
  depth.customProgramCacheKey = () => `lab-depth:${opts.key || 'default'}`
  return { material, depth }
}

/** A canvas texture, sRGB, mipmapped — for signs, screens and boards. */
export function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  draw(ctx, width, height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  texture.userData.canvas = canvas
  texture.userData.redraw = (fn) => {
    fn(ctx, width, height)
    texture.needsUpdate = true
  }
  return texture
}

/** The facility's typefaces: a condensed sans for signage, a mono for screens. */
export const SIGN_FONT = `"Arial Narrow", "Helvetica Neue", Arial, sans-serif`
export const MONO_FONT = `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`

/** The agency is fictional. Its emblem and name are drawn here and nowhere copy a real one. */
export const AGENCY = { short: 'DTO', name: 'Directorate of Thread Operations', motto: 'Every thread accounted for' }

/** Draw the (fictional) agency emblem: a ringed seal with a stylised knot of threads. */
export function drawEmblem(ctx, cx, cy, r, { ink = '#d9c48a', ground = '#13233a' } = {}) {
  ctx.save()
  ctx.fillStyle = ground
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = r * 0.05
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.94, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = r * 0.02
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2)
  ctx.stroke()
  // Lettering round the ring.
  ctx.fillStyle = ink
  ctx.font = `700 ${r * 0.13}px ${SIGN_FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const text = `${AGENCY.name.toUpperCase()} · ${AGENCY.motto.toUpperCase()} · `
  const step = (Math.PI * 2) / text.length
  for (let i = 0; i < text.length; i++) {
    const a = -Math.PI / 2 + i * step
    ctx.save()
    ctx.translate(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82)
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(text[i], 0, 0)
    ctx.restore()
  }
  // The knot: three interlaced loops, one per kind of thread state that matters.
  ctx.lineWidth = r * 0.06
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2
    ctx.beginPath()
    ctx.ellipse(cx + Math.cos(a) * r * 0.2, cy + Math.sin(a) * r * 0.2, r * 0.34, r * 0.16, a, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.font = `800 ${r * 0.2}px ${SIGN_FONT}`
  ctx.fillText(AGENCY.short, cx, cy + r * 0.5)
  ctx.restore()
}

/** Deterministic PRNG and hash, shared with the reef so a thread looks the same in every world. */
export { rng, hash } from '../reef/shading.js'
