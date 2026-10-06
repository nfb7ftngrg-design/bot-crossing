import { createAllocator } from '../world/layout.js'
import { cellKey as key } from '../world/plot-move.js'

/**
 * The lab's floor plan, as pure data — which square of the underground floor belongs to whom,
 * where the walls and doorways are, where every desk stands. Nothing here touches three.js, so
 * the rules that matter (a department keeps its rooms; every room can be walked to; no desk
 * blocks a door) can be checked under node.
 *
 * The facility follows the shape of the real thing at a toy scale. The core is fixed: a lobby
 * with the elevators and a security checkpoint, the operations room with its video wall and the
 * case boards, a server room, an evidence archive, and a break room. Departments — one per
 * project — take rooms around that core, claiming more as they gain threads, through the same
 * stable allocator the colony's plots use: a department keeps its rooms when somebody else
 * grows. Corridors fill the gaps between rooms; beyond them is bedrock.
 */

/** One room module, in metres. */
export const ROOM = 12
/** Half a room: the distance from a room's centre to its walls. */
export const HALF = ROOM / 2
/** Desks in a department room: two rows of three, facing the room's video wall. */
export const DESKS_PER_ROOM = 6
/** A department never takes more rooms than this, however many threads it has. */
const MAX_ROOMS = 9
/** Doorway width, and wall thickness. */
export const DOOR = 2.2
export const WALL = 0.24
/**
 * Doors in walls running east–west sit this far east of the wall's middle, leaving the middle
 * free for each room's screen. Doors in north–south walls stay centred.
 */
export const DOOR_OFFSET = 3.5
export const doorAlong = (axis) => (axis === 'x' ? DOOR_OFFSET : 0)

/** The fixed rooms of the core. Nobody else may claim these cells. */
export const FACILITY = {
  lobby: { q: 0, r: 0, label: 'Lobby · Security' },
  ops: { q: 0, r: -1, label: 'Operations' },
  servers: { q: -1, r: 0, label: 'Server room' },
  archive: { q: 1, r: 0, label: 'Evidence archive' },
  break: { q: 0, r: 1, label: 'Break room' },
}

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]

/** The ring of cells at Chebyshev distance `radius`, walked so the spiral starts beside the core. */
function squareRing(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }]
  const out = []
  for (let q = -radius; q <= radius; q++) out.push({ q, r: -radius })
  for (let r = -radius + 1; r <= radius; r++) out.push({ q: radius, r })
  for (let q = radius - 1; q >= -radius; q--) out.push({ q, r: radius })
  for (let r = radius - 1; r > -radius; r--) out.push({ q: -radius, r })
  return out
}

const manhattan = (a, b) => Math.abs(a.q - b.q) + Math.abs(a.r - b.r)

/** Every department connects to every other through rooms or the core — no islands. */
function connected(out) {
  const cells = new Map()
  for (const [, list] of out) for (const c of list) cells.set(key(c.q, c.r), c)
  if (cells.size < 2) return true
  const core = Object.values(FACILITY).map((c) => key(c.q, c.r))
  const passable = new Set([...cells.keys(), ...core])
  const [start] = cells.keys()
  const seen = new Set([start])
  const queue = [cells.get(start)]
  while (queue.length) {
    const c = queue.pop()
    for (const [dq, dr] of DIRS) {
      const k = key(c.q + dq, c.r + dr)
      if (!passable.has(k) || seen.has(k)) continue
      seen.add(k)
      queue.push({ q: c.q + dq, r: c.r + dr })
    }
  }
  for (const k of core) seen.delete(k)
  return seen.size === cells.size
}

export const roomsNeeded = (threads) => Math.max(1, Math.min(MAX_ROOMS, Math.ceil(threads / DESKS_PER_ROOM)))

/** Departments → rooms, keeping every department where it already is. Same rule as the colony. */
export const allocateRooms = createAllocator({
  dirs: DIRS,
  ring: squareRing,
  distance: manhattan,
  reserved: Object.values(FACILITY),
  poolRings: 10,
  cellsNeeded: roomsNeeded,
  connected,
})

export const roomCentre = (c) => ({ x: c.q * ROOM, z: c.r * ROOM })
export const worldToRoom = (x, z) => ({ q: Math.round(x / ROOM), r: Math.round(z / ROOM) })

/**
 * The six desks of a department room, in room-local metres. Two rows facing north, where the
 * room's video wall hangs. The east and west doorways open into the walkway between the rows,
 * and the north and south ones (off-centre, `DOOR_OFFSET`) onto the aisle between the middle and
 * east desks, so no desk ever stands in a door.
 */
export const DESK_SPOTS = [
  { x: -4, z: -1.6 },
  { x: 0, z: -1.6 },
  { x: 4, z: -1.6 },
  { x: -4, z: 2.6 },
  { x: 0, z: 2.6 },
  { x: 4, z: 2.6 },
]
/** Desk footprint (width along x, depth along z), and where the chair stands behind it. */
export const DESK_SIZE = { w: 1.7, d: 0.85 }
export const CHAIR_BACK = 0.95

/**
 * Where a thread's desk is: the department's `slot`-th desk across its rooms. Past the rooms'
 * own room — a department capped at nine rooms with more threads than desks — extra desks pack
 * into the aisles of the first rooms, offset so they never stack.
 */
export function deskFor(rooms, slot) {
  const room = rooms[Math.floor(slot / DESKS_PER_ROOM) % rooms.length]
  const spot = DESK_SPOTS[slot % DESKS_PER_ROOM]
  const extra = Math.floor(slot / (DESKS_PER_ROOM * rooms.length))
  const c = roomCentre(room)
  const x = c.x + spot.x + (extra ? (extra % 2 ? 2 : -2) : 0)
  const z = c.z + spot.z + (extra ? 2.1 * Math.ceil(extra / 2) - 1 : 0)
  return { x, z, chair: { x, z: z + CHAIR_BACK }, room }
}

/**
 * The whole plan from a department layout (Map project → cells). Returns every cell with its
 * kind, the corridors, the walls (as segments with door gaps cut out), the doorways, and the
 * fixed points people walk to.
 */
export function buildPlan(layout) {
  const cells = new Map()
  for (const [kind, c] of Object.entries(FACILITY)) cells.set(key(c.q, c.r), { q: c.q, r: c.r, kind, label: c.label })
  for (const [project, list] of layout) {
    for (const c of list) cells.set(key(c.q, c.r), { q: c.q, r: c.r, kind: 'dept', project })
  }
  // Corridors: every free square touching a room, diagonals included, so the halls wrap round.
  const corridors = new Map()
  for (const c of [...cells.values()]) {
    for (let dq = -1; dq <= 1; dq++) {
      for (let dr = -1; dr <= 1; dr++) {
        const k = key(c.q + dq, c.r + dr)
        if (!cells.has(k) && !corridors.has(k)) corridors.set(k, { q: c.q + dq, r: c.r + dr, kind: 'corridor' })
      }
    }
  }
  const all = new Map([...cells, ...corridors])

  const same = (a, b) => {
    if (!a || !b) return false
    if (a.kind === 'corridor' && b.kind === 'corridor') return true
    if (a.kind === 'dept' && b.kind === 'dept') return a.project === b.project
    return false
  }

  // Each edge once: east and south of every cell, plus west and north where the neighbour is rock.
  const walls = []
  const doors = []
  const edge = (a, b, axis, x, z) => {
    if (same(a, b)) return
    const solid = !a || !b // facing bedrock: no door
    const kinds = [a?.kind, b?.kind]
    // The operations room and the server room are secure spaces: glass on the corridor side of
    // ops would leak the case boards, so both are solid; a department's wall to a corridor is
    // glass, the way a watch floor looks onto its hall.
    const glass = !solid && kinds.includes('corridor') && kinds.includes('dept')
    const secure = kinds.includes('ops') || kinds.includes('servers') || kinds.includes('archive')
    const len = ROOM
    // A secure room has one way in — from the lobby, past the checkpoint — the way a SCIF keeps
    // a single controlled entrance; every other side is solid, so nobody cuts through the server
    // room on the way to coffee. (The operations room's north wall carries the video wall.)
    const sealed = secure && !kinds.includes('lobby')
    if (solid || sealed) {
      walls.push({ x, z, axis, from: -len / 2, to: len / 2, glass: false })
      return
    }
    const at = doorAlong(axis)
    doors.push({ x: axis === 'x' ? x + at : x, z: axis === 'z' ? z + at : z, axis, secure, between: [a.kind === 'dept' ? a.project : a.kind, b.kind === 'dept' ? b.project : b.kind] })
    walls.push({ x, z, axis, from: -len / 2, to: at - DOOR / 2, glass })
    walls.push({ x, z, axis, from: at + DOOR / 2, to: len / 2, glass })
  }
  for (const c of all.values()) {
    const { x, z } = roomCentre(c)
    edge(c, all.get(key(c.q + 1, c.r)), 'z', x + HALF, z) // east edge runs along z
    edge(c, all.get(key(c.q, c.r + 1)), 'x', x, z + HALF) // south edge runs along x
    if (!all.has(key(c.q - 1, c.r))) edge(null, c, 'z', x - HALF, z)
    if (!all.has(key(c.q, c.r - 1))) edge(null, c, 'x', x, z - HALF)
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const c of all.values()) {
    const { x, z } = roomCentre(c)
    minX = Math.min(minX, x - HALF)
    maxX = Math.max(maxX, x + HALF)
    minZ = Math.min(minZ, z - HALF)
    maxZ = Math.max(maxZ, z + HALF)
  }

  const lobby = roomCentre(FACILITY.lobby)
  const brk = roomCentre(FACILITY.break)
  return {
    cells,
    corridors,
    all,
    walls,
    doors,
    bounds: { minX, maxX, minZ, maxZ },
    points: {
      // Out of the elevator in the lobby's north-west corner; its doors face south.
      elevator: { x: lobby.x - 3.6, z: lobby.z - 2.9 },
      checkpoint: { x: lobby.x + 0.4, z: lobby.z + 0.2 },
      coffee: [
        { x: brk.x - 3.6, z: brk.z - 4.2 },
        { x: brk.x - 1.1, z: brk.z - 4.2 },
        { x: brk.x + 2.4, z: brk.z + 1.7 },
      ],
    },
  }
}

/** Which room kind a world point is in — `dept`, a facility room, `corridor`, or null (rock). */
export function kindAt(plan, x, z) {
  const c = worldToRoom(x, z)
  return plan.all.get(key(c.q, c.r)) || null
}
