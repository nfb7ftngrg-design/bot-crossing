import * as THREE from 'three'
import {
  mdiCogOutline,
  mdiRotate3dVariant,
  mdiHomeOutline,
  mdiClose,
  mdiOpenInNew,
  mdiCheck,
  mdiArchiveArrowDownOutline,
  mdiFishbowlOutline,
  mdiMagnify,
  mdiCameraOutline,
  mdiDiving,
} from '@mdi/js'
import { PRESETS } from '../core/settings.js'
import { STATUS_LABEL } from '../game/status.js'
import { CELL, hexToWorld } from '../world/layout.js'
import { SHIP_CELL } from '../world/plot-move.js'
import { DOING } from './fish.js'
import { FILTERS, SIGNAL, ago } from './signals.js'

/**
 * Everything on the reef that is read rather than looked at: the counts, the card that rides
 * beside the fish you picked, name plates, shelf names and the shelf's thread list, search,
 * filters, the minimap, and the settings drawer. Plain DOM — nothing here belongs in the scene.
 * Anything anchored to a fish or a shelf moves by transform, never by layout.
 */

const icon = (path, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${path}"/></svg>`

const STATUS_CHIPS = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping']
/** How many name plates can be on screen at once. Past this it is a spreadsheet with hills. */
const MAX_PLATES = 24
/** Fish that want you keep their plate up within this distance of the camera. */
const PLATE_RANGE = 55
/** World labels hide while their anchor is under the top bar, rather than sliding beneath it. */
const TOP_BAND = 118
/** Narrower than this, a card cannot sit beside a fish and docks along the bottom instead. */
export const CARD_SIDE_MIN = 700

/**
 * The settings drawer. Every knob the presets set is here, marked when it has been moved away
 * from the preset it started from; the rest are the reef's own preferences.
 */
const CONTROLS = [
  { section: 'Quality' },
  { key: 'renderScale', label: 'Resolution', type: 'range', min: 0.5, max: 1.5, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'autoQuality', label: 'Scale down when slow', type: 'toggle' },
  { key: 'shadows', label: 'Shadows', type: 'select', options: ['off', 'low', 'high', 'ultra'] },
  { key: 'ibl', label: 'Water lighting (IBL)', type: 'toggle' },
  { key: 'bloom', label: 'Bloom', type: 'toggle' },
  { key: 'bloomStrength', label: 'Bloom strength', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'tiltShift', label: 'Depth of field', type: 'toggle' },
  { key: 'tiltShiftStrength', label: 'Focus blur', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'ambientOcclusion', label: 'Contact shadows', type: 'range', min: 0, max: 0.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'antialias', label: 'Antialiasing', type: 'toggle' },
  { key: 'colorGrade', label: 'Colour grade', type: 'toggle' },
  { key: 'particles', label: 'Bubbles, plankton, shoal', type: 'select', options: ['off', 'low', 'full'] },
  { key: 'scatterDensity', label: 'Kelp', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'maxAgents', label: 'Most fish shown', type: 'range', min: 20, max: 200, step: 10, fmt: (v) => String(v) },
  { section: 'Light' },
  { key: 'timeOfDay', label: 'Time of day', type: 'range', min: 0, max: 1, step: 0.005, fmt: clock },
  { key: 'clockTime', label: 'Follow my clock', type: 'toggle' },
  { key: 'autoTime', label: 'Run the day', type: 'toggle' },
  { key: 'exposure', label: 'Exposure', type: 'range', min: 0.5, max: 1.8, step: 0.05, fmt: (v) => v.toFixed(2) },
  { section: 'Sound' },
  { key: 'reefSound', label: 'Sound (off until you turn it on)', type: 'toggle' },
  { key: 'reefVolume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { section: 'Behaviour' },
  { key: 'followSelected', label: 'Follow the fish I pick', type: 'toggle' },
  { key: 'hideDormant', label: 'Fold away quiet repos', type: 'toggle' },
  { key: 'showLabels', label: 'Shelf names', type: 'toggle' },
  { key: 'reducedMotion', label: 'Reduce motion', type: 'toggle' },
  { key: 'showFps', label: 'Show frame rate', type: 'toggle' },
  { key: 'openIn', label: 'Open threads in', type: 'select', options: ['app', 'terminal'] },
]

function clock(v) {
  const mins = Math.round(v * 1440) % 1440
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function el(tag, cls, html) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (html !== undefined) node.innerHTML = html
  return node
}

const rgb = (c) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
const STATE_COLOR = {
  waiting: '#ffc838',
  blocked: '#ff5a4a',
  working: '#5cc8ff',
  celebrating: '#3fcf86',
  idle: '#9fd8c8',
  sleeping: '#7a8fa8',
}

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.settingsOpen = false
    this.selection = null
    this.shelf = null
    this.photo = false

    this.boot = el('div', 'reef-boot', '<div class="reef-boot-dot"></div><span>Diving in…</span>')
    root.appendChild(this.boot)

    // ── top left: the counts, which never move, then search and filter ──────────────────
    const top = el('div', 'reef-top reef-chrome')
    top.innerHTML = `<div class="reef-brand">${icon(mdiFishbowlOutline, 20)}<span>Reef</span><span class="reef-demo" hidden>demo</span></div>`
    this.chips = el('div', 'reef-chips')
    this.chipEls = {}
    for (const status of STATUS_CHIPS) {
      const chip = el('button', `reef-chip reef-s-${status}`)
      chip.type = 'button'
      chip.title = `${STATUS_LABEL[status]} — click to visit each in turn`
      chip.innerHTML = `<i></i><b>0</b><span>${STATUS_LABEL[status]}</span>`
      chip.addEventListener('click', () => actions.cycleStatus(status))
      this.chips.appendChild(chip)
      this.chipEls[status] = chip
    }
    top.appendChild(this.chips)

    const tools = el('div', 'reef-tools')
    const searchWrap = el('div', 'reef-search')
    searchWrap.innerHTML = `${icon(mdiMagnify, 16)}<input id="reef-search" type="search" placeholder="Find a shelf or thread  /" autocomplete="off" spellcheck="false" aria-label="Find a shelf or thread">`
    this.searchInput = searchWrap.querySelector('input')
    this.results = el('ul', 'reef-results')
    this.results.hidden = true
    searchWrap.appendChild(this.results)
    this.searchInput.addEventListener('input', () => this._renderResults())
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._pickResult(0)
      if (e.key === 'Escape') this.closeSearch()
      if (e.key === 'ArrowDown') this.results.querySelector('button')?.focus()
    })
    tools.appendChild(searchWrap)

    this.filterSelect = el('select', 'reef-filter')
    this.filterSelect.id = 'reef-filter'
    this.filterSelect.setAttribute('aria-label', 'Show')
    this.filterSelect.addEventListener('change', () => actions.setFilter(this.filterSelect.value))
    tools.appendChild(this.filterSelect)
    top.appendChild(tools)

    this.capNote = el('div', 'reef-cap')
    top.appendChild(this.capNote)
    root.appendChild(top)

    // ── top right: the one button that matters most, then the camera ─────────────────────
    const bar = el('div', 'reef-bar reef-chrome')
    this.waitingBtn = el('button', 'reef-waiting', '<b>0</b> waiting <kbd>N</kbd>')
    this.waitingBtn.type = 'button'
    this.waitingBtn.title = 'Fly to the fish that has waited longest'
    this.waitingBtn.addEventListener('click', () => actions.nextWaiting())
    bar.appendChild(this.waitingBtn)
    const button = (path, title, fn) => {
      const b = el('button', 'reef-icon', icon(path))
      b.type = 'button'
      b.title = title
      b.setAttribute('aria-label', title)
      b.addEventListener('click', fn)
      bar.appendChild(b)
      return b
    }
    this.orbitBtn = button(mdiRotate3dVariant, 'Slow orbit (O)', () => actions.orbit())
    this.groundBtn = button(mdiDiving, 'Down among the fish (G)', () => actions.ground())
    button(mdiCameraOutline, 'Photo mode — hide every panel (P)', () => actions.photo())
    button(mdiHomeOutline, 'The whole reef (H)', () => actions.home())
    this.settingsBtn = button(mdiCogOutline, 'Settings (,)', () => this.toggleSettings())
    const colony = el('a', 'reef-link', 'Colony')
    colony.href = '/'
    colony.title = 'The same threads as bots'
    bar.appendChild(colony)
    this.colonyLink = colony
    root.appendChild(bar)

    // ── anchored to the world ────────────────────────────────────────────────────────────
    this.labels = el('div', 'reef-labels')
    root.appendChild(this.labels)
    this.labelEls = new Map()
    this.plates = el('div', 'reef-plates')
    root.appendChild(this.plates)
    this.plateEls = []
    for (let i = 0; i < MAX_PLATES; i++) {
      const plate = el('div', 'reef-plate', '<b></b><span></span>')
      plate.hidden = true
      this.plates.appendChild(plate)
      this.plateEls.push(plate)
    }

    this.card = el('div', 'reef-card')
    this.card.hidden = true
    this.card.innerHTML = `
      <button class="reef-card-close" type="button" aria-label="Close">${icon(mdiClose, 16)}</button>
      <div class="reef-card-status"><i></i><span></span><em></em></div>
      <h2></h2>
      <p class="reef-card-doing"></p>
      <dl class="reef-card-facts">
        <dt>Shelf</dt><dd data-f="shelf"></dd>
        <dt>Agent</dt><dd data-f="agent"></dd>
        <dt>Branch</dt><dd data-f="branch"></dd>
        <dt>Last move</dt><dd data-f="moved"></dd>
      </dl>
      <p class="reef-card-preview"></p>
      <div class="reef-card-bar" title="How much work this thread holds — the size of its coral"><div></div></div>
      <div class="reef-card-actions">
        <button type="button" data-act="open">${icon(mdiOpenInNew, 16)}<span>Open</span></button>
        <button type="button" data-act="seen">${icon(mdiCheck, 16)}<span>Seen</span></button>
        <button type="button" data-act="archive">${icon(mdiArchiveArrowDownOutline, 16)}<span>Archive</span></button>
      </div>`
    this.card.querySelector('.reef-card-close').addEventListener('click', () => actions.close())
    for (const b of this.card.querySelectorAll('[data-act]')) b.addEventListener('click', () => actions[b.dataset.act]())
    root.appendChild(this.card)

    // The shelf panel: click a shelf, see its threads; click a thread, fly to its fish.
    this.shelfPanel = el('aside', 'reef-shelf reef-chrome')
    this.shelfPanel.hidden = true
    root.appendChild(this.shelfPanel)

    // ── bottom: minimap and compass, readouts ────────────────────────────────────────────
    const map = el('div', 'reef-map reef-chrome')
    this.mapCanvas = el('canvas')
    this.mapCanvas.width = 300
    this.mapCanvas.height = 300
    this.mapCanvas.title = 'Click to fly there'
    this.mapCanvas.setAttribute('aria-label', 'Minimap — click to fly there')
    this.mapCanvas.addEventListener('click', (e) => {
      const r = this.mapCanvas.getBoundingClientRect()
      const x = ((e.clientX - r.left) / r.width - 0.5) * this._mapSpan
      const z = ((e.clientY - r.top) / r.height - 0.5) * this._mapSpan
      actions.flyTo(x, z)
    })
    this.compass = el('button', 'reef-compass', '<span>N</span>')
    this.compass.type = 'button'
    this.compass.title = 'Turn to face north'
    this.compass.addEventListener('click', () => actions.faceNorth())
    map.append(this.mapCanvas, this.compass)
    root.appendChild(map)
    this._mapSpan = 160

    this.toastEl = el('div', 'reef-toast')
    this.toastEl.setAttribute('role', 'status')
    root.appendChild(this.toastEl)
    this.fps = el('div', 'reef-fps reef-chrome')
    root.appendChild(this.fps)
    this.keysHint = el(
      'div',
      'reef-keys reef-chrome',
      'drag to move · right-drag to turn · scroll to zoom · <kbd>N</kbd> next waiting · <kbd>/</kbd> find · <kbd>P</kbd> photo'
    )
    root.appendChild(this.keysHint)

    this._buildSettings(root)
    this.setFilterOptions([])
    this.syncSettings()
  }

  setDemo(on, standalone = false) {
    // A hosted copy has no colony page to link across to.
    if (standalone) this.colonyLink.hidden = true
    if (this.boot) this.boot.querySelector('span').textContent = on ? 'Diving in (demo)…' : 'Diving in…'
    document.querySelector('.reef-demo').hidden = !on
  }

  removeBoot() {
    if (!this.boot) return
    this.boot.classList.add('gone')
    const boot = this.boot
    this.boot = null
    setTimeout(() => boot.remove(), 600)
  }

  toast(message, kind = '') {
    this.toastEl.textContent = message
    this.toastEl.className = `reef-toast show ${kind}`
    clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => (this.toastEl.className = 'reef-toast'), 2800)
  }

  setOrbit(on) {
    this.orbitBtn.classList.toggle('on', on)
  }

  setGround(on) {
    this.groundBtn.classList.toggle('on', on)
  }

  /** Photo mode: every panel away, the world kept. P again, or Esc, brings them back. */
  setPhoto(on) {
    this.photo = on
    document.body.classList.toggle('reef-photo', on)
    if (on) this.toast('Photo mode — P or Esc to bring the panels back · Shift+P saves a picture')
  }

  setStats(stats, capped) {
    for (const status of STATUS_CHIPS) {
      const n = stats[status] || 0
      const chip = this.chipEls[status]
      chip.querySelector('b').textContent = n
      chip.classList.toggle('zero', n === 0)
    }
    const waiting = stats.waiting || 0
    this.waitingBtn.querySelector('b').textContent = waiting
    this.waitingBtn.classList.toggle('none', waiting === 0)
    this.capNote.textContent = capped ? `${capped} quieter threads not shown — raise “Most fish shown”` : ''
  }

  // ── filter and search ────────────────────────────────────────────────────────────────

  setFilterOptions(projects) {
    const current = this.filterSelect.value || 'all'
    const names = projects.map((p) => p.name).sort((a, b) => a.localeCompare(b))
    const signature = names.join('\n')
    if (signature === this._filterSignature) return
    this._filterSignature = signature
    this.filterSelect.innerHTML = ''
    for (const [key, f] of Object.entries(FILTERS)) this.filterSelect.appendChild(new Option(f.label, key))
    if (names.length) {
      const group = document.createElement('optgroup')
      group.label = 'One shelf'
      for (const name of names) group.appendChild(new Option(name, `project:${name}`))
      this.filterSelect.appendChild(group)
    }
    this.filterSelect.value = [...this.filterSelect.options].some((o) => o.value === current) ? current : 'all'
  }

  setFilter(key) {
    this.filterSelect.value = key
    this.filterSelect.classList.toggle('on', key !== 'all')
  }

  openSearch() {
    if (this.photo) this.setPhoto(false)
    this.searchInput.focus()
    this.searchInput.select()
    this._renderResults()
  }

  closeSearch() {
    this.results.hidden = true
    this.searchInput.blur()
  }

  _renderResults() {
    const found = this.actions.search(this.searchInput.value)
    this._found = found
    this.results.innerHTML = ''
    this.results.hidden = !found.length
    found.forEach((r, i) => {
      const li = el('li')
      const b = el('button', 'reef-result')
      b.type = 'button'
      const dot = r.kind === 'shelf' ? '<i class="shelf"></i>' : `<i style="background:${STATE_COLOR[r.status] || '#888'}"></i>`
      b.innerHTML = `${dot}<span>${escapeHtml(r.label)}</span><small>${escapeHtml(r.detail)}</small>`
      b.addEventListener('click', () => this._pickResult(i))
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') b.parentElement.nextElementSibling?.querySelector('button')?.focus()
        if (e.key === 'ArrowUp') (b.parentElement.previousElementSibling?.querySelector('button') || this.searchInput).focus()
        if (e.key === 'Escape') this.closeSearch()
      })
      li.appendChild(b)
      this.results.appendChild(li)
    })
  }

  _pickResult(i) {
    const r = this._found?.[i]
    if (!r) return
    this.closeSearch()
    if (r.kind === 'shelf') this.actions.openShelf(r.name)
    else this.actions.selectThread(r.id)
  }

  // ── shelves ──────────────────────────────────────────────────────────────────────────

  setProjects(projects) {
    this.projects = projects
    this.setFilterOptions(projects)
    const seen = new Set()
    for (const p of projects) {
      seen.add(p.name)
      let label = this.labelEls.get(p.name)
      if (!label) {
        label = el('button', 'reef-label')
        label.type = 'button'
        label.addEventListener('click', () => this.actions.openShelf(label._project.name))
        this.labels.appendChild(label)
        this.labelEls.set(p.name, label)
      }
      const signal = p.signal.mode ? rgb(p.signal.color) : 'transparent'
      label.innerHTML = `<i style="background:${signal}"></i>${escapeHtml(p.name)}<small>${p.count}</small>`
      label.title = `${p.name} — ${p.count} thread${p.count === 1 ? '' : 's'}. Click to see them.`
      label.classList.toggle('urgent', p.urgent)
      label.dataset.active = p.active ? '1' : ''
      label._project = p
    }
    for (const [name, label] of this.labelEls) {
      if (seen.has(name)) continue
      label.remove()
      this.labelEls.delete(name)
    }
    if (this.shelf) this.showShelf(this.shelf, this._shelfFish?.() || [])
  }

  /** List a shelf's threads, loudest first. `fish` is that shelf's fish. */
  showShelf(name, fish, source) {
    if (source) this._shelfFish = source
    const project = this.projects?.find((p) => p.name === name)
    if (!project) {
      this.closeShelf()
      return
    }
    this.shelf = name
    this.shelfPanel.hidden = false
    const order = ['blocked', 'waiting', 'working', 'celebrating', 'idle', 'sleeping']
    const sorted = [...fish].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (b.thread?.lastActivityAt || 0) - (a.thread?.lastActivityAt || 0))
    const parts = Object.entries(project.counts)
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([s, n]) => `${n} ${(STATUS_LABEL[s] || s).toLowerCase()}`)
    this.shelfPanel.innerHTML = `
      <header><h3>${escapeHtml(name)}</h3><button type="button" class="reef-icon" aria-label="Close">${icon(mdiClose, 16)}</button></header>
      <p class="reef-shelf-sum">${parts.join(' · ')}</p>
      <ul></ul>`
    this.shelfPanel.querySelector('header button').addEventListener('click', () => this.closeShelf())
    const ul = this.shelfPanel.querySelector('ul')
    for (const f of sorted) {
      const li = el('li')
      const b = el('button', 'reef-shelf-row')
      b.type = 'button'
      b.innerHTML = `<i style="background:${STATE_COLOR[f.status]}"></i><span>${escapeHtml(f.thread?.title || 'Untitled thread')}</span><small>${STATUS_LABEL[f.status] || f.status}</small>`
      b.addEventListener('click', () => this.actions.selectThread(f.id))
      li.appendChild(b)
      ul.appendChild(li)
    }
  }

  closeShelf() {
    this.shelf = null
    this.shelfPanel.hidden = true
  }

  // ── the card ─────────────────────────────────────────────────────────────────────────

  setSelection(fish, thread, status) {
    this.selection = fish ? { fish, thread, status } : null
    if (!fish) {
      this.card.hidden = true
      return
    }
    const mode = fish.mode === 'arriving' ? 'arriving' : fish.mode === 'leaving' ? 'leaving' : status
    this.card.hidden = false
    this.card.dataset.status = status
    this.card.querySelector('.reef-card-status span').textContent =
      mode === 'arriving' ? STATUS_LABEL.spawning : mode === 'leaving' ? STATUS_LABEL.leaving : STATUS_LABEL[status] || status
    // How long it has wanted you, for the states that want you.
    const since = status === 'waiting' || status === 'blocked' ? ` · ${ago(thread.lastActivityAt).replace(' ago', '')}` : ''
    this.card.querySelector('.reef-card-status em').textContent = since
    this.card.querySelector('h2').textContent = thread.title || 'Untitled thread'
    this.card.querySelector('.reef-card-doing').textContent = DOING[mode] || ''
    const fact = (f, text) => {
      const dd = this.card.querySelector(`[data-f="${f}"]`)
      dd.textContent = text || '—'
      dd.previousElementSibling.hidden = dd.hidden = !text
    }
    fact('shelf', thread.project || 'unknown')
    fact('agent', [thread.harnessName || thread.harness, thread.model].filter(Boolean).join(' · '))
    fact('branch', thread.gitBranch)
    fact('moved', thread.lastActivityAt ? ago(thread.lastActivityAt) : '')
    this.card.querySelector('.reef-card-preview').textContent = thread.preview || ''
    this.card.querySelector('.reef-card-bar div').style.width = `${Math.round(this.actions.progressFor(thread.id) * 100)}%`
    this.card.querySelector('[data-act="open"]').disabled = thread.canOpen === false
    this.card.querySelector('[data-act="seen"]').hidden = status !== 'waiting'
    this.card.querySelector('[data-act="archive"]').disabled = Boolean(thread.parentId)
  }

  // ── per frame ────────────────────────────────────────────────────────────────────────

  /** The card, plates and shelf names follow the world on screen; the minimap redraws. */
  frame(engine, rig, reef, selectedId, light, hoverId) {
    const rect = engine.canvas.getBoundingClientRect()
    const toScreen = (v) => {
      _v.copy(v).project(engine.camera)
      return { x: rect.left + ((_v.x + 1) / 2) * rect.width, y: rect.top + ((1 - _v.y) / 2) * rect.height, behind: _v.z > 1 }
    }

    if (this.selection) {
      const fish = this.selection.fish
      const s = toScreen(_w.copy(fish.pos).setY(fish.pos.y + 0.4))
      const w = this.card.offsetWidth
      const h = this.card.offsetHeight
      // Parked beside the fish rather than on top of it, flipping sides near the edge. On a
      // screen too narrow for a card beside a fish, it docks along the bottom instead and the
      // camera keeps the fish in view above it.
      this.docked = window.innerWidth < CARD_SIDE_MIN
      this.card.classList.toggle('docked', this.docked)
      if (this.docked) {
        this.card.style.transform = `translate(12px, ${Math.round(window.innerHeight - h - 12)}px)`
        this.card.style.opacity = '1'
      } else {
        let x = s.x + 34
        if (x + w > window.innerWidth - 12) x = s.x - 34 - w
        const y = Math.min(window.innerHeight - h - 12, Math.max(64, s.y - h / 2))
        this.card.style.transform = `translate(${Math.round(Math.max(12, x))}px, ${Math.round(y)}px)`
        this.card.style.opacity = s.behind ? '0' : '1'
      }
    }

    // Name plates: the fish under the pointer, plus every fish that wants you and is near enough
    // to read — never the quiet ones, or the one that matters is lost among them.
    const wanted = []
    for (const fish of reef.school.order) {
      if (!reef.school.isShown(fish) || fish.id === selectedId) continue
      const attention = fish.mode === 'live' && (fish.status === 'waiting' || fish.status === 'blocked')
      if (fish.id !== hoverId && !attention) continue
      const d = engine.camera.position.distanceTo(fish.pos)
      if (fish.id !== hoverId && d > PLATE_RANGE) continue
      wanted.push({ fish, d: fish.id === hoverId ? -1 : d })
    }
    wanted.sort((a, b) => a.d - b.d)
    for (let i = 0; i < MAX_PLATES; i++) {
      const plate = this.plateEls[i]
      const item = wanted[i]
      if (!item) {
        plate.hidden = true
        continue
      }
      const f = item.fish
      const s = toScreen(_w.copy(f.pos).setY(f.pos.y + 1.6))
      if (s.behind || s.y < TOP_BAND) {
        plate.hidden = true
        continue
      }
      plate.hidden = false
      if (plate._id !== f.id || plate._status !== f.status) {
        plate._id = f.id
        plate._status = f.status
        plate.querySelector('b').textContent = f.thread?.title || 'Untitled thread'
        plate.querySelector('span').textContent = `${STATUS_LABEL[f.status] || f.status} · ${f.project || ''}`
        plate.style.setProperty('--c', STATE_COLOR[f.status] || '#888')
      }
      plate.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`
    }

    const showAll = rig.distance < 70 && this.settings.get('showLabels') !== false
    for (const label of this.labelEls.values()) {
      const p = label._project
      if (!p) continue
      const s = toScreen(_w.copy(p.centre).setY(p.centre.y + 4.2))
      const loud = label.dataset.active || label.classList.contains('urgent')
      const visible = !s.behind && s.y > TOP_BAND && !this.photo && (showAll || loud)
      label.style.opacity = visible ? (loud ? '1' : '0.6') : '0'
      label.style.pointerEvents = visible ? 'auto' : 'none'
      label.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`
    }

    this.compass.style.setProperty('--heading', `${(rig.azimuth * 180) / Math.PI}deg`)
    this._mapClock = (this._mapClock || 0) + 1
    if (this._mapClock % 6 === 0) this._drawMap(reef, rig, engine)

    if (this.settings.get('showFps')) {
      const perf = engine.perf
      const fish = reef.school.order.length
      this.fps.textContent = `${Math.round(perf.fps)} fps · ${perf.drawCalls} draws · ${fish} fish · ${clock(light.time)}${engine.autoScaled ? ' · scaled' : ''}`
      this.fps.hidden = false
    } else this.fps.hidden = true
  }

  /** The minimap: shelves by state, the wreck, every fish as a dot, and where you are looking. */
  _drawMap(reef, rig, engine) {
    const ctx = this.mapCanvas.getContext('2d')
    const W = this.mapCanvas.width
    // Fit the whole reef, with room to spare, and keep the scale steady between redraws.
    // The wreck counts too, since arrivals and departures happen there.
    const wreckAt = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)
    let extent = Math.max(Math.abs(wreckAt.x), Math.abs(wreckAt.z)) + CELL
    for (const p of reef.projects) for (const c of p.cells) {
      const w = hexToWorld(c.q, c.r)
      extent = Math.max(extent, Math.abs(w.x) + CELL, Math.abs(w.z) + CELL)
    }
    const want = extent * 2.1
    // Eases towards the fit rather than jumping, so the map never lurches when a shelf grows.
    this._mapSpan += (want - this._mapSpan) * (Math.abs(want - this._mapSpan) > 40 ? 1 : 0.15)
    const k = W / this._mapSpan
    const X = (x) => W / 2 + x * k
    const Z = (z) => W / 2 + z * k
    ctx.clearRect(0, 0, W, W)
    ctx.fillStyle = 'rgba(4, 22, 32, 0.78)'
    ctx.beginPath()
    ctx.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.save()
    ctx.beginPath()
    ctx.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2)
    ctx.clip()
    const hex = (cx, cz, r) => {
      ctx.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i
        const x = X(cx + Math.cos(a) * r)
        const z = Z(cz + Math.sin(a) * r)
        if (i) ctx.lineTo(x, z)
        else ctx.moveTo(x, z)
      }
      ctx.closePath()
    }
    for (const p of reef.projects) {
      const fill = p.signal.mode ? rgb(p.signal.color) : 'rgb(110, 123, 108)'
      for (const c of p.cells) {
        const w = hexToWorld(c.q, c.r)
        hex(w.x, w.z, CELL * 0.97)
        ctx.fillStyle = fill
        ctx.globalAlpha = p.signal.mode ? 0.45 : 0.35
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    const wreck = hexToWorld(SHIP_CELL.q, SHIP_CELL.r)
    ctx.fillStyle = '#8a6a50'
    ctx.fillRect(X(wreck.x) - 5, Z(wreck.z) - 2, 10, 4)
    for (const f of reef.school.order) {
      if (!reef.school.isShown(f)) continue
      const loud = f.status === 'waiting' || f.status === 'blocked'
      ctx.fillStyle = STATE_COLOR[f.status] || '#ccc'
      ctx.beginPath()
      ctx.arc(X(f.pos.x), Z(f.pos.z), loud ? 5 : 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
    // The view: a wedge from the camera's target in the direction it looks.
    const t = rig.target
    const look = Math.atan2(-Math.sin(rig.azimuth), -Math.cos(rig.azimuth))
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(X(t.x), Z(t.z), 6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(X(t.x), Z(t.z))
    ctx.lineTo(X(t.x + Math.sin(look) * 14), Z(t.z + Math.cos(look) * 14))
    ctx.stroke()
    ctx.restore()
  }

  // ── settings ─────────────────────────────────────────────────────────────────────────

  _buildSettings(root) {
    const panel = el('aside', 'reef-settings')
    panel.hidden = true
    panel.innerHTML = `<header><h3>Settings</h3><button type="button" class="reef-icon" aria-label="Close">${icon(mdiClose, 16)}</button></header>`
    panel.querySelector('header button').addEventListener('click', () => this.toggleSettings(false))
    const presets = el('div', 'reef-presets')
    this.presetEls = {}
    for (const [name, preset] of Object.entries(PRESETS)) {
      const b = el('button', 'reef-preset', preset.label)
      b.type = 'button'
      b.title = preset.hint
      b.addEventListener('click', () => this.settings.applyPreset(name))
      presets.appendChild(b)
      this.presetEls[name] = b
    }
    panel.appendChild(presets)
    this.presetHint = el('p', 'reef-preset-hint')
    panel.appendChild(this.presetHint)

    this.controlEls = []
    let section = null
    for (const c of CONTROLS) {
      if (c.section) {
        section = el('section', '', `<h4>${c.section}</h4>`)
        panel.appendChild(section)
        continue
      }
      const row = el('label', 'reef-row')
      const name = el('span', 'reef-row-name', `${c.label}<i class="reef-moved" title="Changed from the preset"></i>`)
      row.appendChild(name)
      let input
      if (c.type === 'toggle') {
        input = el('input')
        input.type = 'checkbox'
        input.addEventListener('change', () => this.settings.set(c.key, input.checked))
      } else if (c.type === 'select') {
        input = el('select')
        for (const o of c.options) input.appendChild(new Option(o, o))
        input.addEventListener('change', () => this.settings.set(c.key, input.value))
      } else {
        input = el('input')
        input.type = 'range'
        input.min = c.min
        input.max = c.max
        input.step = c.step
        input.addEventListener('input', () => this.settings.set(c.key, Number(input.value)))
      }
      input.id = `reef-set-${c.key}`
      const value = el('output', 'reef-row-value')
      row.append(input, value)
      section.appendChild(row)
      this.controlEls.push({ c, row, input, value })
    }
    root.appendChild(panel)
    this.panel = panel
  }

  toggleSettings(open = !this.settingsOpen) {
    this.settingsOpen = open
    this.panel.hidden = !open
    this.settingsBtn.classList.toggle('on', open)
  }

  /**
   * Which preset the marks are measured against. A knob moved away from a preset turns the
   * choice into "custom", which on its own forgets what it was custom *from* — so the last named
   * preset is kept in the settings beside it, and survives a reload with them.
   */
  presetBase() {
    const s = this.settings
    const active = s.get('preset')
    if (PRESETS[active]) {
      if (s.values.presetBase !== active) s.values.presetBase = active
      return active
    }
    return PRESETS[s.values.presetBase] ? s.values.presetBase : 'balanced'
  }

  syncSettings() {
    const s = this.settings
    const active = s.get('preset')
    const base = this.presetBase()
    for (const [name, b] of Object.entries(this.presetEls)) b.classList.toggle('on', name === active)
    this.presetHint.textContent = PRESETS[active]?.hint || `custom — moved away from ${PRESETS[base].label}; dots mark what changed`
    for (const { c, row, input, value } of this.controlEls) {
      const v = s.get(c.key) ?? (c.key === 'reefVolume' ? 0.5 : c.type === 'toggle' ? false : '')
      if (c.type === 'toggle') input.checked = Boolean(v)
      else if (document.activeElement !== input) input.value = v
      value.textContent = c.fmt ? c.fmt(Number(v)) : ''
      const preset = PRESETS[base]
      row.classList.toggle('moved', Boolean(preset && c.key in preset.values && preset.values[c.key] !== v))
      if (c.key === 'timeOfDay') row.classList.toggle('disabled', Boolean(s.get('clockTime') || s.get('autoTime')))
      if (c.key === 'reefVolume') row.classList.toggle('disabled', !s.get('reefSound'))
    }
  }
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export { SIGNAL }
