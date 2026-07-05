import { getWebGLContext } from '../engine/gl/context'
import { FluidSolver } from '../engine/solver/FluidSolver'
import { PostChain } from '../engine/post/PostChain'
import { AudioEngine } from '../engine/audio/AudioEngine'
import { Emitters } from './emitters'
import { compileShader, Program } from '../engine/gl/program'
import { createFBO, type FBO } from '../engine/gl/fbo'
import baseVertSrc from '../engine/solver/shaders/base.vert.glsl?raw'
import copyFragSrc from '../engine/solver/shaders/copy.frag.glsl?raw'
import ndiPackFragSrc from '../engine/post/shaders/ndiPack.frag.glsl?raw'
import { NDI_FLOOR_NAME, NDI_SENDER_NAME, PAPER_STYLES, type AppState, type AudioLevels, type FluidStyle, type Mapping, type MappableParam, type PresetEntry } from '../../shared/params'
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

  // --- floor feed: its own sim at the floor's aspect, offscreen --------------------
  // (a shared seamless wall+floor domain was tried and reverted: the wall had to
  // share sim space with the tall floor, which magnified every wash ~3.5× on the
  // wall and destroyed the original look. Two sims answer the same beats instead.)
  const floorSolver = new FluidSolver(glc)
  const floorPost = new PostChain(glc)
  const floorEmitters = new Emitters()
  let floorTarget: FBO | null = null
  // inset preview needs its own tiny textured draw (blit() always fills the viewport)
  const baseVertex = compileShader(glc.gl, glc.gl.VERTEX_SHADER, baseVertSrc)
  const previewProgram = new Program(glc.gl, baseVertex, compileShader(glc.gl, glc.gl.FRAGMENT_SHADER, copyFragSrc))
  // NDI packing (flip + BGRA swizzle) runs on the GPU — the per-byte CPU pack
  // in the main process was capping the whole app's frame rate on Windows
  const ndiPackProgram = new Program(glc.gl, baseVertex, compileShader(glc.gl, glc.gl.FRAGMENT_SHADER, ndiPackFragSrc))
  let ndiSceneFbo: FBO | null = null
  let ndiPackFbo: FBO | null = null
  let floorPackFbo: FBO | null = null

  const ensureByteFbo = (fbo: FBO | null, w: number, h: number): FBO => {
    if (fbo && fbo.width === w && fbo.height === h) return fbo
    fbo?.dispose()
    const gl = glc.gl
    return createFBO(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
  }

  /** fullscreen textured quad into `dst` (null = canvas) with the given program */
  const drawTex = (program: Program, src: FBO, dst: FBO | null): void => {
    const gl = glc.gl
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null)
    const w = dst ? dst.width : canvas.width
    const h = dst ? dst.height : canvas.height
    gl.viewport(0, 0, w, h)
    program.bind()
    gl.uniform2f(program.uniforms.texelSize, 1 / w, 1 / h)
    gl.uniform1i(program.uniforms.uTexture, src.attach(0))
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }

  const state: AppState = await window.liquid.getState()
  resizeCanvas()
  let framebuffersDirty = false
  let levels: AudioLevels = {
    sub: 0, bass: 0, mid: 0, treble: 0,
    kick: 0, snare: 0, hat: 0, energy: 0, beat: 0, bpm: 0,
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
  // `at` pins the palette position (per-drum color identity — kick/snare/hat
  // each own a hue region so every mark is attributable to its sound)
  const paletteColor = (strength: number, at?: number): RGB => {
    const pal = getPalette(state.visual.palette)
    const hueShift = modLevel(state.mappings.hueShift)
    let t: number
    if (at !== undefined) {
      t = pingPong(at + (Math.random() - 0.5) * 0.1 + hueShift * 0.3)
    } else {
      const center = pingPong(performance.now() * 0.001 * state.visual.colorCycleSpeed + hueShift)
      const spread = state.visual.colorSpread
      t = center * (1 - spread) + Math.random() * spread
    }
    const c = samplePalette(pal, t)
    // tonal variety: some splats are thin washes, some dense drops
    const amt = strength * (0.7 + Math.random() * 0.8)
    if (isPaperStyle()) {
      const k = Math.min(amt, 1.3) * 0.9
      return [(1 - c[0]) * k, (1 - c[1]) * k, (1 - c[2]) * k]
    }
    // additive styles: keep emitted light modest — busy music stacks splats
    // toward the dye clamp and the whole frame washes out to white
    const k = amt * 0.9
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
    // all idempotent — they only act when config actually differs
    void audio.applyConfig(state.audio)
    syncFloorTargets()
    void syncNdi()
  }

  // --- floor render target -------------------------------------------------------
  // (re)create the FBO + floor sim whenever the floor size changes; the solver
  // and post chain are told the fixed output size so aspect stays true
  let floorSplashed = false
  const prevFloorSize = { w: 0, h: 0 }
  function syncFloorTargets(): void {
    const f = state.output.floor
    if (!f.enabled) return
    const gl = glc.gl
    const w = clampDim(f.width)
    const h = clampDim(f.height)
    if (floorTarget && prevFloorSize.w === w && prevFloorSize.h === h) return
    prevFloorSize.w = w
    prevFloorSize.h = h
    floorTarget?.dispose()
    // plain byte RGBA — this is a video feed, readPixels wants UNSIGNED_BYTE
    floorTarget = createFBO(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
    floorSolver.initFramebuffers(state.sim.simRes, state.sim.dyeRes, w, h)
    floorPost.initFramebuffers(w, h)
    if (!floorSplashed) {
      floorSplashed = true
      floorSolver.multipleSplats(6, state.sim.splatRadius, () => paletteColor(0.55))
    }
  }

  // --- NDI out ------------------------------------------------------------------
  // single-flight: syncNdi is polled every frame while start/stop are async —
  // without the busy latch the in-flight calls interleave into a start/stop loop
  const ndiRunning = { main: false, floor: false }
  let ndiBusy = false
  let ndiFrameCount = 0

  // Async GPU→CPU readback via PBO, one frame late: a synchronous readPixels
  // stalls the whole pipeline waiting for the GPU (9fps on an M4 Max with the
  // floor feed live). Queue the read this tick, collect it next tick.
  interface NdiReader {
    pbo: WebGLBuffer
    size: number
    pending: { w: number; h: number; toNdi: boolean } | null
    pixels: Uint8Array<ArrayBuffer> | null
  }
  const makeReader = (): NdiReader => ({ pbo: glc.gl.createBuffer()!, size: 0, pending: null, pixels: null })
  const ndiMainReader = makeReader()
  const ndiFloorReader = makeReader()

  /** collect last tick's queued read (data is ready by now) and ship it */
  const pumpReader = (reader: NdiReader, name: string): void => {
    if (!reader.pending) return
    const gl = glc.gl
    const { w, h, toNdi } = reader.pending
    reader.pending = null
    const bytes = w * h * 4
    if (!reader.pixels || reader.pixels.length !== bytes) reader.pixels = new Uint8Array(bytes)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, reader.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, reader.pixels)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    window.liquid.ndiFrame({ name, width: w, height: h, fps: state.output.ndiFps, packed: true, toNdi }, reader.pixels)
  }

  /** kick off an async read of `fbo` into the reader's PBO — no CPU wait */
  const queueRead = (reader: NdiReader, fbo: FBO, toNdi: boolean): void => {
    const gl = glc.gl
    const bytes = fbo.width * fbo.height * 4
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, reader.pbo)
    if (reader.size !== bytes) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
      reader.size = bytes
    }
    gl.readPixels(0, 0, fbo.width, fbo.height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    reader.pending = { w: fbo.width, h: fbo.height, toNdi }
  }

  async function syncNdi(): Promise<void> {
    if (ndiBusy) return
    const wantMain = state.output.ndi
    const wantFloor = state.output.floor.enabled
    if (wantMain === ndiRunning.main && wantFloor === ndiRunning.floor) return
    ndiBusy = true
    try {
      if (wantMain !== ndiRunning.main) {
        if (wantMain) {
          const res = await window.liquid.ndiStart({
            name: NDI_SENDER_NAME,
            width: canvas.width,
            height: canvas.height,
            fps: state.output.ndiFps
          })
          if (res.ok) {
            ndiRunning.main = true
          } else {
            console.error('NDI start failed:', res.error)
            state.output.ndi = false
            window.liquid.patchState({ output: { ndi: false } })
          }
        } else {
          await window.liquid.ndiStop(NDI_SENDER_NAME)
          ndiRunning.main = false
        }
      }
      if (wantFloor !== ndiRunning.floor) {
        if (wantFloor) {
          const res = await window.liquid.ndiStart({
            name: NDI_FLOOR_NAME,
            width: clampDim(state.output.floor.width),
            height: clampDim(state.output.floor.height),
            fps: state.output.ndiFps
          })
          if (res.ok) {
            ndiRunning.floor = true
          } else {
            console.error('NDI floor start failed:', res.error)
            state.output.floor.enabled = false
            window.liquid.patchState({ output: { floor: { enabled: false } } })
          }
        } else {
          await window.liquid.ndiStop(NDI_FLOOR_NAME)
          ndiRunning.floor = false
        }
      }
    } finally {
      ndiBusy = false
    }
  }

  const captureNdiFrames = (): void => {
    // NDI runs divided down to ndiFps; Spout (same-machine, cheap) gets every frame
    const divider = Math.max(1, Math.round(60 / Math.max(1, state.output.ndiFps)))
    ndiFrameCount++
    const ndiTick = ndiFrameCount % divider === 0
    const spoutOn = state.output.spout
    if (!ndiTick && !spoutOn) return
    // ship what finished cooking last tick, then queue this tick's frame
    pumpReader(ndiMainReader, NDI_SENDER_NAME)
    pumpReader(ndiFloorReader, NDI_FLOOR_NAME)
    const mainToNdi = ndiTick && ndiRunning.main && state.output.ndi
    if ((mainToNdi || spoutOn) && ndiSceneFbo) {
      ndiPackFbo = ensureByteFbo(ndiPackFbo, ndiSceneFbo.width, ndiSceneFbo.height)
      drawTex(ndiPackProgram, ndiSceneFbo, ndiPackFbo) // GPU flip + BGRA
      queueRead(ndiMainReader, ndiPackFbo, mainToNdi)
    }
    const floorToNdi = ndiTick && ndiRunning.floor
    if ((floorToNdi || spoutOn) && state.output.floor.enabled && floorTarget) {
      // the pack pass doubles as the downscale — LINEAR sampling, one draw
      const scale = Math.min(Math.max(state.output.floor.ndiScale || 1, 0.25), 1)
      const fw = Math.max(2, Math.round((floorTarget.width * scale) / 2) * 2)
      const fh = Math.max(2, Math.round((floorTarget.height * scale) / 2) * 2)
      floorPackFbo = ensureByteFbo(floorPackFbo, fw, fh)
      drawTex(ndiPackProgram, floorTarget, floorPackFbo)
      queueRead(ndiFloorReader, floorPackFbo, floorToNdi)
    }
  }

  // inset of the floor feed in a corner of the main window (drawn after the main
  // NDI capture, so the NDI/preset feed stays clean — recordings do include it)
  const drawFloorPreview = (): void => {
    if (!floorTarget || !state.output.floor.enabled || !state.output.floor.preview) return
    const gl = glc.gl
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    let pw = Math.max(140, Math.round(canvas.width * 0.14))
    let ph = Math.round((pw * floorTarget.height) / floorTarget.width)
    // ultra-wide walls: width-based sizing can exceed the canvas height entirely
    const maxH = Math.round(canvas.height * 0.42)
    if (ph > maxH) {
      ph = maxH
      pw = Math.round((ph * floorTarget.width) / floorTarget.height)
    }
    gl.viewport(canvas.width - pw - 16, 16, pw, ph)
    previewProgram.bind()
    gl.uniform2f(previewProgram.uniforms.texelSize, 1 / pw, 1 / ph)
    gl.uniform1i(previewProgram.uniforms.uTexture, floorTarget.attach(0))
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }

  const floorOn = (): boolean => state.output.floor.enabled && floorTarget !== null

  window.liquid.onAction((action) => {
    switch (action.type) {
      case 'randomSplats':
        solver.multipleSplats(action.count, state.sim.splatRadius, () => paletteColor(0.7))
        if (floorOn()) floorSolver.multipleSplats(action.count, state.sim.splatRadius, () => paletteColor(0.7))
        break
      case 'clearDye':
        solver.clearDye()
        floorSolver.clearDye()
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
  // unmasked GPU name — instantly tells software-rendering fallbacks apart
  const dbgExt = glc.gl.getExtension('WEBGL_debug_renderer_info')
  const gpuName = dbgExt ? String(glc.gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL)) : 'unknown'
  console.log('[gpu]', gpuName)

  const stats = { fps: 0, gpu: gpuName }
  const meters = { sub: 0, bass: 0, mid: 0, treble: 0, kick: 0, snare: 0, hat: 0, energy: 0, bpm: '—' }
  const panel = buildPanel({
    state,
    stats,
    meters,
    randomSplats: () => {
      solver.multipleSplats(8, state.sim.splatRadius, () => paletteColor(0.7))
      if (floorOn()) floorSolver.multipleSplats(8, state.sim.splatRadius, () => paletteColor(0.7))
    },
    clearDye: () => {
      solver.clearDye()
      floorSolver.clearDye()
    },
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
        if (floorOn()) floorSolver.multipleSplats(8, state.sim.splatRadius, () => paletteColor(0.7))
        break
      case 'KeyC':
        solver.clearDye()
        floorSolver.clearDye()
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
  // energy→speed follows the SECTION's loudness, not each kick — chasing the
  // per-beat envelope made the whole sim visibly stutter on 4-on-floor music
  let smoothSpeedMult = 1

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
      // floor sim shares simRes/dyeRes but keeps its own fixed aspect
      if (floorTarget) floorSolver.initFramebuffers(state.sim.simRes, state.sim.dyeRes, floorTarget.width, floorTarget.height)
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
    meters.bpm = levels.bpm > 0 ? `● ${levels.bpm.toFixed(1)} (locked)` : 'đang dò…'

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
      // global speed scale — slow, ink-on-paper motion without weakening forces.
      // simSpeed mapping couples tempo to loudness with heavy contrast:
      // silence ≈ frozen (×0.08 floor), pow-curve so loud sections visibly race
      const speedMap = state.mappings.simSpeed
      let targetSpeedMult = 1
      if (state.audio.source !== 'none' && speedMap.source !== 'none') {
        const lvl = Math.min(modLevel(speedMap), 1.3)
        targetSpeedMult = 0.08 + Math.pow(lvl, 1.7) * 2.3
      }
      // ~0.6s slew: quiet verse still crawls, drop still races, beats don't judder
      smoothSpeedMult += (targetSpeedMult - smoothSpeedMult) * (1 - Math.exp(-dt / 0.6))
      const audioSpeedMult = smoothSpeedMult

      const fullRegion = [{ x0: 0, y0: 0, x1: 1, y1: 1 }]
      emitters.update(dt, state.emitters, solver, {
        levels,
        speedMult: modMult('emitterSpeed'),
        aspect,
        splatRadius: effSplatRadius,
        color: paletteColor,
        audioActive: state.audio.source !== 'none',
        regions: fullRegion
      })
      solver.step(dt * state.sim.speed * audioSpeedMult, effSim)

      // floor: same audio events / params, its own field at the floor's aspect
      if (floorOn() && floorTarget) {
        floorEmitters.update(dt, state.emitters, floorSolver, {
          levels,
          speedMult: modMult('emitterSpeed'),
          aspect: floorTarget.width / floorTarget.height,
          splatRadius: effSplatRadius,
          color: paletteColor,
          audioActive: state.audio.source !== 'none',
          regions: fullRegion
        })
        floorSolver.step(dt * state.sim.speed * audioSpeedMult, effSim)
      }
    }

    const pal = getPalette(state.visual.palette)
    const style = resolveStyle()
    const paper = isPaperStyle()
    // dye stores absorption in paper styles and light in dark styles — switching
    // hemispheres mid-flight renders the old field wrong, so wipe it
    if (paper !== prevPaper) {
      prevPaper = paper
      solver.clearDye()
      floorSolver.clearDye()
    }
    // when the style disagrees with the palette's native mode, swap in a neutral bg
    const bgHex = paper
      ? (pal.mode === 'paper' ? pal.bg : '#f2efe6')
      : (pal.mode === 'dark' ? pal.bg : '#0b0d10')
    const sunraysTint = samplePalette(pal, 0.7)
    const postEnv = {
      time: nowSec,
      bgColor: hexToRgb(bgHex),
      sunraysTint: [sunraysTint[0] * 0.35, sunraysTint[1] * 0.35, sunraysTint[2] * 0.35] as RGB,
      bloomIntensityMod: modMult('bloomIntensity'),
      style,
      beatPulse: levels.beat
    }
    if (floorOn() && floorTarget) {
      floorPost.render(floorSolver.dyeRead, floorSolver.velocityRead, state.visual, postEnv, floorTarget)
    }
    if ((ndiRunning.main && state.output.ndi) || state.output.spout) {
      // render offscreen so the GPU packer can sample it (the canvas' default
      // framebuffer isn't a texture), then mirror it onto the screen
      ndiSceneFbo = ensureByteFbo(ndiSceneFbo, canvas.width, canvas.height)
      post.render(solver.dyeRead, solver.velocityRead, state.visual, postEnv, ndiSceneFbo)
      drawTex(previewProgram, ndiSceneFbo, null)
    } else {
      post.render(solver.dyeRead, solver.velocityRead, state.visual, postEnv)
    }

    if (ndiRunning.main || ndiRunning.floor || state.output.spout) captureNdiFrames()
    drawFloorPreview()

    fpsAccum += rawDt
    fpsFrames++
    if (fpsAccum >= 0.5) {
      stats.fps = Math.round(fpsFrames / fpsAccum)
      fpsAccum = 0
      fpsFrames = 0
      window.liquid.reportFps(stats.fps) // main logs it when LIQUID_LOG_FPS=1
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
