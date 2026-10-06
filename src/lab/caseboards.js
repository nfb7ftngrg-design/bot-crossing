import * as THREE from 'three'
import { canvasTexture, SIGN_FONT, MONO_FONT } from './look.js'
import { PRIORITY_LABEL, ordered } from './cases.js'

/**
 * The case boards: one corkboard per case on the operations room walls. Each carries an index
 * card with the case, a priority stamp, a polaroid of every worker on it — drawn in their own
 * clothes — and red string from the case card to each of them. A closed case is stamped CLOSED.
 *
 * Boards are textures redrawn only when what is on them changes, so twelve boards cost nothing
 * from one frame to the next.
 */

const W = 640
const H = 480
const STATE_INK = { waiting: '#e7a91c', blocked: '#d8483c', working: '#3a9be0', celebrating: '#2fae6a', idle: '#8fb8ac', sleeping: '#8090a4' }
const STAMP = { urgent: '#1b1b1f', priority: '#21497f', routine: '#5b6068' }

export class CaseBoards {
  constructor(group) {
    this.group = group
    this.boards = []
    this.signatures = []
  }

  /** Hang a board in each slot the operations room offers. */
  setSlots(slots) {
    for (const b of this.boards) {
      this.group.remove(b.mesh)
      b.texture.dispose()
    }
    this.boards = slots.map((slot, i) => {
      const texture = canvasTexture(W, H, (ctx) => drawEmpty(ctx))
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.125), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.92 }))
      mesh.position.set(slot.x, 1.55, slot.z)
      mesh.rotation.y = slot.ry
      // A wooden frame behind the cork.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.22, 0.04), new THREE.MeshStandardMaterial({ color: 0x5a3b26, roughness: 0.7 }))
      frame.position.z = -0.025
      mesh.add(frame)
      mesh.userData.board = i
      this.group.add(mesh)
      return { mesh, texture, caseId: null }
    })
    this.signatures = this.boards.map(() => '')
  }

  /**
   * Put the cases up. `people` maps thread id → { title, status, look } for whoever is on a case.
   * Returns how many cases did not fit on the walls.
   */
  update(cases, people) {
    const list = ordered(cases)
    this.boards.forEach((board, i) => {
      const c = list[i]
      board.caseId = c ? c.id : null
      const crew = c ? c.assigned.map((id) => ({ id, ...(people.get(id) || { title: 'Off the floor', status: 'gone' }) })) : []
      const signature = c ? JSON.stringify([c.title, c.priority, c.status, crew.map((p) => [p.id, p.title, p.status])]) : ''
      if (signature === this.signatures[i]) return
      this.signatures[i] = signature
      board.texture.userData.redraw((ctx) => (c ? drawCase(ctx, c, crew) : drawEmpty(ctx)))
    })
    return Math.max(0, list.length - this.boards.length)
  }

  /** The case on a board mesh, for clicks. */
  caseAt(mesh) {
    const i = mesh?.userData?.board
    return i === undefined ? null : this.boards[i]?.caseId
  }

  get meshes() {
    return this.boards.map((b) => b.mesh)
  }
}

// ── drawing ─────────────────────────────────────────────────────────────────────────────

function cork(ctx) {
  ctx.fillStyle = '#b98a57'
  ctx.fillRect(0, 0, W, H)
  // Speckle, seeded so the board is the same every redraw.
  let seed = 7
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = r() < 0.5 ? 'rgba(90,55,25,0.35)' : 'rgba(230,190,140,0.35)'
    ctx.fillRect(r() * W, r() * H, 1 + r() * 2.5, 1 + r() * 2.5)
  }
}

function drawEmpty(ctx) {
  cork(ctx)
  ctx.fillStyle = 'rgba(60,35,15,0.35)'
  ctx.font = `700 28px ${SIGN_FONT}`
  ctx.textAlign = 'center'
  ctx.fillText('NO CASE ON THIS BOARD', W / 2, H / 2)
}

function pin(ctx, x, y, color = '#c0392b') {
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.beginPath()
  ctx.arc(x + 2, y + 3, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.beginPath()
  ctx.arc(x - 2, y - 2, 2.4, 0, Math.PI * 2)
  ctx.fill()
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = w
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** A head-and-shoulders portrait in the person's own colours. */
function portrait(ctx, x, y, w, h, look) {
  ctx.fillStyle = '#9fb3c4'
  ctx.fillRect(x, y, w, h)
  const hex = (n) => `#${n.toString(16).padStart(6, '0')}`
  ctx.fillStyle = hex(look?.shirt ?? 0x333a44)
  ctx.beginPath()
  ctx.ellipse(x + w / 2, y + h, w * 0.42, h * 0.38, 0, Math.PI, 0)
  ctx.fill()
  ctx.fillStyle = hex(look?.skin ?? 0xe0ac86)
  ctx.beginPath()
  ctx.ellipse(x + w / 2, y + h * 0.46, w * 0.2, h * 0.24, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = hex(look?.hair ?? 0x2c2420)
  ctx.beginPath()
  ctx.ellipse(x + w / 2, y + h * 0.3, w * 0.21, h * 0.11, 0, Math.PI, 0)
  ctx.fill()
}

function drawCase(ctx, c, crew) {
  cork(ctx)
  const closed = c.status === 'closed'
  // The case card, top left.
  const card = { x: 26, y: 30, w: 270, h: 170 }
  ctx.save()
  ctx.translate(card.x + card.w / 2, card.y + card.h / 2)
  ctx.rotate(-0.02)
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.fillRect(-card.w / 2 + 4, -card.h / 2 + 5, card.w, card.h)
  ctx.fillStyle = '#f7f3e8'
  ctx.fillRect(-card.w / 2, -card.h / 2, card.w, card.h)
  ctx.strokeStyle = 'rgba(80,120,190,0.35)'
  ctx.lineWidth = 1
  for (let ly = -card.h / 2 + 46; ly < card.h / 2; ly += 20) {
    ctx.beginPath()
    ctx.moveTo(-card.w / 2 + 8, ly)
    ctx.lineTo(card.w / 2 - 8, ly)
    ctx.stroke()
  }
  ctx.fillStyle = '#16181c'
  ctx.font = `600 13px ${MONO_FONT}`
  ctx.fillText(`CASE ${c.id.slice(-6).toUpperCase()}`, -card.w / 2 + 12, -card.h / 2 + 20)
  ctx.font = `700 22px ${SIGN_FONT}`
  const lines = wrap(ctx, c.title, card.w - 24).slice(0, 3)
  lines.forEach((l, i) => ctx.fillText(l, -card.w / 2 + 12, -card.h / 2 + 62 + i * 24))
  ctx.font = `500 13px ${SIGN_FONT}`
  ctx.fillStyle = '#4a4f57'
  const brief = wrap(ctx, c.brief || '', card.w - 24).slice(0, 2)
  brief.forEach((l, i) => ctx.fillText(l, -card.w / 2 + 12, -card.h / 2 + 62 + lines.length * 24 + 6 + i * 16))
  ctx.restore()
  pin(ctx, card.x + card.w / 2, card.y + 6)

  // The priority stamp.
  ctx.save()
  ctx.translate(card.x + card.w - 40, card.y + card.h + 28)
  ctx.rotate(-0.12)
  ctx.strokeStyle = STAMP[c.priority]
  ctx.fillStyle = STAMP[c.priority]
  ctx.lineWidth = 4
  ctx.font = `800 24px ${SIGN_FONT}`
  const label = PRIORITY_LABEL[c.priority].toUpperCase()
  const tw = ctx.measureText(label).width
  ctx.strokeRect(-tw / 2 - 10, -20, tw + 20, 36)
  ctx.textAlign = 'center'
  ctx.fillText(label, 0, 8)
  ctx.restore()

  // Polaroids of the crew, on the right and along the bottom, with string back to the card.
  const spots = [
    [360, 40],
    [500, 40],
    [360, 200],
    [500, 200],
    [60, 300],
    [200, 300],
    [360, 330],
    [500, 330],
  ]
  const from = { x: card.x + card.w / 2, y: card.y + card.h / 2 }
  crew.slice(0, spots.length).forEach((p, i) => {
    const [x, y] = spots[i]
    ctx.strokeStyle = '#b3241b'
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo((from.x + x + 55) / 2, Math.max(from.y, y) + 30, x + 55, y + 8)
    ctx.stroke()
  })
  crew.slice(0, spots.length).forEach((p, i) => {
    const [x, y] = spots[i]
    ctx.save()
    ctx.translate(x + 55, y + 60)
    ctx.rotate(((i * 37) % 9) * 0.012 - 0.05)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(-55 + 3, -60 + 4, 110, 128)
    ctx.fillStyle = '#fbfbf8'
    ctx.fillRect(-55, -60, 110, 128)
    portrait(ctx, -47, -52, 94, 84, p.look)
    ctx.fillStyle = '#1d1f23'
    ctx.font = `600 11px ${SIGN_FONT}`
    const t = wrap(ctx, p.title || 'Untitled', 96).slice(0, 2)
    t.forEach((l, k) => ctx.fillText(l, -48, 46 + k * 12))
    // A status dot in the corner of the photo.
    ctx.fillStyle = STATE_INK[p.status] || '#999'
    ctx.beginPath()
    ctx.arc(38, -40, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    pin(ctx, x + 55, y + 6, '#2e5fa8')
  })
  if (crew.length > spots.length) {
    ctx.fillStyle = '#2a1a0c'
    ctx.font = `700 18px ${SIGN_FONT}`
    ctx.fillText(`+${crew.length - spots.length} more`, 500, 470)
  }
  if (!crew.length) {
    ctx.fillStyle = 'rgba(40,22,8,0.55)'
    ctx.font = `700 22px ${SIGN_FONT}`
    ctx.fillText('NOBODY ASSIGNED YET', 340, 150)
  }
  if (closed) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillRect(0, 0, W, H)
    ctx.save()
    ctx.translate(W / 2, H / 2)
    ctx.rotate(-0.35)
    ctx.strokeStyle = '#1b1b1f'
    ctx.fillStyle = '#1b1b1f'
    ctx.lineWidth = 8
    ctx.font = `900 92px ${SIGN_FONT}`
    ctx.textAlign = 'center'
    ctx.strokeRect(-200, -62, 400, 110)
    ctx.fillText('CLOSED', 0, 22)
    ctx.restore()
  }
}
