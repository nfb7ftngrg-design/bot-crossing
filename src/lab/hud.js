import * as THREE from 'three'
import {
  mdiCogOutline,
  mdiRotate3dVariant,
  mdiHomeOutline,
  mdiClose,
  mdiOpenInNew,
  mdiCheck,
  mdiArchiveArrowDownOutline,
  mdiShieldStarOutline,
  mdiMagnify,
  mdiCameraOutline,
  mdiWalk,
  mdiBriefcaseOutline,
  mdiPlus,
  mdiContentCopy,
  mdiTrashCanOutline,
  mdiTarget,
} from '@mdi/js'
import { PRESETS } from '../core/settings.js'
import { STATUS_LABEL } from '../game/status.js'
import { ROOM, HALF, roomCentre } from './floorplan.js'
import { DOING } from './people.js'
import { FILTERS, SIGNAL, ago } from '../reef/signals.js'
import { PRIORITY, PRIORITY_LABEL, STATUS as CASE_STATUS, STATUS_LABEL as CASE_STATUS_LABEL, ordered, casesFor } from './cases.js'

/**
 * Everything in the lab that is read rather than looked at: the counts, the card that rides
 * beside the person you picked, name plates, department names and their staff lists, search,
 * filters, the minimap, the case boards, and the settings drawer. Plain DOM — nothing here
 * belongs in the scene. Anything anchored to a person or a room moves by transform.
 */

const icon = (path, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${path}"/></svg>`

const STATUS_CHIPS = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping']
/** How many name plates can be on screen at once. Past this it is a spreadsheet with hills. */
const MAX_PLATES = 24
/** People who want you keep their plate up within this distance of the camera. */
const PLATE_RANGE = 55
/** World labels hide while their anchor is under the top bar, rather than sliding beneath it. */
const TOP_BAND = 118
/** Narrower than this, a card cannot sit beside a person and docks along the bottom instead. */
export const CARD_SIDE_MIN = 700

/**
 * The settings drawer. Every knob the presets set is here, marked when it has been moved away
 * from the preset it started from; the rest are the lab's own preferences.
 */
const CONTROLS = [
  { section: 'Quality' },
  { key: 'renderScale', label: 'Resolution', type: 'range', min: 0.5, max: 1.5, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'autoQuality', label: 'Scale down when slow', type: 'toggle' },
  { key: 'shadows', label: 'Shadows', type: 'select', options: ['off', 'low', 'high', 'ultra'] },
  { key: 'ibl', label: 'Room lighting (IBL)', type: 'toggle' },
  { key: 'bloom', label: 'Bloom', type: 'toggle' },
  { key: 'bloomStrength', label: 'Bloom strength', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'tiltShift', label: 'Depth of field', type: 'toggle' },
  { key: 'tiltShiftStrength', label: 'Focus blur', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'ambientOcclusion', label: 'Contact shadows', type: 'range', min: 0, max: 0.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'antialias', label: 'Antialiasing', type: 'toggle' },
  { key: 'colorGrade', label: 'Colour grade', type: 'toggle' },
  { key: 'particles', label: 'Confetti, steam', type: 'select', options: ['off', 'low', 'full'] },
  { key: 'maxAgents', label: 'Most staff on the floor', type: 'range', min: 20, max: 200, step: 10, fmt: (v) => String(v) },
  { section: 'Light' },
  { key: 'timeOfDay', label: 'Time (night shift 19:00–07:00)', type: 'range', min: 0, max: 1, step: 0.005, fmt: clock },
  { key: 'clockTime', label: 'Follow my clock', type: 'toggle' },
  { key: 'autoTime', label: 'Run the day', type: 'toggle' },
  { key: 'exposure', label: 'Exposure', type: 'range', min: 0.5, max: 1.8, step: 0.05, fmt: (v) => v.toFixed(2) },
  { section: 'Sound' },
  { key: 'labSound', label: 'Sound (off until you turn it on)', type: 'toggle' },
  { key: 'labVolume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { section: 'Behaviour' },
  { key: 'followSelected', label: 'Follow the person I pick', type: 'toggle' },
  { key: 'hideDormant', label: 'Close quiet departments', type: 'toggle' },
  { key: 'showLabels', label: 'Department names', type: 'toggle' },
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

    this.boot = el('div', 'reef-boot', '<div class="reef-boot-dot"></div><span>Badging in…</span>')
    root.appendChild(this.boot)

    // ── top left: the counts, which never move, then search and filter ──────────────────
    const top = el('div', 'reef-top reef-chrome')
    top.innerHTML = `<div class="reef-brand">${icon(mdiShieldStarOutline, 20)}<span>Level B3 · Directorate of Thread Operations</span><span class="reef-demo" hidden>demo</span></div>`
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
    searchWrap.innerHTML = `${icon(mdiMagnify, 16)}<input id="reef-search" type="search" placeholder="Find a department or person  /" autocomplete="off" spellcheck="false" aria-label="Find a department or person">`
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
    this.waitingBtn.title = 'Go to the person who has waited longest'
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
    this.casesBtn = button(mdiBriefcaseOutline, 'Case boards (C)', () => this.toggleCases())
    this.groundBtn = button(mdiWalk, 'Down to the floor (G)', () => actions.ground())
    button(mdiCameraOutline, 'Photo mode — hide every panel (P)', () => actions.photo())
    button(mdiHomeOutline, 'The whole floor (H)', () => actions.home())
    this.settingsBtn = button(mdiCogOutline, 'Settings (,)', () => this.toggleSettings())
    const colony = el('a', 'reef-link', 'Colony')
    colony.href = '/'
    colony.title = 'The same threads as bots on the moon'
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
        <dt>Department</dt><dd data-f="shelf"></dd>
        <dt>Agent</dt><dd data-f="agent"></dd>
        <dt>Branch</dt><dd data-f="branch"></dd>
        <dt>Last move</dt><dd data-f="moved"></dd>
      </dl>
      <p class="reef-card-preview"></p>
      <div class="lab-card-cases"><span class="lab-label">Cases</span><div class="lab-chips"></div>
        <select id="lab-card-assign" aria-label="Put on a case"></select></div>
      <div class="reef-card-bar" title="How much work this thread holds — how built-up its desk is"><div></div></div>
      <div class="reef-card-actions">
        <button type="button" data-act="open">${icon(mdiOpenInNew, 16)}<span>Open</span></button>
        <button type="button" data-act="seen">${icon(mdiCheck, 16)}<span>Seen</span></button>
        <button type="button" data-act="archive">${icon(mdiArchiveArrowDownOutline, 16)}<span>Archive</span></button>
      </div>`
    this.card.querySelector('.reef-card-close').addEventListener('click', () => actions.close())
    this.card.querySelector('#lab-card-assign').addEventListener('change', (e) => {
      const v = e.target.value
      e.target.value = ''
      const id = this.selection?.thread?.id
      if (!v || !id) return
      if (v === '__new') this.openCases({ newFor: id })
      else actions.assign(v, id)
    })
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
    this.mapCanvas.title = 'Click to go there'
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
      'drag to move · right-drag to turn · scroll to zoom · <kbd>N</kbd> next waiting · <kbd>C</kbd> cases · <kbd>/</kbd> find · <kbd>P</kbd> photo'
    )
    root.appendChild(this.keysHint)

    this._buildSettings(root)
    this._buildCases(root)
    this.setFilterOptions([])
    this.syncSettings()
  }

  setDemo(on, standalone = false) {
    // A hosted copy has no colony page to link across to.
    if (standalone) this.colonyLink.hidden = true
    if (this.boot) this.boot.querySelector('span').textContent = on ? 'Badging in (demo)…' : 'Badging in…'
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
      group.label = 'One department'
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
      label.title = `${p.name} — ${p.count} on staff. Click to see them.`
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

  /** List a department's staff, loudest first. `fish` is that department's people. */
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
    this._cardCases(thread)
  }

  /** The cases this worker is on, as chips, and a menu to put them on another. */
  _cardCases(thread) {
    const cases = this.actions.cases()
    const mine = casesFor(cases, thread.id)
    const chips = this.card.querySelector('.lab-chips')
    chips.innerHTML = ''
    for (const c of mine) {
      const b = el('button', `lab-chip lab-p-${c.priority}${c.status === 'closed' ? ' closed' : ''}`, escapeHtml(c.title))
      b.type = 'button'
      b.title = `${PRIORITY_LABEL[c.priority]} · ${CASE_STATUS_LABEL[c.status]} — open this case`
      b.addEventListener('click', () => this.openCases({ focus: c.id }))
      chips.appendChild(b)
    }
    if (!mine.length) chips.innerHTML = '<span class="lab-none">Not on a case</span>'
    const select = this.card.querySelector('#lab-card-assign')
    select.innerHTML = ''
    select.appendChild(new Option('Put on a case…', ''))
    for (const c of ordered(cases)) {
      if (c.status === 'closed' || c.assigned.includes(thread.id)) continue
      select.appendChild(new Option(c.title, c.id))
    }
    select.appendChild(new Option('New case with this person…', '__new'))
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
      const s = toScreen(_w.copy(fish.pos).setY(1.4))
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
    for (const fish of reef.staff.order) {
      if (!reef.staff.isShown(fish) || fish.id === selectedId) continue
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
      const s = toScreen(_w.copy(f.pos).setY(f.seated ? 2.15 : 2.6))
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
      const s = toScreen(_w.copy(p.centre).setY(3.3))
      const loud = label.dataset.active || label.classList.contains('urgent')
      const visible = !s.behind && s.y > TOP_BAND && !this.photo && (showAll || loud)
      label.style.opacity = visible ? (loud ? '1' : '0.6') : '0'
      label.style.pointerEvents = visible ? 'auto' : 'none'
      label.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`
    }

    this.compass.style.setProperty('--heading', `${(rig.azimuth * 180) / Math.PI}deg`)
    this._mapClock = (this._mapClock || 0) + 1
    if (this._mapClock % 6 === 0) this._drawMap(reef, rig)

    if (this.settings.get('showFps')) {
      const perf = engine.perf
      const fish = reef.staff.order.length
      this.fps.textContent = `${Math.round(perf.fps)} fps · ${perf.drawCalls} draws · ${fish} staff · ${clock(light.time)}${engine.autoScaled ? ' · scaled' : ''}`
      this.fps.hidden = false
    } else this.fps.hidden = true
  }

  /** The minimap: rooms (departments by state), the core, every person as a dot, and the view. */
  _drawMap(lab, rig) {
    const ctx = this.mapCanvas.getContext('2d')
    const W = this.mapCanvas.width
    const plan = lab.plan
    if (!plan) return
    const b = plan.bounds
    const extent = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) + 2
    const want = extent * 2
    this._mapSpan += (want - this._mapSpan) * (Math.abs(want - this._mapSpan) > 40 ? 1 : 0.15)
    const k = W / this._mapSpan
    const X = (x) => W / 2 + x * k
    const Z = (z) => W / 2 + z * k
    ctx.clearRect(0, 0, W, W)
    ctx.fillStyle = 'rgba(6, 10, 16, 0.85)'
    ctx.beginPath()
    ctx.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.save()
    ctx.beginPath()
    ctx.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2)
    ctx.clip()
    const signal = new Map(lab.projects.map((p) => [p.name, p.signal]))
    for (const c of plan.all.values()) {
      const { x, z } = roomCentre(c)
      let fill = 'rgba(120, 130, 140, 0.18)'
      if (c.kind === 'dept') {
        const s = signal.get(c.project)
        fill = s?.mode ? rgb(s.color) : 'rgba(110, 150, 190, 0.45)'
      } else if (c.kind !== 'corridor') fill = 'rgba(200, 180, 120, 0.45)'
      ctx.fillStyle = fill
      ctx.globalAlpha = c.kind === 'dept' && signal.get(c.project)?.mode ? 0.55 : 1
      ctx.fillRect(X(x - HALF) + 1, Z(z - HALF) + 1, ROOM * k - 2, ROOM * k - 2)
    }
    ctx.globalAlpha = 1
    for (const p of lab.staff.order) {
      if (!lab.staff.isShown(p)) continue
      const loud = p.status === 'waiting' || p.status === 'blocked'
      ctx.fillStyle = STATE_COLOR[p.status] || '#ccc'
      ctx.beginPath()
      ctx.arc(X(p.pos.x), Z(p.pos.z), loud ? 5 : 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
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

  // ── cases ──────────────────────────────────────────────────────────────────────────

  _buildCases(root) {
    const panel = el('aside', 'lab-cases reef-chrome')
    panel.hidden = true
    panel.innerHTML = `
      <header><h3>${icon(mdiBriefcaseOutline, 18)} Case boards</h3>
        <button type="button" class="reef-icon" data-close aria-label="Close">${icon(mdiClose, 16)}</button></header>
      <p class="lab-cases-hint">Each case is a board in the operations room. Put people on it; brief them in their own agent.</p>
      <form class="lab-new" autocomplete="off">
        <input id="lab-new-title" name="title" placeholder="New case — what has to get done?" maxlength="120" required>
        <textarea id="lab-new-brief" name="brief" rows="3" placeholder="The brief: what done looks like, anything they need to know" maxlength="4000"></textarea>
        <div class="lab-new-row">
          <select id="lab-new-priority" name="priority" aria-label="Priority">${PRIORITY.map((p) => `<option value="${p}">${PRIORITY_LABEL[p]}</option>`).join('')}</select>
          <button type="submit" class="lab-primary">${icon(mdiPlus, 16)}<span>Open case</span></button>
        </div>
      </form>
      <ul class="lab-case-list"></ul>`
    panel.querySelector('[data-close]').addEventListener('click', () => this.toggleCases(false))
    const form = panel.querySelector('.lab-new')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const title = form.title.value.trim()
      if (!title) return
      const id = this.actions.createCase({ title, brief: form.brief.value, priority: form.priority.value })
      if (id && this._newFor) this.actions.assign(id, this._newFor)
      this._newFor = null
      form.reset()
      this.renderCases(id)
    })
    root.appendChild(panel)
    this.casesPanel = panel
    this.casesOpen = false
  }

  toggleCases(open = !this.casesOpen) {
    this.casesOpen = open
    this.casesPanel.hidden = !open
    this.casesBtn.classList.toggle('on', open)
    if (open) this.renderCases()
  }

  /** Open the panel, optionally on one case, or ready to open a new case with a worker on it. */
  openCases({ focus = null, newFor = null } = {}) {
    this._newFor = newFor
    this.toggleCases(true)
    if (newFor) {
      const who = this.actions.workerTitle(newFor)
      this.casesPanel.querySelector('#lab-new-title').placeholder = `New case for ${who}`
      this.casesPanel.querySelector('#lab-new-title').focus()
    }
    if (focus) this.renderCases(focus)
  }

  /** Redraw the list. Called whenever the cases or the staff change while it is open. */
  renderCases(focus = null) {
    if (!this.casesOpen) return
    const cases = this.actions.cases()
    const list = this.casesPanel.querySelector('.lab-case-list')
    const open = new Set([...list.querySelectorAll('li.expanded')].map((li) => li.dataset.id))
    if (focus) open.add(focus)
    list.innerHTML = ''
    const workers = this.actions.workers()
    for (const c of ordered(cases)) {
      const li = el('li', `lab-case lab-p-${c.priority}${c.status === 'closed' ? ' closed' : ''}${open.has(c.id) ? ' expanded' : ''}`)
      li.dataset.id = c.id
      const crew = c.assigned.map((id) => ({ id, w: workers.get(id) }))
      li.innerHTML = `
        <button type="button" class="lab-case-head">
          <span class="lab-pri">${PRIORITY_LABEL[c.priority]}</span>
          <b>${escapeHtml(c.title)}</b>
          <small>${CASE_STATUS_LABEL[c.status]} · ${c.assigned.length} on it</small>
        </button>
        <div class="lab-case-body">
          ${c.brief ? `<p class="lab-brief">${escapeHtml(c.brief)}</p>` : ''}
          <div class="lab-crew">${
            crew.length
              ? crew
                  .map(
                    ({ id, w }) =>
                      `<span class="lab-crew-item"><button type="button" class="lab-chip" data-go="${escapeHtml(id)}" style="--c:${w ? STATE_COLOR[w.status] : '#666'}">${escapeHtml((w?.title || 'Off the floor').slice(0, 40))}</button><button type="button" class="lab-x" data-unassign="${escapeHtml(id)}" aria-label="Take off this case">×</button></span>`
                  )
                  .join('')
              : '<span class="lab-none">Nobody on it yet</span>'
          }</div>
          <div class="lab-case-tools">
            <select data-add aria-label="Put someone on this case"><option value="">Add someone…</option>${[...workers.entries()]
              .filter(([id]) => !c.assigned.includes(id))
              .sort((a, b) => (a[1].project || '').localeCompare(b[1].project || '') || (a[1].title || '').localeCompare(b[1].title || ''))
              .map(([id, w]) => `<option value="${escapeHtml(id)}">${escapeHtml(`${w.project} — ${(w.title || '').slice(0, 40)}`)}</option>`)
              .join('')}</select>
            <select data-status aria-label="Case status">${CASE_STATUS.map((s) => `<option value="${s}"${s === c.status ? ' selected' : ''}>${CASE_STATUS_LABEL[s]}</option>`).join('')}</select>
            <select data-priority aria-label="Priority">${PRIORITY.map((p) => `<option value="${p}"${p === c.priority ? ' selected' : ''}>${PRIORITY_LABEL[p]}</option>`).join('')}</select>
          </div>
          <div class="lab-case-actions">
            <select data-brief aria-label="Brief someone"><option value="">Brief someone…</option>${crew
              .filter(({ w }) => w)
              .map(({ id, w }) => `<option value="${escapeHtml(id)}">${escapeHtml((w.title || '').slice(0, 40))}</option>`)
              .join('')}</select>
            <button type="button" data-board>${icon(mdiTarget, 15)}<span>Show board</span></button>
            <button type="button" data-delete class="lab-danger">${icon(mdiTrashCanOutline, 15)}<span>Delete</span></button>
          </div>
        </div>`
      li.querySelector('.lab-case-head').addEventListener('click', () => li.classList.toggle('expanded'))
      for (const b of li.querySelectorAll('[data-go]')) b.addEventListener('click', () => this.actions.selectThread(b.dataset.go))
      for (const b of li.querySelectorAll('[data-unassign]')) b.addEventListener('click', () => this.actions.unassign(c.id, b.dataset.unassign))
      li.querySelector('[data-add]').addEventListener('change', (e) => e.target.value && this.actions.assign(c.id, e.target.value))
      li.querySelector('[data-status]').addEventListener('change', (e) => this.actions.setCaseStatus(c.id, e.target.value))
      li.querySelector('[data-priority]').addEventListener('change', (e) => this.actions.setCasePriority(c.id, e.target.value))
      li.querySelector('[data-brief]').addEventListener('change', (e) => {
        const id = e.target.value
        e.target.value = ''
        if (id) this.actions.brief(c.id, id)
      })
      li.querySelector('[data-board]').addEventListener('click', () => this.actions.showBoard(c.id))
      const del = li.querySelector('[data-delete]')
      del.addEventListener('click', () => {
        // Deleting is a step you confirm here, not in a dialog the page cannot show.
        if (del.dataset.armed) return this.actions.removeCase(c.id)
        del.dataset.armed = '1'
        del.querySelector('span').textContent = 'Delete — sure?'
        setTimeout(() => {
          delete del.dataset.armed
          if (del.isConnected) del.querySelector('span').textContent = 'Delete'
        }, 3000)
      })
      list.appendChild(li)
    }
    if (!list.children.length) list.innerHTML = '<li class="lab-none">No cases yet. Open one above, then put people on it.</li>'
    this.casesBtn.dataset.count = String(Object.values(cases).filter((c) => c.status !== 'closed').length)
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
      const v = s.get(c.key) ?? (c.key === 'labVolume' ? 0.5 : c.type === 'toggle' ? false : '')
      if (c.type === 'toggle') input.checked = Boolean(v)
      else if (document.activeElement !== input) input.value = v
      value.textContent = c.fmt ? c.fmt(Number(v)) : ''
      const preset = PRESETS[base]
      row.classList.toggle('moved', Boolean(preset && c.key in preset.values && preset.values[c.key] !== v))
      if (c.key === 'timeOfDay') row.classList.toggle('disabled', Boolean(s.get('clockTime') || s.get('autoTime')))
      if (c.key === 'labVolume') row.classList.toggle('disabled', !s.get('labSound'))
    }
  }
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export { SIGNAL }
