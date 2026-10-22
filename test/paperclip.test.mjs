/**
 * Paperclip, faked as a board on loopback. Nothing here reaches a real instance: the
 * adapter is pointed at a throwaway HTTP server through `BOT_CROSSING_PAPERCLIP_URL`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import paperclip, { baseUrl, instanceRoot } from '../server/harnesses/paperclip.mjs'
import { withEnv } from './support/env.mjs'

const CO = '11111111-1111-4111-8111-111111111111'
const A = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

const agent = (n, status, extra = {}) => ({
  id: A(n),
  companyId: CO,
  name: `Agent ${n}`,
  role: 'engineer',
  title: 'CTO',
  status,
  capabilities: 'Ships  the\nbackend',
  adapterType: 'claude_local',
  adapterConfig: { model: 'claude-opus-5-5', cwd: '/work/app' },
  spentMonthlyCents: 150,
  lastHeartbeatAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  ...extra,
})

async function board(routes) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const body = routes[req.url]
    if (typeof body === 'number') return res.writeHead(body).end()
    if (body === undefined) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, seen, close: () => new Promise((r) => server.close(r)) }
}

test('every agent is a bot on its company plot, with status mapped and nothing written', async () => {
  const b = await board({
    '/api/companies': [{ id: CO, name: 'Notes Inc' }, { id: 'not-a-uuid', name: 'Junk' }],
    [`/api/companies/${CO}/agents`]: [
      agent(1, 'running'),
      agent(2, 'error'),
      agent(3, 'pending_approval'),
      agent(4, 'terminated'),
      agent(5, 'idle', { name: '', lastHeartbeatAt: null }),
      { id: 'nope', name: 'bad row' },
    ],
  })
  try {
    await withEnv({ BOT_CROSSING_PAPERCLIP_URL: b.url }, async () => {
      assert.equal(await paperclip.detect(), true)
      const threads = await paperclip.scanThreads()
      const byId = new Map(threads.map((t) => [t.id, t]))
      assert.equal(threads.length, 5)
      const one = byId.get(`paperclip:${A(1)}`)
      assert.equal(one.title, 'Agent 1')
      assert.equal(one.project, 'Notes Inc')
      assert.equal(one.preview, 'CTO — Ships the backend')
      assert.equal(one.model, 'claude-opus-5-5')
      assert.equal(one.cwd, '/work/app')
      assert.equal(one.running, true)
      assert.equal(one.lastActivityAt, Date.parse('2026-10-20T10:00:00.000Z'))
      assert.ok(one.sizeBytes > 0)
      assert.equal(byId.get(`paperclip:${A(2)}`).hasError, true)
      assert.equal(byId.get(`paperclip:${A(3)}`).unread, true)
      assert.equal(byId.get(`paperclip:${A(4)}`).archived, true)
      const five = byId.get(`paperclip:${A(5)}`)
      assert.equal(five.title, 'Unnamed agent')
      assert.equal(five.lastActivityAt, Date.parse('2026-10-19T00:00:00.000Z'))
      // One plot per company: every agent shares the same project path.
      assert.equal(new Set(threads.map((t) => t.projectPath)).size, 1)
      for (const t of threads) for (const [k, v] of Object.entries(t)) assert.notEqual(v, undefined, k)
    })
    assert.ok(b.seen.every((line) => line.startsWith('GET ')), 'the adapter only ever reads')
  } finally {
    await b.close()
  }
})

test('a Paperclip that is not running empties the map and says why, rather than throwing', async () => {
  const b = await board({})
  const url = b.url
  await b.close()
  await withEnv({ BOT_CROSSING_PAPERCLIP_URL: url }, async () => {
    assert.deepEqual(await paperclip.scanThreads(), [])
    assert.match(await paperclip.diagnostic(), /not answering/)
  })
})

test('an instance that wants sign-in is reported, and one bad company costs only itself', async () => {
  const locked = await board({ '/api/companies': 401 })
  try {
    await withEnv({ BOT_CROSSING_PAPERCLIP_URL: locked.url }, async () => {
      assert.deepEqual(await paperclip.scanThreads(), [])
      assert.match(await paperclip.diagnostic(), /local_trusted/)
    })
  } finally {
    await locked.close()
  }
  const other = '22222222-2222-4222-8222-222222222222'
  const partial = await board({
    '/api/companies': [{ id: CO, name: 'Notes Inc' }, { id: other, name: 'Locked Co' }],
    [`/api/companies/${CO}/agents`]: [agent(1, 'idle')],
    [`/api/companies/${other}/agents`]: 403,
  })
  try {
    await withEnv({ BOT_CROSSING_PAPERCLIP_URL: partial.url }, async () => {
      const threads = await paperclip.scanThreads()
      assert.deepEqual(threads.map((t) => t.project), ['Notes Inc'])
      assert.equal(await paperclip.diagnostic(), '')
    })
  } finally {
    await partial.close()
  }
})

test('the board address comes from the instance config, and a wildcard bind reads as loopback', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'paperclip-fixture-'))
  try {
    const env = { PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: 'work' }
    assert.equal(instanceRoot(env), path.join(home, 'instances', 'work'))
    assert.equal(await baseUrl(env), 'http://127.0.0.1:3100')
    await fsp.mkdir(instanceRoot(env), { recursive: true })
    await fsp.writeFile(path.join(instanceRoot(env), 'config.json'), JSON.stringify({ server: { host: '0.0.0.0', port: 3999 } }))
    assert.equal(await baseUrl(env), 'http://127.0.0.1:3999')
    await withEnv({ ...env, BOT_CROSSING_PAPERCLIP_URL: undefined }, async () => {
      assert.equal(await paperclip.detect(), true)
    })
    await withEnv({ PAPERCLIP_HOME: path.join(home, 'absent'), BOT_CROSSING_PAPERCLIP_URL: undefined }, async () => {
      assert.equal(await paperclip.detect(), false)
    })
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('opening an agent goes to its board page; anything else is refused', async () => {
  await withEnv({ BOT_CROSSING_PAPERCLIP_URL: 'http://127.0.0.1:3100/' }, async () => {
    const opened = await paperclip.openThread({ agentId: A(1) })
    assert.deepEqual(opened, { ok: true, url: `http://127.0.0.1:3100/agents/${A(1)}` })
    assert.equal((await paperclip.openThread({ agentId: '../x' })).ok, false)
    assert.equal((await paperclip.openThread({ agentId: [A(1)] })).ok, false)
    assert.equal((await paperclip.openThread(null)).ok, false)
    assert.equal((await paperclip.newSession('/tmp')).ok, false)
  })
})
