import type { AudioLevels, AudioParams, AudioSource, BandEnvelope } from '../../../shared/params'

// Band edges in Hz, per brief: sub / bass / mid / treble
const BANDS = {
  sub: [20, 60],
  bass: [60, 150],
  mid: [200, 2000],
  treble: [4000, 14000]
} as const

const FLUX_HISTORY = 90 // ~1.5s of context for the adaptive threshold

// Per-drum onset detection: spectral flux in the drum's home range, normalized
// by the band's current level (volume-independent), against a median+MAD
// adaptive threshold (robust — the mean+std version drifted upward on every
// loud section and started missing hits). Tuned for techno/EDM.
type DrumKey = 'kick' | 'snare' | 'hat'
const DRUMS: Record<DrumKey, {
  range: [number, number]
  refractoryS: number
  releaseMs: number
  /** noise gate: band must carry real energy for an onset to count */
  minLevel: number
  kMul: number
}> = {
  kick: { range: [30, 120], refractoryS: 0.12, releaseMs: 180, minLevel: 0.04, kMul: 1.0 },
  snare: { range: [700, 3500], refractoryS: 0.12, releaseMs: 150, minLevel: 0.03, kMul: 1.15 },
  hat: { range: [6000, 14000], refractoryS: 0.055, releaseMs: 90, minLevel: 0.02, kMul: 1.05 }
}

interface OnsetState {
  history: number[]
  lastAt: number
  level: number
  fired: boolean
}

// --- tempo lock ------------------------------------------------------------
// 4-on-floor music has a metronomic kick; once enough onsets agree on a period
// the grid predicts every beat, and a kick the flux detector misses (masked by
// a bassline, ducked by a limiter…) is filled in exactly on time.
const BPM_MIN = 70
const BPM_MAX = 190
const GRID_HISTORY = 24
/** fraction of intervals that must agree before the grid may fill beats */
const GRID_CONFIDENT = 0.55

export class AudioEngine {
  private ctx: AudioContext
  private analyser: AnalyserNode
  private input: GainNode
  private monitor: GainNode

  private sourceKind: AudioSource = 'none'
  private currentDeviceId = ''
  private stream: MediaStream | null = null
  private streamSource: MediaStreamAudioSourceNode | null = null
  private fileSource: AudioBufferSourceNode | null = null
  private fileBuffer: AudioBuffer | null = null
  private demoStop: (() => void) | null = null
  private noiseBuffer: AudioBuffer | null = null

  private freq: Uint8Array<ArrayBuffer>
  private prevFreq: Uint8Array<ArrayBuffer>
  private env = { sub: 0, bass: 0, mid: 0, treble: 0 }
  private onsets: Record<DrumKey, OnsetState> = {
    kick: { history: [], lastAt: -10, level: 0, fired: false },
    snare: { history: [], lastAt: -10, level: 0, fired: false },
    hat: { history: [], lastAt: -10, level: 0, fired: false }
  }

  // tempo lock: real kick onset times → period estimate → predicted grid
  private kickTimes: number[] = []
  private gridPeriod = 0
  private gridConfidence = 0
  private nextGridBeat = 0
  // auto-gain for `energy`: normalize to the track's own rolling peak so a
  // quietly-mixed input still swings the full 0–1 (drives the speed coupling)
  private energyPeak = 0.15

  readonly levels: AudioLevels = {
    sub: 0, bass: 0, mid: 0, treble: 0,
    kick: 0, snare: 0, hat: 0, energy: 0, beat: 0, bpm: 0,
    onKick: false, onSnare: false, onHat: false, onBeat: false
  }

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0 // envelopes below do the smoothing
    this.analyser.minDecibels = -85
    this.analyser.maxDecibels = -10

    this.input = this.ctx.createGain()
    this.monitor = this.ctx.createGain()
    this.monitor.gain.value = 0
    this.input.connect(this.analyser)
    this.input.connect(this.monitor)
    this.monitor.connect(this.ctx.destination)

    this.freq = new Uint8Array(this.analyser.frequencyBinCount)
    this.prevFreq = new Uint8Array(this.analyser.frequencyBinCount)
  }

  /** idempotent — call whenever state.audio changes */
  async applyConfig(p: AudioParams): Promise<void> {
    this.input.gain.value = p.inputGain
    // never monitor a live input device — instant feedback loop
    const monitorable = p.source === 'file' || p.source === 'demo'
    this.monitor.gain.value = p.monitor && monitorable ? 1 : 0

    const deviceChanged = p.source === 'device' && p.deviceId !== this.currentDeviceId
    if (p.source !== this.sourceKind || deviceChanged) {
      await this.switchSource(p)
    }
  }

  async loadFile(data: ArrayBuffer): Promise<void> {
    this.fileBuffer = await this.ctx.decodeAudioData(data)
    if (this.sourceKind === 'file') {
      this.stopFileSource()
      this.startFileSource()
    }
  }

  private async switchSource(p: AudioParams): Promise<void> {
    this.teardownSource()
    this.sourceKind = p.source
    this.currentDeviceId = p.deviceId
    if (this.ctx.state === 'suspended') await this.ctx.resume()

    switch (p.source) {
      case 'device': {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: p.deviceId ? { exact: p.deviceId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          })
          this.streamSource = this.ctx.createMediaStreamSource(this.stream)
          this.streamSource.connect(this.input)
        } catch (err) {
          console.error('audio input failed:', err)
          this.sourceKind = 'none'
        }
        break
      }
      case 'file':
        if (this.fileBuffer) this.startFileSource()
        break
      case 'demo':
        this.startDemo()
        break
      case 'none':
        break
    }
  }

  private teardownSource(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.streamSource?.disconnect()
    this.streamSource = null
    this.stopFileSource()
    this.demoStop?.()
    this.demoStop = null
  }

  private startFileSource(): void {
    if (!this.fileBuffer) return
    const src = this.ctx.createBufferSource()
    src.buffer = this.fileBuffer
    src.loop = true
    src.connect(this.input)
    src.start()
    this.fileSource = src
  }

  private stopFileSource(): void {
    try {
      this.fileSource?.stop()
    } catch {
      /* already stopped */
    }
    this.fileSource?.disconnect()
    this.fileSource = null
  }

  // --- demo synth: kick / hat / clap / arp at 124 BPM ------------------------
  private startDemo(): void {
    const ctx = this.ctx
    const out = ctx.createGain()
    out.gain.value = 0.9
    out.connect(this.input)

    const bpm = 124
    const spb = 60 / bpm
    let next = ctx.currentTime + 0.1
    let beat = 0
    const arpNotes = [220, 277.18, 329.63, 277.18]

    // lookahead scheduler — setInterval jitter never reaches the audio clock
    const timer = window.setInterval(() => {
      while (next < ctx.currentTime + 0.2) {
        this.kick(out, next)
        this.hat(out, next + spb / 2)
        if (beat % 2 === 1) this.clap(out, next)
        this.arp(out, next, arpNotes[beat % arpNotes.length])
        next += spb
        beat++
      }
    }, 40)

    this.demoStop = () => {
      window.clearInterval(timer)
      out.disconnect()
    }
  }

  private kick(out: AudioNode, t: number): void {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12)
    g.gain.setValueAtTime(1.0, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    osc.connect(g)
    g.connect(out)
    osc.start(t)
    osc.stop(t + 0.3)
  }

  private noise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const len = this.ctx.sampleRate
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = this.noiseBuffer.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    return this.noiseBuffer
  }

  private noiseHit(out: AudioNode, t: number, filterType: BiquadFilterType, freq: number, gain: number, decay: number): void {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noise()
    const f = ctx.createBiquadFilter()
    f.type = filterType
    f.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + decay)
    src.connect(f)
    f.connect(g)
    g.connect(out)
    src.start(t)
    src.stop(t + decay + 0.05)
  }

  private hat(out: AudioNode, t: number): void {
    this.noiseHit(out, t, 'highpass', 7000, 0.14, 0.06)
  }

  private clap(out: AudioNode, t: number): void {
    this.noiseHit(out, t, 'bandpass', 1800, 0.35, 0.18)
  }

  private arp(out: AudioNode, t: number, freq: number): void {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = freq
    g.gain.setValueAtTime(0.09, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
    osc.connect(g)
    g.connect(out)
    osc.start(t)
    osc.stop(t + 0.22)
  }

  // --- per-frame analysis -----------------------------------------------------
  update(dt: number, p: AudioParams, nowSec: number): AudioLevels {
    const l = this.levels
    l.onKick = l.onSnare = l.onHat = l.onBeat = false

    if (this.sourceKind === 'none') {
      // release everything to silence
      for (const key of ['sub', 'bass', 'mid', 'treble'] as const) {
        this.env[key] = this.follow(this.env[key], 0, p[key], dt)
        l[key] = this.env[key]
      }
      for (const key of Object.keys(DRUMS) as DrumKey[]) {
        const o = this.onsets[key]
        o.level = this.follow(o.level, 0, { attackMs: 1, releaseMs: DRUMS[key].releaseMs }, dt)
        l[key] = o.level
      }
      this.kickTimes.length = 0
      this.gridConfidence = 0
      l.bpm = 0
      l.energy = 0.25 * l.sub + 0.35 * l.bass + 0.25 * l.mid + 0.15 * l.treble
      l.beat = l.kick
      return l
    }

    this.prevFreq.set(this.freq)
    this.analyser.getByteFrequencyData(this.freq)
    const binHz = this.ctx.sampleRate / 2 / this.analyser.frequencyBinCount

    for (const key of ['sub', 'bass', 'mid', 'treble'] as const) {
      const [lo, hi] = BANDS[key]
      const raw = this.bandLevel(lo, hi, binHz)
      this.env[key] = this.follow(this.env[key], raw, p[key], dt)
      l[key] = this.env[key]
    }

    for (const key of Object.keys(DRUMS) as DrumKey[]) {
      this.detectOnset(key, binHz, p.beatSensitivity, nowSec, dt)
      l[key] = this.onsets[key].level
    }
    if (this.onsets.kick.fired) this.trackTempo(nowSec)
    this.gridFillKick(nowSec)
    l.bpm = this.gridConfidence >= GRID_CONFIDENT && this.gridPeriod > 0 ? 60 / this.gridPeriod : 0

    l.onKick = this.onsets.kick.fired
    l.onSnare = this.onsets.snare.fired
    l.onHat = this.onsets.hat.fired
    // bass-weighted loudness, auto-gained against the track's own peak —
    // absolute input level stops deciding how "strong" the visuals feel
    const rawEnergy = 0.25 * l.sub + 0.35 * l.bass + 0.25 * l.mid + 0.15 * l.treble
    this.energyPeak = Math.max(this.energyPeak * Math.exp(-dt * 0.05), rawEnergy, 0.12)
    l.energy = Math.min(rawEnergy / this.energyPeak, 1)
    l.beat = l.kick
    l.onBeat = l.onKick
    return l
  }

  /** volume-normalized spectral flux vs a median+MAD adaptive threshold */
  private detectOnset(key: DrumKey, binHz: number, sensitivity: number, nowSec: number, dt: number): void {
    const cfg = DRUMS[key]
    const o = this.onsets[key]
    o.fired = false

    const rawFlux = this.spectralFlux(cfg.range[0], cfg.range[1], binHz)
    const bandLvl = this.bandLevel(cfg.range[0], cfg.range[1], binHz)
    // normalize by the band's own loudness: a hit in a quiet mix scores like a
    // hit in a slammed mix, and a sustained loud pad stops eating the threshold
    const flux = rawFlux / (0.08 + bandLvl)
    o.history.push(flux)
    if (o.history.length > FLUX_HISTORY) o.history.shift()

    if (o.history.length > 24) {
      const sorted = [...o.history].sort((a, b) => a - b)
      const median = sorted[sorted.length >> 1]
      const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
      const mad = deviations[deviations.length >> 1]
      // 1.4826·MAD ≈ std for normal data, but immune to the outliers (the hits
      // themselves) that used to inflate a mean+std threshold
      const spread = Math.max(1.4826 * mad, 0.02)
      const threshold = median + sensitivity * cfg.kMul * spread * 2.2
      if (flux > threshold && bandLvl > cfg.minLevel && nowSec - o.lastAt > cfg.refractoryS) {
        o.lastAt = nowSec
        const intensity = Math.min((flux - threshold) / (threshold + 1e-6), 1)
        o.level = Math.max(o.level, 0.5 + 0.5 * intensity)
        o.fired = true
      }
    }
    o.level = this.follow(o.level, 0, { attackMs: 1, releaseMs: cfg.releaseMs }, dt)
  }

  /** fold kick inter-onset intervals into one beat period + confidence */
  private trackTempo(nowSec: number): void {
    const times = this.kickTimes
    if (times.length > 0 && nowSec - times[times.length - 1] > 2.5) times.length = 0 // stale grid
    times.push(nowSec)
    if (times.length > GRID_HISTORY) times.shift()
    if (times.length < 5) return

    const pMin = 60 / BPM_MAX
    const pMax = 60 / BPM_MIN
    const folded: number[] = []
    for (let i = 1; i < times.length; i++) {
      let iv = times[i] - times[i - 1]
      // halve/double into the plausible-tempo octave (missed beats → 2× gaps)
      while (iv > pMax && iv / 2 >= pMin) iv /= 2
      while (iv < pMin && iv * 2 <= pMax) iv *= 2
      if (iv >= pMin && iv <= pMax) folded.push(iv)
    }
    if (folded.length < 4) return

    // mode by clustering around the median, then average the cluster
    folded.sort((a, b) => a - b)
    const med = folded[folded.length >> 1]
    const cluster = folded.filter((v) => Math.abs(v - med) < med * 0.06)
    this.gridConfidence = cluster.length / folded.length
    if (cluster.length >= 3) {
      this.gridPeriod = cluster.reduce((a, b) => a + b, 0) / cluster.length
      // re-phase on every real kick — drift never accumulates
      this.nextGridBeat = nowSec + this.gridPeriod
    }
  }

  /** confident grid + arrived beat time + real bass energy → fill the missed kick */
  private gridFillKick(nowSec: number): void {
    const o = this.onsets.kick
    if (o.fired) return
    if (this.gridConfidence < GRID_CONFIDENT || this.gridPeriod <= 0) return
    const last = this.kickTimes[this.kickTimes.length - 1] ?? -10
    // grid predicts, it doesn't freewheel: stop filling 2 bars after real kicks stop
    if (nowSec - last > this.gridPeriod * 8) return
    if (nowSec < this.nextGridBeat) return
    this.nextGridBeat += this.gridPeriod
    if (this.env.sub + this.env.bass < 0.08) return // break/drop-out — stay silent
    o.lastAt = nowSec
    o.level = Math.max(o.level, 0.7)
    o.fired = true
  }

  private bandLevel(lo: number, hi: number, binHz: number): number {
    const from = Math.max(0, Math.floor(lo / binHz))
    const to = Math.min(this.freq.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    for (let i = from; i <= to; i++) sum += this.freq[i]
    return sum / ((to - from + 1) * 255)
  }

  private spectralFlux(lo: number, hi: number, binHz: number): number {
    const from = Math.max(0, Math.floor(lo / binHz))
    const to = Math.min(this.freq.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    for (let i = from; i <= to; i++) {
      const d = this.freq[i] - this.prevFreq[i]
      if (d > 0) sum += d
    }
    return sum / ((to - from + 1) * 255)
  }

  /** classic envelope follower — separate attack/release time constants */
  private follow(current: number, target: number, env: BandEnvelope, dt: number): number {
    const tauMs = target > current ? env.attackMs : env.releaseMs
    const coef = 1 - Math.exp((-dt * 1000) / Math.max(tauMs, 1))
    return current + (target - current) * coef
  }
}
