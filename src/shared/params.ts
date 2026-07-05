// Single source of truth for app state shape. Main process owns the live copy;
// renderers hold synced replicas and send partial patches over IPC.

import { DEFAULT_PALETTE } from './palettes'

export interface SimParams {
  paused: boolean
  /** global time scale — slow the whole sim down without touching forces */
  speed: number
  /** sim grid min-dimension (velocity/pressure), 128–256 */
  simRes: number
  /** dye texture min-dimension, 512–2048 */
  dyeRes: number
  densityDissipation: number
  velocityDissipation: number
  /** pressure field damping between frames (0–1) */
  pressure: number
  pressureIterations: number
  /** vorticity confinement strength — this makes the curls */
  curl: number
  /** 0.01–1, divided by 100 before hitting the shader */
  splatRadius: number
  splatForce: number
  /** MacCormack advection for dye (sharper); off = plain semi-Lagrangian */
  maccormack: boolean
}

/** resolved render styles — 'auto' picks paper/ink from the palette's mode */
export type FluidStyle = 'ink' | 'paper' | 'oil' | 'contour' | 'neon' | 'smoke' | 'flow'
export type StyleParam = 'auto' | FluidStyle
/** styles composing subtractively on light paper (no bloom/sunrays) */
export const PAPER_STYLES: readonly FluidStyle[] = ['paper', 'oil', 'contour']

export interface VisualParams {
  /** render style variant */
  style: StyleParam
  /** key into PALETTES */
  palette: string
  /** how fast splat colors sweep along the palette gradient */
  colorCycleSpeed: number
  /** 0 = all splats share the cycle color, 1 = every splat lands anywhere on the gradient */
  colorSpread: number
  shading: boolean
  bloom: boolean
  bloomIntensity: number
  bloomThreshold: number
  bloomSoftKnee: number
  sunrays: boolean
  sunraysWeight: number
  sunraysDensity: number
  sunraysDecay: number
  exposure: number
  contrast: number
  saturation: number
  lift: number
  gamma: number
  gain: number
  vignette: number
  grain: number
  /** paper tooth + pigment granulation amount (paper styles), 0 = smooth */
  texture: number
  /** radial falloff amount of the background color */
  bgGradient: number
}

export type AudioSource = 'none' | 'device' | 'file' | 'demo'

export interface BandEnvelope {
  attackMs: number
  releaseMs: number
}

export interface AudioParams {
  source: AudioSource
  /** getUserMedia deviceId ('' = default input) */
  deviceId: string
  /** play file/demo audio out loud (device input is never monitored — feedback) */
  monitor: boolean
  /** master gain into the analyser */
  inputGain: number
  sub: BandEnvelope
  bass: BandEnvelope
  mid: BandEnvelope
  treble: BandEnvelope
  /** beat detection: threshold = mean + k·std of spectral flux */
  beatSensitivity: number
}

export type ModSource = 'none' | 'sub' | 'bass' | 'mid' | 'treble' | 'beat' | 'kick' | 'snare' | 'hat' | 'energy'
export type ModCurve = 'linear' | 'pow2' | 'sqrt'

export interface Mapping {
  source: ModSource
  amount: number
  curve: ModCurve
}

/** fluid params that can be driven by audio */
export type MappableParam =
  | 'splatForce'
  | 'splatRadius'
  | 'curl'
  | 'emitterSpeed'
  | 'hueShift'
  | 'bloomIntensity'
  | 'simSpeed'

export type Mappings = Record<MappableParam, Mapping>

export interface EmitterParams {
  orbit: {
    enabled: boolean
    count: number
    radius: number
    /** revolutions per second */
    speed: number
    force: number
  }
  beatBurst: {
    enabled: boolean
    count: number
    force: number
  }
  /** velocity-only radial shove on every beat — the whole canvas throbs with the kick */
  pulse: {
    enabled: boolean
    force: number
  }
  /** bright fast splash on each snare/clap */
  snareSplash: {
    enabled: boolean
    count: number
    force: number
  }
  /** tiny specks on each hi-hat tick */
  hatSparkle: {
    enabled: boolean
    count: number
  }
  edgeFlow: {
    enabled: boolean
    /** splats per second */
    rate: number
    force: number
  }
  /** auto drop every few seconds while no audio source is active */
  idleDrip: {
    enabled: boolean
  }
}

export type ResolutionPreset = 'window' | '1280x720' | '1920x1080' | '2560x1080' | '3840x1080' | 'custom'

/**
 * LED floor fed over its own NDI sender. The floor is SEAMLESS with the wall:
 * one shared sim spans wall + floor, the floor view is the band below the
 * wall's bottom edge — ink flows across the seam unbroken.
 */
export interface FloorParams {
  enabled: boolean
  width: number
  height: number
  /** where the floor attaches along the wall's width (0 = left, 0.5 = center) */
  offsetX: number
  /** inset preview of the floor feed in the main window (shows up in recordings) */
  preview: boolean
}

export interface OutputParams {
  /** render resolution — fixed presets letterbox inside the window */
  resolution: ResolutionPreset
  customWidth: number
  customHeight: number
  /** NDI video out (sender name "LIQUID") */
  ndi: boolean
  ndiFps: number
  /** preset switch fade time (seconds) */
  crossfadeSec: number
  floor: FloorParams
}

export interface AppState {
  /** bump when default tuning changes — old saved tuning is dropped on load */
  tuningRev: number
  sim: SimParams
  visual: VisualParams
  audio: AudioParams
  mappings: Mappings
  emitters: EmitterParams
  output: OutputParams
}

const defaultMapping = (source: ModSource, amount: number): Mapping => ({
  source,
  amount,
  curve: 'linear'
})

export const defaultState: AppState = {
  tuningRev: 2,
  sim: {
    paused: false,
    speed: 0.65,
    simRes: 256,
    dyeRes: 1440,
    // stains bloom, hold a few seconds, then breathe out — quiet music clears the canvas
    densityDissipation: 0.55,
    velocityDissipation: 0.9,
    pressure: 0.8,
    pressureIterations: 24,
    curl: 14,
    splatRadius: 0.32,
    splatForce: 12000,
    maccormack: true
  },
  visual: {
    style: 'auto',
    palette: DEFAULT_PALETTE,
    colorCycleSpeed: 0.08,
    colorSpread: 1.0,
    shading: true,
    bloom: true,
    bloomIntensity: 0.7,
    bloomThreshold: 0.55,
    bloomSoftKnee: 0.7,
    sunrays: true,
    sunraysWeight: 0.5,
    sunraysDensity: 0.35,
    sunraysDecay: 0.94,
    exposure: 1.0,
    contrast: 1.05,
    saturation: 1.25,
    lift: 0.0,
    gamma: 1.0,
    gain: 1.0,
    vignette: 0.25,
    grain: 0,
    texture: 0.15,
    bgGradient: 0.35
  },
  audio: {
    source: 'none',
    deviceId: '',
    monitor: true,
    inputGain: 1.0,
    sub: { attackMs: 20, releaseMs: 280 },
    bass: { attackMs: 15, releaseMs: 240 },
    mid: { attackMs: 25, releaseMs: 260 },
    treble: { attackMs: 12, releaseMs: 180 },
    beatSensitivity: 1.15
  },
  mappings: {
    splatForce: defaultMapping('bass', 0.6),
    splatRadius: defaultMapping('sub', 0.3),
    curl: defaultMapping('none', 0.5),
    emitterSpeed: defaultMapping('mid', 0.5),
    hueShift: defaultMapping('treble', 0.25),
    bloomIntensity: defaultMapping('kick', 0.4),
    // quiet music → the fluid crawls; loud sections → it races
    simSpeed: defaultMapping('energy', 1.2)
  },
  emitters: {
    // audio is the main motion source — no constant streams by default
    orbit: { enabled: false, count: 2, radius: 0.25, speed: 0.06, force: 500 },
    beatBurst: { enabled: true, count: 1, force: 2400 },
    // fluid pulse warps the whole flow into a standing vortex — off unless you want that
    pulse: { enabled: false, force: 600 },
    snareSplash: { enabled: true, count: 2, force: 2400 },
    hatSparkle: { enabled: true, count: 2 },
    edgeFlow: { enabled: false, rate: 4, force: 1200 },
    idleDrip: { enabled: true }
  },
  output: {
    resolution: 'custom',
    customWidth: 2836,
    customHeight: 1080,
    ndi: false,
    ndiFps: 60,
    crossfadeSec: 1.2,
    floor: {
      enabled: true,
      width: 2836,
      height: 2660,
      offsetX: 0.5,
      preview: true
    }
  }
}

/** what a preset snapshots — output/NDI and audio routing stay global */
export interface PresetData {
  sim: SimParams
  visual: VisualParams
  mappings: Mappings
  emitters: EmitterParams
  audioTuning: {
    sub: BandEnvelope
    bass: BandEnvelope
    mid: BandEnvelope
    treble: BandEnvelope
    beatSensitivity: number
  }
}

export interface PresetEntry {
  name: string
  data: PresetData
}

export const NDI_SENDER_NAME = 'LIQUID'
export const NDI_FLOOR_NAME = 'LIQUID FLOOR'

export interface NdiFrameMeta {
  name: string
  width: number
  height: number
  fps: number
}

export interface NdiStatus {
  available: boolean
  loadError: string | null
  senders: { name: string; width: number; height: number; fps: number; frames: number; dropped: number }[]
}

/** band levels + drum onsets streamed output → control for the meters */
export interface AudioLevels {
  sub: number
  bass: number
  mid: number
  treble: number
  /** per-drum onset envelopes (0–1) */
  kick: number
  snare: number
  hat: number
  /** overall loudness — weighted band mix, smoothed */
  energy: number
  /** alias of kick — kept for existing mappings */
  beat: number
  /** tempo-lock estimate from kick onsets; 0 = not locked */
  bpm: number
  onKick: boolean
  onSnare: boolean
  onHat: boolean
  /** alias of onKick */
  onBeat: boolean
}
