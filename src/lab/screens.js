import { roomCentre, ROOM, HALF } from './floorplan.js'
import { SIGN_FONT, MONO_FONT, AGENCY, drawEmblem } from './look.js'

/**
 * What the wall screens show. Each is a canvas redrawn every couple of seconds from the live
 * roster — the operations video wall, every department's own screen, the break-room television.
 * Everything on them is real: counts, names and positions straight from the threads.
 */

const INK = { waiting: '#ffc838', blocked: '#ff5a4a', working: '#5cc8ff', celebrating: '#3fcf86', idle: '#9fd8c8', sleeping: '#7a8fa8' }
const LABEL = { waiting: 'WAITING', blocked: 'BLOCKED', working: 'WORKING', celebrating: 'SHIPPED', idle: 'IDLE', sleeping: 'DORMANT' }
const two = (n) => String(n).padStart(2, '0')

function clock(d, offsetHours = null) {
  const t = offsetHours === null ? d : new Date(d.getTime() + d.getTimezoneOffset() * 60000 + offsetHours * 3600000)
  return `${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`
}

/** The operations video wall: the floor at a glance, the counts, the clocks, who needs you. */
export function drawOps(ctx, w, h, { plan, people, stats, now = new Date() }) {
  ctx.fillStyle = '#04070b'
  ctx.fillRect(0, 0, w, h)
  // Panel grid: a video wall is several screens tiled, and the seams show.
  ctx.strokeStyle = '#0d141c'
  ctx.lineWidth = 3
  for (let i = 1; i < 4; i++) {
    ctx.beginPath()
    ctx.moveTo((w / 4) * i, 0)
    ctx.lineTo((w / 4) * i, h)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()

  // Left half: the floor plan with every worker as a dot.
  const mapW = w * 0.5 - 20
  const mapH = h - 40
  const b = plan.bounds
  const scale = Math.min(mapW / (b.maxX - b.minX), mapH / (b.maxZ - b.minZ))
  const ox = 10 + (mapW - (b.maxX - b.minX) * scale) / 2
  const oz = 30 + (mapH - (b.maxZ - b.minZ) * scale) / 2
  const X = (x) => ox + (x - b.minX) * scale
  const Z = (z) => oz + (z - b.minZ) * scale
  ctx.fillStyle = '#5cc8ff'
  ctx.font = `700 14px ${SIGN_FONT}`
  ctx.fillText('FLOOR STATUS — LEVEL B3', 12, 20)
  for (const c of plan.all.values()) {
    const { x, z } = roomCentre(c)
    ctx.fillStyle = c.kind === 'corridor' ? '#0c1620' : c.kind === 'dept' ? '#12283a' : '#1b2230'
    ctx.fillRect(X(x - HALF) + 1, Z(z - HALF) + 1, ROOM * scale - 2, ROOM * scale - 2)
  }
  for (const p of people) {
    ctx.fillStyle = INK[p.status] || '#888'
    const loud = p.status === 'waiting' || p.status === 'blocked'
    ctx.beginPath()
    ctx.arc(X(p.pos.x), Z(p.pos.z), loud ? 4.5 : 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // Right half: tiles of counts, the clocks, and the list of who needs you.
  const rx = w * 0.5 + 16
  const tiles = ['waiting', 'blocked', 'working', 'celebrating']
  tiles.forEach((s, i) => {
    const tx = rx + (i % 2) * ((w * 0.5 - 32) / 2)
    const ty = 14 + Math.floor(i / 2) * 64
    ctx.fillStyle = '#0a1119'
    ctx.fillRect(tx, ty, (w * 0.5 - 40) / 2, 56)
    ctx.fillStyle = INK[s]
    ctx.font = `800 34px ${SIGN_FONT}`
    ctx.fillText(String(stats[s] || 0), tx + 12, ty + 40)
    ctx.font = `700 13px ${SIGN_FONT}`
    ctx.fillText(LABEL[s], tx + 84, ty + 34)
  })
  ctx.font = `600 13px ${MONO_FONT}`
  ctx.fillStyle = '#8fb3cc'
  ctx.fillText(`LOCAL ${clock(now)}   UTC ${clock(now, 0)}`, rx, 168)
  ctx.fillStyle = '#ffc838'
  ctx.font = `700 13px ${SIGN_FONT}`
  ctx.fillText('NEEDS YOU', rx, 194)
  const needs = people.filter((p) => p.status === 'waiting' || p.status === 'blocked').slice(0, 5)
  ctx.font = `500 13px ${MONO_FONT}`
  needs.forEach((p, i) => {
    ctx.fillStyle = INK[p.status]
    const title = (p.thread?.title || 'Untitled').slice(0, 34)
    ctx.fillText(`${p.status === 'waiting' ? '?' : '!'} ${title}`, rx, 214 + i * 17)
    ctx.fillStyle = '#5e7486'
    ctx.fillText((p.project || '').slice(0, 14), rx + 330, 214 + i * 17)
  })
  if (!needs.length) {
    ctx.fillStyle = '#3fcf86'
    ctx.fillText('Nobody is waiting on you.', rx, 214)
  }
}

/** A department's own screen: its name, its counts, and who on it wants you. */
export function drawDept(ctx, w, h, { name, people }) {
  ctx.fillStyle = '#05090e'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#e8eef4'
  ctx.font = `800 36px ${SIGN_FONT}`
  ctx.fillText(name.toUpperCase().slice(0, 26), 18, 46)
  ctx.fillStyle = '#5e7486'
  ctx.font = `600 14px ${SIGN_FONT}`
  ctx.fillText(`${people.length} ON THE FLOOR · ${AGENCY.short} DEPARTMENT`, 18, 70)
  const order = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping']
  let x = 18
  for (const s of order) {
    const n = people.filter((p) => p.status === s).length
    if (!n) continue
    ctx.fillStyle = INK[s]
    ctx.font = `800 30px ${SIGN_FONT}`
    ctx.fillText(String(n), x, 116)
    ctx.font = `700 12px ${SIGN_FONT}`
    ctx.fillText(LABEL[s], x, 134)
    x += 96
  }
  const needs = people.filter((p) => p.status === 'waiting' || p.status === 'blocked').slice(0, 3)
  ctx.font = `500 13px ${MONO_FONT}`
  needs.forEach((p, i) => {
    ctx.fillStyle = INK[p.status]
    ctx.fillText(`${p.status === 'waiting' ? '? WAITING' : '! BLOCKED'}  ${(p.thread?.title || '').slice(0, 44)}`, 18, 160 + i * 16)
  })
}

/** The break-room television: the in-house channel, a seal and a ticker. */
export function drawTv(ctx, w, h, { stats, tick }) {
  ctx.fillStyle = '#0a1830'
  ctx.fillRect(0, 0, w, h)
  drawEmblem(ctx, 70, 90, 54)
  ctx.fillStyle = '#e8dcb5'
  ctx.font = `800 30px ${SIGN_FONT}`
  ctx.fillText(`${AGENCY.short} NEWS`, 140, 86)
  ctx.font = `500 16px ${SIGN_FONT}`
  ctx.fillStyle = '#9fb3c4'
  ctx.fillText('INTERNAL CHANNEL · NOT FOR BROADCAST', 140, 110)
  ctx.fillStyle = '#c0392b'
  ctx.fillRect(0, h - 56, w, 56)
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 20px ${SIGN_FONT}`
  const text = `  ${stats.working || 0} THREADS AT WORK   ·   ${stats.waiting || 0} WAITING ON YOU   ·   ${stats.blocked || 0} BLOCKED   ·   ${stats.celebrating || 0} SHIPPED   ·   ${AGENCY.motto.toUpperCase()}   ·`
  const width = ctx.measureText(text).width
  const off = (tick * 60) % width
  ctx.fillText(text, -off, h - 22)
  ctx.fillText(text, width - off, h - 22)
}
