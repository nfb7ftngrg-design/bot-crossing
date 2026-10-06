/**
 * The reef's sound: off until somebody turns it on, and quiet when it is on.
 *
 * Three layers and nothing else. A low bed of moving water. A faint patter that rises with how
 * many working fish are near the camera, so a busy shelf sounds busy when you are over it. And
 * one distinct, soft two-note call for a thread that has just started waiting on you — the only
 * sound that ever interrupts, at most once every few seconds.
 *
 * Everything is synthesised, so there is nothing to download, and nothing starts until a click
 * gives the browser permission.
 */

export class ReefSound {
  /**
   * `options` lets another world reuse the same three layers in its own key: which settings turn
   * it on and set its volume, how low the bed sits, and how sharp the work sounds are.
   */
  constructor(settings, { enabledKey = 'reefSound', volumeKey = 'reefVolume', bed = 380, work = 2600 } = {}) {
    this.settings = settings
    this.keys = { enabled: enabledKey, volume: volumeKey }
    this.tone = { bed, work }
    this.ctx = null
    this.lastCall = 0
    this.busy = 0
  }

  get enabled() {
    return Boolean(this.settings.get(this.keys.enabled))
  }

  /** Called from a click: browsers only allow audio to start inside a user gesture. */
  unlock() {
    if (!this.enabled) return
    if (!this.ctx) this._build()
    if (this.ctx.state === 'suspended') this.ctx.resume()
  }

  _build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.master.connect(ctx.destination)

    // The bed: brown noise through a low-pass that breathes slowly, like swell overhead.
    const noise = ctx.createBufferSource()
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      data[i] = last * 3.5
    }
    noise.buffer = buffer
    noise.loop = true
    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = this.tone.bed
    const swell = ctx.createOscillator()
    swell.frequency.value = 0.08
    const swellDepth = ctx.createGain()
    swellDepth.gain.value = 140
    swell.connect(swellDepth).connect(lowpass.frequency)
    this.bed = ctx.createGain()
    this.bed.gain.value = 0.5
    noise.connect(lowpass).connect(this.bed).connect(this.master)
    noise.start()
    swell.start()

    // The work patter: band-passed noise ticks, gain set by how busy the view is.
    const tick = ctx.createBufferSource()
    const tickBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const td = tickBuf.getChannelData(0)
    for (let i = 0; i < td.length; i++) td[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.9 : 0
    tick.buffer = tickBuf
    tick.loop = true
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = this.tone.work
    band.Q.value = 3
    this.work = ctx.createGain()
    this.work.gain.value = 0
    tick.connect(band).connect(this.work).connect(this.master)
    tick.start()
  }

  /** Per frame: follow the settings, and how many working fish are close to the camera. */
  update(busyNearby) {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    const volume = this.enabled ? (this.settings.get(this.keys.volume) ?? 0.5) * 0.6 : 0
    this.master.gain.setTargetAtTime(volume, now, 0.3)
    this.busy += (Math.min(1, busyNearby / 5) - this.busy) * 0.05
    this.work.gain.setTargetAtTime(this.busy * 0.5, now, 0.4)
  }

  /** A thread just started waiting on you. Two soft notes, never more often than every 4s. */
  call() {
    if (!this.enabled || !this.ctx) return false
    const now = this.ctx.currentTime
    if (now - this.lastCall < 4) return false
    this.lastCall = now
    for (const [i, freq] of [659.25, 987.77].entries()) {
      const osc = this.ctx.createOscillator()
      const env = this.ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      env.gain.setValueAtTime(0, now + i * 0.16)
      env.gain.linearRampToValueAtTime(0.28, now + i * 0.16 + 0.02)
      env.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 1.1)
      osc.connect(env).connect(this.master)
      osc.start(now + i * 0.16)
      osc.stop(now + i * 0.16 + 1.2)
    }
    return true
  }
}
