import { getWebGLContext } from '../engine/gl/context'
import { FluidSolver } from '../engine/solver/FluidSolver'
import { PostChain } from '../engine/post/PostChain'
import { AudioEngine } from '../engine/audio/AudioEngine'
import { Emitters } from './emitters'
import { NDI_SENDER_NAME, PAPER_STYLES, type AppState, type AudioLevels, type FluidStyle, type Mapping, type MappableParam, type PresetEntry } from '../../shared/params'
import { applyPatchInPlace } from '../../shared/merge'
import { buildPanel } from './panel'
import { PresetFader, snapshotPreset } from './presets'
import { getPalette, hexToRgb, pingPong, samplePalette, type RGB } from '../engine/color'
import { Pointer, updatePointerDown, updatePointerMove, updatePointerUp } from './pointer'

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement

  // --- canvas sizing: window-tracking or fixed render resolution (letterboxed)
  let maxTex = 16384 // refined from the real GPU limit once GL is up
  const clampDim = (v: number): number => Math.min(Math.max(256, Math.round(v)), maxTex)
  const targetSize = (): { w: number; h: number } | null => {
    const o = state.output
    switch (o.resolution) {
      case 'window':
        return null
      case 'custom':
        return { w: clampDim(o.customWidth), h: clampDim(o.customHeight) }
      default: {
        const [w, h] = o.resolution.split('x').map(Number)
        return { w, h }
      }
    }
  }

  const resizeCanvas = (): boolean => {
    const t = targetSize()
    const dpr = window.devicePixelRatio || 1
    const w = t ? t.w : Math.floor(window.innerWidth * dpr)
    const h = t ? t.h : Math.floor(window.innerHeight * dpr)
    if (t) {
      // letterbox: scale to fit, keep exact render pixels
      const s = Math.min(window.innerWidth / t.w, window.innerHeight / t.h)
      canvas.style.width = `${Math.round(t.w * s)}px`
      canvas.style.height = `${Math.round(t.h * s)}px`
    } else {
      canvas.style.width = '100vw'
      canvas.style.height = '100vh'
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      return true
    }
    return false
  }

  const glc = getWebGLContext(canvas)
  maxTex = glc.gl.getParameter(glc.gl.MAX_TEXTURE_SIZE) as number
  const solver = new FluidSolver(glc)
  const post = new PostChain(glc)
  const audio = new AudioEngine()
  const emitters = new Emitters()

  const state: AppState = await window.liquid.getState()
  resizeCanvas()
  let framebuffersDirty = false
  let levels: AudioLevels = {
    sub: 0, bass: 0, mid: 0, treble: 0,
    kick: 0, snare: 0, hat: 0, energy: 0, beat: 0,
    onKick: false, onSnare: false, onHat: false, onBeat: false
  }

  solver.initFramebuffers(state.sim.simRes, state.sim.dyeRes)
  post.initFramebuffers()
  void audio.applyConfig(state.audio)

  // --- style resolution ---------------------------------------------------------
  // 'auto' follows the palette's native mode; explicit styles override it
  const resolveStyle = (): FluidStyle => {
    const s = state.visual.style
    if (s !== 'auto') return s
    return getPalette(state.visual.palette).mode === 'paper' ? 'paper' : 'ink'
  }
  const isPaperStyle = (): boolean => PAPER_STYLES.includes(resolveStyle())

  // --- palette-driven splat colors -------------------------------------------
  // a slow cycle sets the "center of gravity" on the gradient; colorSpread
  // scatters individual splats around it (1 = anywhere → watercolor variety).
  // strength ≈ ink amount 0–1. Paper styles store pigment absorption
  // (Beer–Lambert in the display shader), dark styles store emitted light.
  const paletteColor = (strength: number): RGB => {
    const pal = getPalette(state.visual.palette)
    const hueShift = modLevel(state.mappings.hueShift)
    const center = pingPong(performance.now() * 0.001 * state.visual.colorCycleSpeed + hueShift)
    const spread = state.visual.colorSpread
    const t = center * (1 - spread) + Math.random() * spread
    const c = samplePalette(pal, t)
    // tonal variety: some splats are thin washes, some dense drops
    const amt = strength * (0.7 + Math.random() * 0.8)
    if (isPaperStyle()) {
      const k = Math.min(amt, 1.3) * 0.9
      return [(1 - c[0]) * k, (1 - c[1]) * k, (1 - c[2]) * k]
    }
    const k = amt * 1.5
    return [c[0] * k, c[1] * k, c[2] * k]
  }

  // --- audio mapping matrix ---------------------------------------------------
  const curveFn = (curve: Mapping['curve'], x: number): number => {
    switch (curve) {
      case 'pow2': return x * x
      case 'sqrt': return Math.sqrt(x)
      default: return x
    }
  }
  const modLevel = (m: Mapping): number => {
    if (m.source === 'none') return 0
    return curveFn(m.curve, levels[m.source]) * m.amount
  }
  const modMult = (param: MappableParam): number => 1 + modLevel(state.mappings[param])

  window.liquid.onStateChanged((patch) => {
    const resChanged = patch.sim?.simRes !== undefined || patch.sim?.dyeRes !== undefined
    applyPatchInPlace(state, patch)
    if (resChanged) framebuffersDirty = true
    if (patch.audio) void audio.applyConfig(state.audio)
    if (patch.output) void syncNdi()
  })

  // panel bindings mutate `state` directly and echo patches to main —
  // engine-relevant side effects still need watching each frame
  const prevSim = { simRes: state.sim.simRes, dyeRes: state.sim.dyeRes }
  const watchLocalChanges = (): void => {
    if (state.sim.simRes !== prevSim.simRes || state.sim.dyeRes !== prevSim.dyeRes) {
      prevSim.simRes = state.sim.simRes
      prevSim.dyeRes = state.sim.dyeRes
      framebuffersDirty = true
    }
    // both are idempotent — they only act when config actually differs
    void audio.applyConfig(state.audio)
    void syncNdi()
  }

  // --- NDI out ------------------------------------------------------------------
  // single-flight: syncNdi is polled every frame while start/stop are async —
  // without the busy latch the in-flight calls interleave into a start/stop loop
  let ndiRunning = false
  let ndiBusy = false
  let ndiPixels: Uint8Array<ArrayBuffer> | null = null
  let ndiFrameCount = 0

  async function syncNdi(): Promise<void> {
    if (ndiBusy) return
    const want = state.output.ndi
    if (want === ndiRunning) return
    ndiBusy = true
    try {
      if (want) {
        const res = await window.liquid.ndiStart({
          name: NDI_SENDER_NAME,
          width: canvas.width,
          height: canvas.height,
          fps: state.output.ndiFps
        })
        if (res.ok) {
          ndiRunning = true
        } else {
          console.error('NDI start failed:', res.error)
          state.output.ndi = false
          window.liquid.patchState({ output: { ndi: false } })
        }
      } else {
        await window.liquid.ndiStop(NDI_SENDER_NAME)
        ndiRunning = false
      }
    } finally {
      ndiBusy = false
    }
  }

  const captureNdiFrame = (): void => {
    const gl = glc.gl
    // divide the 60Hz loop down to the requested NDI rate
    const divider = Math.max(1, Math.round(60 / Math.max(1, state.output.ndiFps)))
    ndiFrameCount++
    if (ndiFrameCount % divider !== 0) return
    const bytes = canvas.width * canvas.height * 4
    if (!ndiPixels || ndiPixels.length !== bytes) ndiPixels = new Uint8Array(bytes)
    // read straight after the display pass, same rAF — buffer still valid
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, ndiPixels)
    window.liquid.ndiFrame(
      { name: NDI_SENDER_NAME, width: canvas.width, height: canvas.height, fps: state.output.ndiFps },
      ndiPixels
    )
  }

  window.liquid.onAction((action) => {
    switch (action.type) {
      case 'randomSplats':
        solver.multipleSplats(action.count, state.sim.splatRadius, () => paletteColor(0.7))
        break
      case 'clearDye':
        solver.clearDye()
        break
    }
  })

  // --- presets: crossfade engine + hotkey slots ------------------------------------
  const fader = new PresetFader()
  let presetsCache: PresetEntry[] = await window.liquid.presetsAll()

  const applyPresetByName = (name: string): void => {
    const entry = presetsCache.find((p) => p.name === name)
    if (entry) fader.start(state, entry.data, state.output.crossfadeSec)
  }

  // --- recording (realtime WebM via MediaRecorder) ---------------------------------
  const recState = { active: false, status: '—' }
  let recorder: MediaRecorder | null = null
  let recChunks: Blob[] = []
  let recStartedAt = 0

  const toggleRecording = (): void => {
    if (recState.active) {
      recorder?.stop()
      recState.active = false
      return
    }
    const stream = canvas.captureStream(60)
    recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 30_000_000
    })
    recChunks = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunks.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: 'video/webm' })
      recState.status = 'đang lưu…'
      void blob.arrayBuffer().then(async (buf) => {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const res = await window.liquid.saveRecording(`LIQUID_${stamp}.webm`, buf)
        recState.status = res.ok ? `đã lưu ✓` : 'đã huỷ'
      })
    }
    recorder.start(1000)
    recStartedAt = performance.now()
    recState.active = true
  }

  // --- PNG sequence export (offline, fixed timestep) --------------------------------
  const exportJob = { active: false, index: 0, total: 0, dir: '', fps: 60, status: '—' }

  const startExport = async (durationSec: number, fps: number): Promise<void> => {
    if (exportJob.active) return
    const dir = await window.liquid.pickExportDir()
    if (!dir) return
    exportJob.dir = dir
    exportJob.fps = fps
    exportJob.index = 0
    exportJob.total = Math.round(durationSec * fps)
    exportJob.active = true
  }

  // --- in-window control panel ---------------------------------------------------
  const stats = { fps: 0 }
  const meters = { sub: 0, bass: 0, mid: 0, treble: 0, kick: 0, snare: 0, hat: 0, energy: 0 }
  const panel = buildPanel({
    state,
    stats,
    meters,
    randomSplats: () => solver.multipleSplats(8, state.sim.splatRadius, () => paletteColor(0.7)),
    clearDye: () => solver.clearDye(),
    toggleFullscreen: () => window.liquid.sendAction({ type: 'toggleFullscreen' }),
    recording: recState,
    toggleRecording,
    exportJob,
    startExport: (dur: number, fps: number) => void startExport(dur, fps),
    presets: {
      getAll: () => presetsCache,
      save: async (name: string) => {
        presetsCache = await window.liquid.presetsSave({ name, data: snapshotPreset(state) })
      },
      remove: async (name: string) => {
        presetsCache = await window.liquid.presetsDelete(name)
      },
      apply: applyPresetByName
    }
  })

  // hint bar fades after a while
  const hint = document.getElementById('hint')
  window.setTimeout(() => hint?.classList.add('faded'), 12000)

  // --- audio file drag & drop -------------------------------------------------
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    void file.arrayBuffer().then(async (buf) => {
      await audio.loadFile(buf)
      state.audio.source = 'file'
      window.liquid.patchState({ audio: { source: 'file' } })
      void audio.applyConfig(state.audio)
    })
  })

  // --- pointer input -----------------------------------------------------------
  const pointers = new Map<number, Pointer>()
  const getPointer = (id: number): Pointer => {
    let p = pointers.get(id)
    if (!p) {
      p = new Pointer()
      pointers.set(id, p)
    }
    return p
  }
  // CSS size ≠ backing size when letterboxed — map through the client rect
  const toBackingX = (v: number): number => (v / canvas.clientWidth) * canvas.width
  const toBackingY = (v: number): number => (v / canvas.clientHeight) * canvas.height

  canvas.addEventListener('pointerdown', (e) => {
    const p = getPointer(e.pointerId)
    updatePointerDown(p, e.pointerId, toBackingX(e.offsetX), toBackingY(e.offsetY), canvas)
    p.color = paletteColor(0.12)
  })
  canvas.addEventListener('pointermove', (e) => {
    const p = getPointer(e.pointerId)
    if (p.down) updatePointerMove(p, toBackingX(e.offsetX), toBackingY(e.offsetY), canvas)
  })
  window.addEventListener('pointerup', (e) => {
    const p = pointers.get(e.pointerId)
    if (p) updatePointerUp(p)
  })

  window.addEventListener('keydown', (e) => {
    // don't steal keys while typing in panel inputs
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
    switch (e.code) {
      case 'Tab':
        e.preventDefault()
        panel.toggle()
        break
      case 'KeyF':
        window.liquid.sendAction({ type: 'toggleFullscreen' })
        break
      case 'Space':
        state.sim.paused = !state.sim.paused
        window.liquid.patchState({ sim: { paused: state.sim.paused } })
        panel.refresh()
        break
      case 'KeyR':
        solver.multipleSplats(8, state.sim.splatRadius, () => paletteColor(0.7))
        break
      case 'KeyC':
        solver.clearDye()
        break
      default:
        // 1–9 → preset slots in list order, crossfaded
        if (e.code.startsWith('Digit')) {
          const idx = parseInt(e.code.slice(5), 10) - 1
          if (idx >= 0 && presetsCache[idx]) {
            fader.start(state, presetsCache[idx].data, state.output.crossfadeSec)
          }
        }
    }
  })

  // --- render loop ---------------------------------------------------------------
  let lastTime = performance.now()
  let fpsAccum = 0
  let fpsFrames = 0
  let prevPaper = isPaperStyle()

  function frame(now: number): void {
    // export mode: deterministic fixed timestep, one PNG per sim frame
    const exporting = exportJob.active
    const rawDt = exporting ? 1 / exportJob.fps : (now - lastTime) / 1000
    const dt = exporting ? rawDt : Math.min(rawDt, 0.016666) // no dt explosion on hitches
    lastTime = now
    const nowSec = now / 1000

    if (resizeCanvas() || framebuffersDirty) {
      framebuffersDirty = false
      solver.initFramebuffers(state.sim.simRes, state.sim.dyeRes)
      post.initFramebuffers()
    }

    // preset crossfade: lerp state toward the target each frame
    if (fader.active) {
      const finished = fader.update(state, rawDt)
      panel.refresh()
      if (finished) window.liquid.patchState(finished)
    }

    watchLocalChanges()

    levels = audio.update(rawDt, state.audio, nowSec)
    meters.sub = levels.sub
    meters.bass = levels.bass
    meters.mid = levels.mid
    meters.treble = levels.treble
    meters.kick = levels.kick
    meters.snare = levels.snare
    meters.hat = levels.hat
    meters.energy = levels.energy

    // audio-modulated effective params for this frame
    const effSplatForce = state.sim.splatForce * modMult('splatForce')
    const effSplatRadius = state.sim.splatRadius * modMult('splatRadius')
    const effSim = {
      ...state.sim,
      curl: state.sim.curl * modMult('curl'),
      splatForce: effSplatForce,
      splatRadius: effSplatRadius
    }
    const aspect = canvas.width / canvas.height

    for (const p of pointers.values()) {
      if (p.moved) {
        p.moved = false
        solver.splat(p.texcoordX, p.texcoordY, p.deltaX * effSplatForce, p.deltaY * effSplatForce, p.color, effSplatRadius)
      }
    }

    if (!state.sim.paused) {
      emitters.update(dt, state.emitters, solver, {
        levels,
        speedMult: modMult('emitterSpeed'),
        aspect,
        splatRadius: effSplatRadius,
        color: paletteColor,
        audioActive: state.audio.source !== 'none'
      })
      // global speed scale — slow, ink-on-paper motion without weakening forces.
      // simSpeed mapping couples tempo to loudness with heavy contrast:
      // silence ≈ frozen (×0.08 floor), pow-curve so loud sections visibly race
      const speedMap = state.mappings.simSpeed
      let audioSpeedMult = 1
      if (state.audio.source !== 'none' && speedMap.source !== 'none') {
        const lvl = Math.min(modLevel(speedMap), 1.3)
        audioSpeedMult = 0.08 + Math.pow(lvl, 1.7) * 2.3
      }
      solver.step(dt * state.sim.speed * audioSpeedMult, effSim)
    }

    const pal = getPalette(state.visual.palette)
    const style = resolveStyle()
    const paper = isPaperStyle()
    // dye stores absorption in paper styles and light in dark styles — switching
    // hemispheres mid-flight renders the old field wrong, so wipe it
    if (paper !== prevPaper) {
      prevPaper = paper
      solver.clearDye()
    }
    // when the style disagrees with the palette's native mode, swap in a neutral bg
    const bgHex = paper
      ? (pal.mode === 'paper' ? pal.bg : '#f2efe6')
      : (pal.mode === 'dark' ? pal.bg : '#0b0d10')
    const sunraysTint = samplePalette(pal, 0.7)
    post.render(solver.dyeRead, solver.velocityRead, state.visual, {
      time: nowSec,
      bgColor: hexToRgb(bgHex),
      sunraysTint: [sunraysTint[0] * 0.35, sunraysTint[1] * 0.35, sunraysTint[2] * 0.35],
      bloomIntensityMod: modMult('bloomIntensity'),
      style,
      beatPulse: levels.beat
    })

    if (state.output.ndi && ndiRunning) captureNdiFrame()

    fpsAccum += rawDt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      stats.fps = Math.round(fpsFrames / fpsAccum)
      fpsAccum = 0
      fpsFrames = 0
    }

    if (recState.active) {
      const sec = Math.floor((now - recStartedAt) / 1000)
      recState.status = `● REC ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
    }

    if (exporting) {
      // hold the loop until this frame's PNG is on disk (backpressure)
      canvas.toBlob((blob) => {
        const finish = (): void => {
          exportJob.index++
          exportJob.status = `${exportJob.index}/${exportJob.total}`
          if (exportJob.index >= exportJob.total) {
            exportJob.active = false
            exportJob.status = `xong ✓ ${exportJob.total} frames`
          }
          requestAnimationFrame(frame)
        }
        if (!blob) {
          finish()
          return
        }
        void blob
          .arrayBuffer()
          .then((buf) => window.liquid.writeExportFrame(exportJob.dir, exportJob.index, buf))
          .then(finish, finish)
      }, 'image/png')
      return
    }

    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // opening splash so the first frame isn't a black void
  solver.multipleSplats(Math.floor(Math.random() * 8) + 6, state.sim.splatRadius, () => paletteColor(0.55))
}

void main()
