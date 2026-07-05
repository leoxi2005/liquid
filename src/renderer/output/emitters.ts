import type { AudioLevels, EmitterParams } from '../../shared/params'
import type { FluidSolver } from '../engine/solver/FluidSolver'
import type { RGB } from '../engine/color'

export interface EmitterEnv {
  levels: AudioLevels
  /** live multiplier from the 'emitterSpeed' mapping */
  speedMult: number
  aspect: number
  splatRadius: number
  /**
   * palette-sampled dye color; scale ≈ brightness per splat.
   * `at` pins the palette position (0–1) — each drum keeps its own color
   * identity so the eye can attribute every mark to its sound
   */
  color: (scale: number, at?: number) => RGB
  /** true when an audio source is active — silences the idle drip */
  audioActive: boolean
}

// fixed palette homes: kick / snare / hat each own a hue region
const KICK_AT = 0.12
const SNARE_AT = 0.55
const HAT_AT = 0.88

export class Emitters {
  private orbitAngle = Math.random() * Math.PI * 2
  private edgeAccum = 0
  private dripTimer = 1.5

  update(dt: number, e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    if (e.orbit.enabled) this.orbit(dt, e, solver, env)
    if (e.beatBurst.enabled && env.levels.onKick) this.beatBurst(e, solver, env)
    if (e.pulse.enabled && env.levels.onKick) this.pulse(e, solver, env)
    if (e.snareSplash.enabled && env.levels.onSnare) this.snareSplash(e, solver, env)
    if (e.hatSparkle.enabled && env.levels.onHat) this.hatSparkle(e, solver, env)
    if (e.edgeFlow.enabled) this.edgeFlow(dt, e, solver, env)
    if (e.idleDrip.enabled && !env.audioActive) this.idleDrip(dt, solver, env)
  }

  // Spatial anchoring: each drum owns a fixed screen region so the eye reads
  // sound→visual causation instantly — random placement, even perfectly
  // beat-timed, reads as noise.

  private snareSide = 1

  /** SNARE → call-and-response splash, alternating left / right anchor, streaking inward */
  private snareSplash(e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    this.snareSide = -this.snareSide
    const strength = 0.7 + 0.7 * env.levels.snare
    for (let i = 0; i < e.snareSplash.count; i++) {
      const x = 0.5 + this.snareSide * 0.26 + (Math.random() - 0.5) * 0.05
      const y = 0.5 + (Math.random() - 0.5) * 0.16
      const dx = -this.snareSide * e.snareSplash.force * strength
      const dy = (Math.random() - 0.5) * e.snareSplash.force * 0.25
      solver.splat(x, y, dx, dy, env.color(1.0, SNARE_AT), env.splatRadius * 1.1)
    }
  }

  private hatStep = 0

  /** HATS → small ticks marching left→right along the top — a rhythm ticker */
  private hatSparkle(e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    for (let i = 0; i < e.hatSparkle.count; i++) {
      this.hatStep = (this.hatStep + 1) % 8
      const x = 0.16 + (this.hatStep / 7) * 0.68
      const y = 0.82
      const f = 300 + env.levels.hat * 300
      solver.splat(x, y, 0, -f, env.color(0.55, HAT_AT), env.splatRadius * 0.4)
    }
  }

  /** dye-less velocity ring — every kick physically shoves the existing ink outward */
  private pulse(e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    const f = e.pulse.force * (0.5 + env.levels.beat)
    const ring = 8
    for (let i = 0; i < ring; i++) {
      const ang = (i * Math.PI * 2) / ring
      const x = 0.5 + (Math.cos(ang) * 0.18) / env.aspect
      const y = 0.5 + Math.sin(ang) * 0.18
      solver.splat(x, y, Math.cos(ang) * f, Math.sin(ang) * f, [0, 0, 0], env.splatRadius * 2.5)
    }
  }

  /** no audio → let a drop fall every few seconds so the paper never sits empty */
  private idleDrip(dt: number, solver: FluidSolver, env: EmitterEnv): void {
    this.dripTimer -= dt
    if (this.dripTimer > 0) return
    this.dripTimer = 2 + Math.random() * 3
    const x = 0.12 + Math.random() * 0.76
    const y = 0.15 + Math.random() * 0.7
    const ang = Math.random() * Math.PI * 2
    const f = 250 + Math.random() * 350
    solver.splat(x, y, Math.cos(ang) * f, Math.sin(ang) * f, env.color(0.7), env.splatRadius * 1.5)
    solver.splat(x, y, 0, 0, env.color(0.12), env.splatRadius * 2.6)
  }

  /** points circling the center, pushing tangentially — continuous swirl bed */
  private orbit(dt: number, e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    this.orbitAngle += dt * e.orbit.speed * env.speedMult * Math.PI * 2
    for (let i = 0; i < e.orbit.count; i++) {
      const ang = this.orbitAngle + (i * Math.PI * 2) / e.orbit.count
      const x = 0.5 + (Math.cos(ang) * e.orbit.radius) / env.aspect
      const y = 0.5 + Math.sin(ang) * e.orbit.radius
      const dx = -Math.sin(ang) * e.orbit.force
      const dy = Math.cos(ang) * e.orbit.force
      // emitted every frame → keep individual splats dim and slim
      solver.splat(x, y, dx, dy, env.color(0.03), env.splatRadius * 0.55)
    }
  }

  /** KICK → center boom: dense core + petals thrown outward, size follows hit strength */
  private beatBurst(e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    const strength = 0.7 + 1.0 * env.levels.beat
    for (let i = 0; i < e.beatBurst.count; i++) {
      const x = 0.5 + (Math.random() - 0.5) * 0.08
      const y = 0.5 + (Math.random() - 0.5) * 0.08
      const ang = Math.random() * Math.PI * 2
      const dx = Math.cos(ang) * e.beatBurst.force * strength
      const dy = Math.sin(ang) * e.beatBurst.force * strength
      // dense core + thin halo wash — one drop, two tonal layers.
      // radius scales with the hit: soft kicks whisper, hard kicks boom
      solver.splat(x, y, dx, dy, env.color(0.9, KICK_AT), env.splatRadius * (1.6 + env.levels.beat * 1.4))
      solver.splat(x, y, dx * 0.2, dy * 0.2, env.color(0.1, KICK_AT), env.splatRadius * 3.0)
      // petals: dye thrown radially so the hit reads as an explosion, not a dot.
      // random phase each kick — a fixed geometry repeated on the 4-on-floor
      // builds standing circulation that sucks everything into a center blob
      const petals = 6
      const phase = Math.random() * Math.PI * 2
      for (let k = 0; k < petals; k++) {
        const pa = phase + (k * Math.PI * 2) / petals
        const px = x + (Math.cos(pa) * 0.05) / env.aspect
        const py = y + Math.sin(pa) * 0.05
        const pf = e.beatBurst.force * strength * 0.45
        solver.splat(px, py, Math.cos(pa) * pf, Math.sin(pa) * pf, env.color(0.3, KICK_AT), env.splatRadius * 0.6)
      }
    }
  }

  /** streams pushing in from the borders — reads well on ultra-wide */
  private edgeFlow(dt: number, e: EmitterParams, solver: FluidSolver, env: EmitterEnv): void {
    this.edgeAccum += e.edgeFlow.rate * dt
    while (this.edgeAccum >= 1) {
      this.edgeAccum -= 1
      const side = Math.floor(Math.random() * 4)
      const along = 0.1 + Math.random() * 0.8
      const skew = (Math.random() - 0.5) * 0.7
      const f = e.edgeFlow.force
      let x: number, y: number, dx: number, dy: number
      switch (side) {
        case 0: x = 0.005; y = along; dx = f; dy = f * skew; break
        case 1: x = 0.995; y = along; dx = -f; dy = f * skew; break
        case 2: x = along; y = 0.005; dx = f * skew; dy = f; break
        default: x = along; y = 0.995; dx = f * skew; dy = -f; break
      }
      solver.splat(x, y, dx, dy, env.color(0.18), env.splatRadius * 0.8)
    }
  }
}
