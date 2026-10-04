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
