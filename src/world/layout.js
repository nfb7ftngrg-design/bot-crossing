import { HEX_DIRS, SHIP_CELL, ORIGIN, POOL_RINGS, cellKey as key, hexDistance, isConnected } from './plot-move.js'

/**
 * Where each project's zone sits on the hex lattice — the layout rule, on its own.
 *
 * Split out of plots.js so it can run without a document: the colony and the reef both draw
 * their territories from this one allocator and the same saved cells, which is what lets a
 * repo hold the same ground in either world, and it is the piece worth testing under bare node.
 */

/** Hex size, centre to corner. Cells tile exactly at this radius. */
export const CELL = 7.6
/** Building slots per cell: one in the middle and six around it. */
export const SLOTS_PER_CELL = 7
const MAX_CELLS = 9

/** Flat-top axial hex → world. */
export function hexToWorld(q, r, size = CELL) {
  return { x: size * 1.5 * q, z: size * Math.sqrt(3) * (r + q / 2) }
}

/**
 * The inverse: which cell a world point falls in. Exact rather than nearest-centre, because
 * it decides whether something is standing on a plot's raised deck or on bare ground, and a
 * radius test would put an astronaut on a deck it is not actually over.
 */
export function worldToHex(x, z, size = CELL) {
  const q = x / (size * 1.5)
  const r = z / (size * Math.sqrt(3)) - q / 2
  return cubeRound(q, r)
}

/** Round fractional axial coordinates to the cell that actually contains the point. */
function cubeRound(q, r) {
  const y = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const ry = Math.round(y)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const dy = Math.abs(ry - y)
  // Whichever axis drifted furthest is the one recomputed from the other two.
  if (dq > dr && dq > dy) rq = -rr - ry
  else if (dr > dy) rr = -rq - ry
  return { q: rq, r: rr }
}

function hexRing(radius) {
  if (radius === 0) return [{ q: 0, r: 0 }]
  const out = []
  let q = HEX_DIRS[4][0] * radius
  let r = HEX_DIRS[4][1] * radius
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      out.push({ q, r })
      q += HEX_DIRS[i][0]
      r += HEX_DIRS[i][1]
    }
  }
  return out
}

const cellsNeeded = (threadCount) =>
  Math.max(1, Math.min(MAX_CELLS, Math.ceil(threadCount / SLOTS_PER_CELL)))

/**
 * Hand out cells to projects, keeping every zone exactly where it already is.
 *
 * This used to be a pure function of the size list, and that was the bug: one thread
 * appearing anywhere changed the order, the order decided the cells, and the whole colony
 * re-laid itself out. A zone you were watching could jump to the far side of the map
 * because a *different* repo gained a session, which makes the place impossible to learn.
 *
 * So the previous layout is an input. A zone that still needs the same number of cells
 * keeps precisely the cells it had; one that grew keeps them and claims neighbours; one
 * that shrank drops the cells it claimed most recently. Only a repo that has never been
 * placed is placed at all, and it takes the innermost cells still free — which is what
 * keeps the busy middle busy.
 *
 * Each list is ordered root-first and growth appends, so a shrink is a slice, and
 * grow-then-shrink puts a zone back in exactly the shape it started in.
 *
 * Contiguity still comes from a flood fill: slicing runs out of a hex spiral looks like it
 * would work and does not, because the last cell of one ring and the first of the next sit
 * on opposite sides of the colony.
 *
 * @param projects [{ id, size }], biggest first — the order only decides who gets the
 *   innermost seed among repos that are *new*.
 * @param previous Map of id → cells from the last pass (or a saved colony file).
 * @returns Map of id → cells.
 */
export function allocateCells(projects, previous = new Map()) {
  const laid = layOut(projects, previous)
  // Remembering where a zone sat is worth a great deal, right up until it leaves the colony
  // as scattered islands. Then the memory is describing a map that no longer exists, and
  // starting over — compact, from the middle, the way a first run does it — is the lesser
  // upheaval. It only happens when the alternative is visibly broken.
  return isConnected(laid) ? laid : layOut(projects, new Map())
}

function layOut(projects, previous) {
  const reserved = key(SHIP_CELL.q, SHIP_CELL.r)
  // Shrinking has hysteresis. A zone sitting exactly on a cell boundary would otherwise
  // hand a tile back the moment one thread is archived and claim it again when the next
  // one starts — and every hand-back rebuilds the plot and walks its whole crew. A tile is
  // only returned once the repo has lost a few threads past the line.
  const wanted = projects.map((p) => {
    const before = previous.get(p.id)
    let want = cellsNeeded(p.size)
    if (before && before.length > want) want = Math.min(before.length, cellsNeeded(p.size + 3))
    return { id: p.id, want }
  })
  const total = wanted.reduce((n, w) => n + w.want, 0)

  // Spiral order decides where a *new* project settles. The pool runs past what is needed
  // so there is always somewhere to grow into.
  const pool = []
  const free = new Set()
  // The pool has to reach every cell anybody *remembers*, not merely as far as today's
  // colony needs. Sized from `total` alone, a zone that has sat out at ring five for a week
  // finds its own cell missing from `free` the moment the colony shrinks, cannot reclaim
  // it, and is re-seeded in the middle — which is exactly the jump this function exists to
  // prevent, arriving by the back door.
  let farthest = 0
  for (const project of projects) {
    for (const cell of previous.get(project.id) || []) farthest = Math.max(farthest, hexDistance(cell, ORIGIN))
  }
  for (let ring = 0; (pool.length < total + 30 || ring <= farthest) && ring < POOL_RINGS; ring++) {
    for (const cell of hexRing(ring)) {
      const k = key(cell.q, cell.r)
      if (k === reserved) continue
      pool.push(cell)
      free.add(k)
    }
  }

  const held = new Map()
  for (const { id, want } of wanted) {
    const before = previous.get(id)
    if (!before || !before.length) continue
    // The root cell is the whole point — it is the zone's origin, and everything standing
    // on the zone is placed relative to it. A blob that loses its root has *moved*, so if
    // the root is gone this project is seeded afresh rather than quietly re-rooted onto
    // whichever of its old cells happens to still be free.
    if (!free.has(key(before[0].q, before[0].r))) continue
    const keep = []
    for (const cell of before) {
      if (keep.length >= want) break // shrunk: whatever it claimed last is what it gives up
      const k = key(cell.q, cell.r)
      if (!free.has(k)) continue // the ship's cell, or a duplicate in a hand-edited file
      free.delete(k)
      keep.push({ q: cell.q, r: cell.r })
    }
    if (keep.length) held.set(id, keep)
  }

  const out = new Map()
  // Anybody who was already here grows first, so a newcomer cannot take the cell a zone
  // was about to expand into while its own seed is still free.
  for (const { id, want } of wanted) {
    const cells = held.get(id)
    if (!cells) continue
    growBlob(cells, want, free)
    out.set(id, cells)
  }

  for (const { id, want } of wanted) {
    if (out.has(id)) continue
    const seed = pool.find((c) => free.has(key(c.q, c.r)))
    if (!seed) {
      out.set(id, [])
      continue
    }
    free.delete(key(seed.q, seed.r))
    const cells = [{ q: seed.q, r: seed.r }]
    growBlob(cells, want, free)
    out.set(id, cells)
  }
  return out
}

/** Claim free neighbours until the blob is big enough, hugging its root cell first. */
function growBlob(cells, want, free) {
  const root = cells[0]
  while (cells.length < want) {
    let best = null
    let bestScore = Infinity
    for (const c of cells) {
      for (const [dq, dr] of HEX_DIRS) {
        const n = { q: c.q + dq, r: c.r + dr }
        if (!free.has(key(n.q, n.r))) continue
        // Hug the root first, then the middle of the colony, so blobs come out compact.
        const score = hexDistance(n, root) * 100 + hexDistance(n, ORIGIN)
        if (score < bestScore) {
          bestScore = score
          best = n
        }
      }
    }
    if (!best) break // completely hemmed in by neighbours
    free.delete(key(best.q, best.r))
    cells.push(best)
  }
}
