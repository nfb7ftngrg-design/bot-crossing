/**
 * The lab's floor plan: the rules that, broken, would make the facility unlearnable or unwalkable.
 * Pure data, so it runs here without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateRooms, buildPlan, deskFor, FACILITY, ROOM, HALF, DOOR, DESK_SIZE, DESK_SPOTS, DOOR_OFFSET, roomCentre, kindAt } from '../src/lab/floorplan.js'
import { cellKey } from '../src/world/plot-move.js'

const layoutFor = (sizes, previous) => allocateRooms(sizes.map(([id, size]) => ({ id, size })), previous)

test('no department is ever given a room of the core', () => {
  const layout = layoutFor([['a', 30], ['b', 20], ['c', 12], ['d', 3]])
  const core = new Set(Object.values(FACILITY).map((c) => cellKey(c.q, c.r)))
  for (const [, cells] of layout) for (const c of cells) assert.ok(!core.has(cellKey(c.q, c.r)))
})

test('a department keeps its rooms when another department grows', () => {
  const first = layoutFor([['a', 14], ['b', 7], ['c', 2]])
  const second = layoutFor([['a', 14], ['c', 25], ['b', 7]], first)
  assert.deepEqual(second.get('a'), first.get('a'))
  assert.deepEqual(second.get('b'), first.get('b'))
  assert.deepEqual(second.get('c').slice(0, first.get('c').length), first.get('c'))
})

test('growing then shrinking hands back exactly what was borrowed', () => {
  const start = layoutFor([['a', 6], ['b', 6]])
  const grown = layoutFor([['a', 40], ['b', 6]], start)
  const shrunk = layoutFor([['a', 2], ['b', 6]], grown)
  assert.deepEqual(shrunk.get('a'), start.get('a'))
})

test('every room can be walked to from the lobby, through doorways only', () => {
  const plan = buildPlan(layoutFor([['a', 30], ['b', 20], ['c', 12], ['d', 3], ['e', 9]]))
  // A door joins the two cells either side of it; same-department rooms and corridor runs are open.
  const open = new Map([...plan.all.keys()].map((k) => [k, new Set()]))
  const link = (a, b) => {
    if (!open.has(a) || !open.has(b)) return
    open.get(a).add(b)
    open.get(b).add(a)
  }
  for (const d of plan.doors) {
    const [a, b] = d.axis === 'z' ? [[d.x - HALF, d.z], [d.x + HALF, d.z]] : [[d.x - DOOR_OFFSET, d.z - HALF], [d.x - DOOR_OFFSET, d.z + HALF]]
    const ka = cellKey(Math.round(a[0] / ROOM), Math.round(a[1] / ROOM))
    const kb = cellKey(Math.round(b[0] / ROOM), Math.round(b[1] / ROOM))
    link(ka, kb)
  }
  for (const c of plan.all.values()) {
    for (const [dq, dr] of [[1, 0], [0, 1]]) {
      const n = plan.all.get(cellKey(c.q + dq, c.r + dr))
      if (!n) continue
      const open = (c.kind === 'corridor' && n.kind === 'corridor') || (c.kind === 'dept' && n.kind === 'dept' && c.project === n.project)
      if (open) link(cellKey(c.q, c.r), cellKey(n.q, n.r))
    }
  }
  const start = cellKey(0, 0)
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) for (const n of open.get(queue.pop())) if (!seen.has(n)) seen.add(n), queue.push(n)
  assert.equal(seen.size, plan.all.size, `${plan.all.size - seen.size} rooms cannot be reached`)
})

test('no wall faces bedrock with a door in it, and every door has wall either side', () => {
  const plan = buildPlan(layoutFor([['a', 10], ['b', 4]]))
  for (const d of plan.doors) {
    const at = d.axis === 'x' ? DOOR_OFFSET : 0
    const wx = d.axis === 'x' ? d.x - at : d.x
    const wz = d.axis === 'z' ? d.z - at : d.z
    const sides = plan.walls.filter((w) => w.x === wx && w.z === wz && w.axis === d.axis)
    assert.equal(sides.length, 2)
    assert.ok(sides.some((w) => w.to === at - DOOR / 2) && sides.some((w) => w.from === at + DOOR / 2))
  }
  // The operations room's north wall is solid: it carries the video wall.
  const ops = roomCentre(FACILITY.ops)
  assert.ok(!plan.doors.some((d) => d.axis === 'x' && Math.abs(d.z - (ops.z - HALF)) < 0.01 && Math.abs(d.x - ops.x - DOOR_OFFSET) < 0.01))
})

test('no desk stands in a doorway or overlaps another desk', () => {
  const rooms = [{ q: 2, r: 0 }]
  const desks = DESK_SPOTS.map((_, i) => deskFor(rooms, i))
  const c = roomCentre(rooms[0])
  for (const d of desks) {
    // Doors sit at the middle of each wall; keep a doorway's width plus a body clear in front of it.
    const lx = d.x - c.x
    const lz = d.z - c.z
    const nearNS = Math.abs(lx - DOOR_OFFSET) < DOOR / 2 + DESK_SIZE.w / 2 && HALF - Math.abs(lz) < 1.5
    const nearEW = Math.abs(lz) < DOOR / 2 + DESK_SIZE.d / 2 && HALF - Math.abs(lx) < 1.5
    assert.ok(!nearNS && !nearEW, `desk at ${lx},${lz} blocks a door`)
  }
  for (let i = 0; i < desks.length; i++) for (let j = i + 1; j < desks.length; j++) {
    const a = desks[i]
    const b = desks[j]
    assert.ok(Math.abs(a.x - b.x) >= DESK_SIZE.w || Math.abs(a.z - b.z) >= DESK_SIZE.d + 1, 'desks overlap')
  }
})

test('the core rooms are where the plan says, and corridors surround the facility', () => {
  const plan = buildPlan(layoutFor([['a', 6]]))
  assert.equal(kindAt(plan, 0, 0).kind, 'lobby')
  assert.equal(kindAt(plan, 0, -ROOM).kind, 'ops')
  assert.ok(plan.corridors.size > 0)
  assert.equal(kindAt(plan, 400, 400), null)
})

// ── cases ─────────────────────────────────────────────────────────────────────

import { createCase, assign, unassign, setStatus, removeCase, casesFor, ordered, briefText, edit } from '../src/lab/cases.js'

test('a case is created open, and putting the first worker on it makes it active', () => {
  const { cases, id } = createCase({}, { title: '  Find the leak  ', priority: 'urgent' }, 1000)
  assert.equal(cases[id].title, 'Find the leak')
  assert.equal(cases[id].status, 'open')
  const next = assign(cases, id, 'w1', 2000)
  assert.equal(next[id].status, 'active')
  assert.deepEqual(next[id].assigned, ['w1'])
  assert.equal(next[id].updatedAt, 2000)
  // The original object is never touched, so a save can tell what changed.
  assert.deepEqual(cases[id].assigned, [])
})

test('assigning twice is a no-op; unassigning removes just that worker', () => {
  let { cases, id } = createCase({}, { title: 'X' })
  cases = assign(cases, id, 'a')
  const same = assign(cases, id, 'a')
  assert.equal(same, cases)
  cases = assign(cases, id, 'b')
  cases = unassign(cases, id, 'a')
  assert.deepEqual(cases[id].assigned, ['b'])
})

test('a case without a title is refused', () => {
  assert.throws(() => createCase({}, { title: '   ' }))
})

test('boards hang open work first, urgent first, closed last', () => {
  let cases = {}
  const add = (title, priority, t) => {
    const made = createCase(cases, { title, priority }, t)
    cases = made.cases
    return made.id
  }
  add('routine old', 'routine', 1)
  const urgent = add('urgent', 'urgent', 2)
  const closed = add('closed urgent', 'urgent', 0)
  cases = setStatus(cases, closed, 'closed')
  assert.deepEqual(ordered(cases).map((c) => c.title), ['urgent', 'routine old', 'closed urgent'])
  cases = assign(cases, urgent, 'w')
  assert.deepEqual(casesFor(cases, 'w').map((c) => c.title), ['urgent'])
  assert.ok(!('x' in removeCase(cases, urgent)) && !(urgent in removeCase(cases, urgent)))
})

test('the brief reads as a hand-off, and edits keep the title non-empty', () => {
  let { cases, id } = createCase({}, { title: 'Ship it', brief: 'Do the thing.', priority: 'priority' })
  assert.match(briefText(cases[id], 'Fix auth'), /CASE: Ship it\nPriority: Priority\nAssigned to: Fix auth\n\nDo the thing\./)
  cases = edit(cases, id, { title: '   ', brief: 'New brief' })
  assert.equal(cases[id].title, 'Ship it')
  assert.equal(cases[id].brief, 'New brief')
})

test('a secure room has one way in, from the lobby', () => {
  const plan = buildPlan(new Map([['a', [{ q: -2, r: 0 }]], ['b', [{ q: 0, r: -2 }]], ['c', [{ q: 2, r: 0 }]]]))
  for (const room of ['ops', 'servers', 'archive']) {
    const doors = plan.doors.filter((d) => d.between.includes(room))
    assert.equal(doors.length, 1, `${room} has ${doors.length} doors`)
    assert.ok(doors[0].between.includes('lobby') && doors[0].secure)
  }
})
