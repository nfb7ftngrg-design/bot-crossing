import * as THREE from 'three'
import { mdiCogOutline, mdiRotate3dVariant, mdiHomeOutline, mdiClose, mdiOpenInNew, mdiCheck, mdiArchiveArrowDownOutline, mdiFishbowlOutline } from '@mdi/js'
import { PRESETS } from '../core/settings.js'
import { STATUS_LABEL } from '../game/status.js'

/**
 * Everything on the reef that is read rather than looked at: the counts, the card that rides
 * beside the fish you picked, the shelf names, and the settings drawer. Plain DOM — nothing
 * here belongs in the 3D scene.
 */

const icon = (path, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${path}"/></svg>`

const STATUS_CHIPS = ['waiting', 'blocked', 'working', 'celebrating', 'idle', 'sleeping']

/**
 * The settings drawer. Every knob the presets set is here, marked when it has been moved away
 * from the preset; the rest are the reef's own preferences.
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
  { key: 'particles', label: 'Bubbles & plankton', type: 'select', options: ['off', 'low', 'full'] },
  { key: 'scatterDensity', label: 'Kelp', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'maxAgents', label: 'Most fish shown', type: 'range', min: 20, max: 200, step: 10, fmt: (v) => String(v) },
  { section: 'Light' },
  { key: 'timeOfDay', label: 'Time of day', type: 'range', min: 0, max: 1, step: 0.005, fmt: clock },
  { key: 'clockTime', label: 'Follow my clock', type: 'toggle' },
  { key: 'autoTime', label: 'Run the day', type: 'toggle' },
  { key: 'exposure', label: 'Exposure', type: 'range', min: 0.5, max: 1.8, step: 0.05, fmt: (v) => v.toFixed(2) },
  { section: 'Behaviour' },
  { key: 'followSelected', label: 'Follow the fish I pick', type: 'toggle' },
  { key: 'hideDormant', label: 'Fold away quiet repos', type: 'toggle' },
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

export class Hud {
  constructor(root, settings, actions) {
    this.settings = settings
    this.actions = actions
    this.settingsOpen = false
    this.selection = null

    this.boot = el('div', 'reef-boot', '<div class="reef-boot-dot"></div><span>Diving in…</span>')
    root.appendChild(this.boot)

    // Top left: name and the six counts. Clicking a count steps through the fish in that state.
    const top = el('div', 'reef-top')
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
    this.capNote = el('div', 'reef-cap')
    top.appendChild(this.capNote)
    root.appendChild(top)

    // Top right: the one button that matters most, then the camera and settings.
    const bar = el('div', 'reef-bar')
    this.waitingBtn = el('button', 'reef-waiting', '<b>0</b> waiting <kbd>N</kbd>')
    this.waitingBtn.type = 'button'
    this.waitingBtn.title = 'Fly to the next fish waiting on you'
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
    button(mdiHomeOutline, 'Back to the whole reef (H)', () => actions.home())
    this.settingsBtn = button(mdiCogOutline, 'Settings (,)', () => this.toggleSettings())
    const colony = el('a', 'reef-link', 'Colony')
    colony.href = '/'
    colony.title = 'The same threads as bots'
    bar.appendChild(colony)
    this.colonyLink = colony
    root.appendChild(bar)

    this.labels = el('div', 'reef-labels')
    root.appendChild(this.labels)
    this.labelEls = new Map()

    this.card = el('div', 'reef-card')
    this.card.hidden = true
    this.card.innerHTML = `
      <button class="reef-card-close" type="button" aria-label="Close">${icon(mdiClose, 16)}</button>
      <div class="reef-card-status"><i></i><span></span></div>
      <h2></h2>
      <div class="reef-card-meta"></div>
      <p class="reef-card-preview"></p>
      <div class="reef-card-bar"><div></div></div>
      <div class="reef-card-actions">
        <button type="button" data-act="open">${icon(mdiOpenInNew, 16)}<span>Open</span></button>
        <button type="button" data-act="seen">${icon(mdiCheck, 16)}<span>Seen</span></button>
        <button type="button" data-act="archive">${icon(mdiArchiveArrowDownOutline, 16)}<span>Archive</span></button>
      </div>`
    this.card.querySelector('.reef-card-close').addEventListener('click', () => actions.close())
    for (const b of this.card.querySelectorAll('[data-act]')) b.addEventListener('click', () => actions[b.dataset.act]())
    root.appendChild(this.card)

    this.toastEl = el('div', 'reef-toast')
    root.appendChild(this.toastEl)
    this.fps = el('div', 'reef-fps')
    root.appendChild(this.fps)
    this.keysHint = el('div', 'reef-keys', 'drag to move · right-drag to turn · scroll to zoom · <kbd>N</kbd> next waiting')
    root.appendChild(this.keysHint)

    this._buildSettings(root)
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

  setProjects(projects) {
    const seen = new Set()
    for (const p of projects) {
      seen.add(p.name)
      let label = this.labelEls.get(p.name)
      if (!label) {
        label = el('button', 'reef-label')
        label.type = 'button'
        label.addEventListener('click', () => this.actions.focusProject(p.name))
        this.labels.appendChild(label)
        this.labelEls.set(p.name, label)
      }
      label.innerHTML = `<i style="background:#${p.accent.toString(16).padStart(6, '0')}"></i>${escapeHtml(p.name)}<small>${p.count}</small>`
      label.classList.toggle('urgent', p.urgent)
      label.dataset.active = p.active ? '1' : ''
      label._project = p
    }
    for (const [name, label] of this.labelEls) {
      if (seen.has(name)) continue
      label.remove()
      this.labelEls.delete(name)
    }
  }

  setSelection(fish, thread, status) {
    this.selection = fish ? { fish, thread, status } : null
    if (!fish) {
      this.card.hidden = true
      return
    }
    this.card.hidden = false
    this.card.dataset.status = status
    this.card.querySelector('.reef-card-status span').textContent = fish.mode === 'arriving' ? STATUS_LABEL.spawning : STATUS_LABEL[status] || status
    this.card.querySelector('h2').textContent = thread.title || 'Untitled thread'
    const meta = [thread.project, thread.harnessName || thread.harness, thread.gitBranch].filter(Boolean).map(escapeHtml)
    this.card.querySelector('.reef-card-meta').innerHTML = meta.join(' · ')
    this.card.querySelector('.reef-card-preview').textContent = thread.preview || ''
    this.card.querySelector('.reef-card-bar div').style.width = `${Math.round(this.actions.progressFor(thread.id) * 100)}%`
    this.card.querySelector('[data-act="open"]').disabled = thread.canOpen === false
    this.card.querySelector('[data-act="seen"]').hidden = status !== 'waiting'
    this.card.querySelector('[data-act="archive"]').disabled = Boolean(thread.parentId)
  }

  /** Per frame: the card and the shelf names follow the world on screen. */
  frame(engine, rig, reef, selectedId, light) {
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
      // Parked beside the fish rather than on top of it, flipping sides near the edge.
      let x = s.x + 34
      if (x + w > window.innerWidth - 12) x = s.x - 34 - w
      const y = Math.min(window.innerHeight - h - 12, Math.max(64, s.y - h / 2))
      this.card.style.transform = `translate(${Math.round(Math.max(12, x))}px, ${Math.round(y)}px)`
      this.card.style.opacity = s.behind ? '0' : '1'
    }

    const showAll = rig.distance < 70 && this.settings.get('showLabels') !== false
    for (const label of this.labelEls.values()) {
      const p = label._project
      if (!p) continue
      const s = toScreen(_w.copy(p.centre).setY(p.centre.y + 3.2))
      const visible = !s.behind && (showAll || label.dataset.active || label.classList.contains('urgent'))
      label.style.opacity = visible ? (label.dataset.active || label.classList.contains('urgent') ? '1' : '0.6') : '0'
      label.style.pointerEvents = visible ? 'auto' : 'none'
      label.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`
    }

    if (this.settings.get('showFps')) {
      const perf = engine.perf
      const fish = reef.school.order.length
      this.fps.textContent = `${Math.round(perf.fps)} fps · ${perf.drawCalls} draws · ${fish} fish · ${clock(light.time)}${engine.autoScaled ? ' · scaled' : ''}`
      this.fps.hidden = false
    } else this.fps.hidden = true
  }

  // ── settings ──────────────────────────────────────────────────────────────────────────

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

  syncSettings() {
    const s = this.settings
    const active = s.get('preset')
    for (const [name, b] of Object.entries(this.presetEls)) b.classList.toggle('on', name === active)
    this.presetHint.textContent = PRESETS[active]?.hint || 'custom — a knob was moved away from its preset'
    for (const { c, row, input, value } of this.controlEls) {
      const v = s.get(c.key)
      if (c.type === 'toggle') input.checked = Boolean(v)
      else if (document.activeElement !== input) input.value = v
      value.textContent = c.fmt ? c.fmt(Number(v)) : ''
      // Moved away from whatever the last preset said — custom or not.
      const preset = PRESETS[active] || PRESETS[s._lastPreset]
      row.classList.toggle('moved', Boolean(preset && c.key in preset.values && preset.values[c.key] !== v))
      if (c.key === 'timeOfDay') row.classList.toggle('disabled', Boolean(s.get('clockTime') || s.get('autoTime')))
    }
    if (PRESETS[active]) s._lastPreset = active
  }
}

const _v = new THREE.Vector3()
const _w = new THREE.Vector3()

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
