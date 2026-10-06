/**
 * The pieces the reef shares with the colony: the state function and the layout rule. Both are
 * pure so they can be checked here, and both are shared so the two worlds cannot drift apart —
 * a repo holds the same ground, and a thread is doing the same thing, whichever one is open.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateCells } from '../src/world/layout.js'
import { statusFor, withViewed, transcriptProgress, STALE_MS } from '../src/game/status.js'

const now = 1_800_000_000_000
const thread = (over = {}) => ({ id: 't', lastActivityAt: now - 1000, ...over })

test('state is one ordered decision: errored beats running beats merged beats unread', () => {
  assert.equal(statusFor(thread({ hasError: true, running: true, unread: true }), now), 'blocked')
  assert.equal(statusFor(thread({ running: true, unread: true }), now), 'working')
  assert.equal(statusFor(thread({ prState: 'MERGED', unread: true }), now), 'celebrating')
  assert.equal(statusFor(thread({ unread: true }), now), 'waiting')
  assert.equal(statusFor(thread({ lastActivityAt: now - STALE_MS - 1 }), now), 'sleeping')
  assert.equal(statusFor(thread(), now), 'idle')
})

test('a thread marked seen stops waiting, until it moves on again', () => {
  const [seen] = withViewed([thread({ unread: true, lastActivityAt: 100 })], { t: 200 })
  assert.equal(seen.unread, false)
  const [moved] = withViewed([thread({ unread: true, lastActivityAt: 300 })], { t: 200 })
  assert.equal(moved.unread, true)
})

test('progress is a log scale that never reads as empty or overflows', () => {
  assert.equal(transcriptProgress({ sizeBytes: 0 }), 0.05)
  assert.equal(transcriptProgress({ sizeBytes: 1e12 }), 1)
  assert.ok(transcriptProgress({ sizeBytes: 1e5 }) > transcriptProgress({ sizeBytes: 1e4 }))
})

test('a territory keeps its ground when a different project gains threads', () => {
  const first = allocateCells([
    { id: 'big', size: 20 },
    { id: 'small', size: 3 },
    { id: 'tiny', size: 1 },
  ])
  // `tiny` grows past `small`, which would reorder a size sort — nothing else may move.
  const second = allocateCells(
    [
      { id: 'big', size: 20 },
      { id: 'tiny', size: 9 },
      { id: 'small', size: 3 },
    ],
    first
  )
  assert.deepEqual(second.get('big'), first.get('big'))
  assert.deepEqual(second.get('small'), first.get('small'))
  assert.deepEqual(second.get('tiny').slice(0, first.get('tiny').length), first.get('tiny'))
})

test('growing then shrinking returns a territory to the shape it started in', () => {
  const start = allocateCells([{ id: 'a', size: 7 }, { id: 'b', size: 7 }])
  const grown = allocateCells([{ id: 'a', size: 30 }, { id: 'b', size: 7 }], start)
  assert.ok(grown.get('a').length > start.get('a').length)
  // Past the shrink hysteresis, so the borrowed cells are actually handed back.
  const shrunk = allocateCells([{ id: 'a', size: 2 }, { id: 'b', size: 7 }], grown)
  assert.deepEqual(shrunk.get('a'), start.get('a'))
  assert.deepEqual(shrunk.get('b'), start.get('b'))
})

// ── the reef's own pure decisions ─────────────────────────────────────────────

import { shelfSignal, filterFor, search, waitingOrder, ago, SIGNAL } from '../src/reef/signals.js'
import { fishLook, BODY, ARRIVE, DOING } from '../src/reef/fish.js'
import { coralLook, coralGrowth, coralSize, CORAL_SCALE } from '../src/reef/coral.js'

test('a shelf rim shows its loudest state, and nothing when it is quiet', () => {
  assert.equal(shelfSignal(['idle', 'working', 'blocked', 'waiting']).status, 'blocked')
  assert.equal(shelfSignal(['idle', 'waiting', 'working']).status, 'waiting')
  assert.equal(shelfSignal(['idle', 'celebrating', 'working']).status, 'working')
  assert.equal(shelfSignal(['idle', 'sleeping']).mode, 0)
  // Only the states that want you pulse.
  assert.equal(SIGNAL.blocked.mode, 2)
  assert.equal(SIGNAL.waiting.mode, 2)
  assert.equal(SIGNAL.working.mode, 1)
})

test('filters keep exactly what they say', () => {
  const now = 1_800_000_000_000
  const fish = [
    { status: 'waiting', project: 'a', thread: { lastActivityAt: now - 1000 } },
    { status: 'blocked', project: 'b', thread: { lastActivityAt: now - 1000 } },
    { status: 'idle', project: 'a', thread: { lastActivityAt: now - 2 * 864e5 } },
    { status: 'working', project: 'b', thread: { lastActivityAt: now } },
  ]
  assert.equal(filterFor('all'), null)
  assert.deepEqual(fish.filter(filterFor('needs', now)).map((f) => f.status), ['waiting', 'blocked'])
  assert.deepEqual(fish.filter(filterFor('project:a', now)).map((f) => f.status), ['waiting', 'idle'])
  assert.equal(fish.filter(filterFor('today', now)).length, 3)
})

test('search ranks shelves first, then threads that want you', () => {
  const projects = [{ name: 'harbour-api', count: 3 }, { name: 'web', count: 1 }]
  const threads = [
    { id: '1', title: 'harbour fix', project: 'web', lastActivityAt: 5 },
    { id: '2', title: 'harbour docs', project: 'web', lastActivityAt: 9 },
  ]
  const status = { 1: 'waiting', 2: 'idle' }
  const r = search('harbour', projects, threads, (t) => status[t.id])
  assert.equal(r[0].kind, 'shelf')
  assert.equal(r[1].id, '1') // waiting outranks the more recent idle one
  assert.deepEqual(search('', projects, threads, () => 'idle'), [])
  assert.equal(search('HARBOUR api', projects, threads, () => 'idle')[0].name, 'harbour-api')
})

test('N visits waiting fish longest-waiting first', () => {
  const fish = [
    { id: 'c', status: 'waiting', thread: { lastActivityAt: 300 } },
    { id: 'a', status: 'idle', thread: { lastActivityAt: 1 } },
    { id: 'b', status: 'waiting', thread: { lastActivityAt: 100 } },
  ]
  assert.deepEqual(waitingOrder(fish).map((f) => f.id), ['b', 'c'])
})

test('a fish and its coral look the same every time, from the id alone', () => {
  const strip = (l) => {
    const { random, ...rest } = l
    return rest
  }
  assert.deepEqual(strip(fishLook('thread-1')), strip(fishLook('thread-1')))
  assert.notDeepEqual(strip(fishLook('thread-1')), strip(fishLook('thread-2')))
  assert.deepEqual(coralLook('thread-1'), coralLook('thread-1'))
})

test('coral size comes from work alone', () => {
  assert.ok(coralSize(coralGrowth(1)) > coralSize(coralGrowth(0)))
  assert.equal(coralSize(coralGrowth(0.5)), CORAL_SCALE * (0.85 + 0.3 * coralGrowth(0.5)))
})

test('fish keep a body apart, and arrival is wider than that spacing', () => {
  assert.ok(ARRIVE > BODY)
  for (const s of ['working', 'waiting', 'blocked', 'celebrating', 'sleeping', 'idle', 'arriving', 'leaving']) {
    assert.ok(DOING[s] && DOING[s].length > 20, `no sentence for ${s}`)
  }
})

test('"ago" reads like a person would say it', () => {
  const now = 1_800_000_000_000
  assert.equal(ago(now - 10_000, now), 'just now')
  assert.equal(ago(now - 5 * 60_000, now), '5 min ago')
  assert.equal(ago(now - 3 * 3600_000, now), '3 h ago')
  assert.equal(ago(now - 2 * 864e5, now), '2 d ago')
})
