// In-window control panel (Tweakpane overlay). Lives in the same renderer as
// the engine, so bindings mutate the shared state object directly — patches
// are still forwarded to the main process, which stays the source of truth.

import { Pane } from 'tweakpane'
import type { BindingApi, FolderApi } from '@tweakpane/core'
import type { AppState, MappableParam } from '../../shared/params'
import type { StatePatch } from '../../shared/api'
import { PALETTES } from '../../shared/palettes'

export interface PanelEnv {
  state: AppState
  stats: { fps: number; gpu: string }
  meters: { sub: number; bass: number; mid: number; treble: number; kick: number; snare: number; hat: number; energy: number; bpm: string }
  randomSplats(): void
  clearDye(): void
  toggleFullscreen(): void
  recording: { active: boolean; status: string }
  toggleRecording(): void
  exportJob: { active: boolean; status: string }
  startExport(durationSec: number, fps: number): void
  presets: {
    getAll(): { name: string }[]
    save(name: string): Promise<void>
    remove(name: string): Promise<void>
    apply(name: string): void
  }
}

export interface PanelHandle {
  toggle(): void
  refresh(): void
}

export function buildPanel(env: PanelEnv): PanelHandle {
  const { state } = env
  const container = document.getElementById('pane')
  if (!container) throw new Error('#pane container missing')

  // guard against echo loops when applying patches that came from elsewhere
  let applyingRemote = false

  const pane = new Pane({ container, title: 'LIQUID' })

  /** bind obj[key], mutate shared state, forward patch to main */
  const bind = (
    folder: FolderApi,
    obj: Record<string, unknown>,
    key: string,
    path: string[],
    opts: Record<string, unknown> = {}
  ): BindingApi => {
    const binding = folder.addBinding(obj as never, key as never, opts as never)
    binding.on('change', (ev: { value: unknown }) => {
      if (applyingRemote) return
      const patch: Record<string, unknown> = {}
      let cursor = patch
      for (const seg of path) {
        cursor[seg] = {}
        cursor = cursor[seg] as Record<string, unknown>
      }
      cursor[key] = ev.value
      window.liquid.patchState(patch as StatePatch)
    })
    return binding
  }

  // --- presets: save/load/delete + hotkey slots -----------------------------------
  const fPresets = pane.addFolder({ title: 'Presets (phím 1–9)' })
  const pstate = { name: 'Preset 1', selected: '' }
  let selBinding: BindingApi | null = null
  const rebuildPresetList = (): void => {
    const options: Record<string, string> = { '—': '' }
    env.presets.getAll().forEach((p, i) => {
      options[`${i + 1} · ${p.name}`] = p.name
    })
    selBinding?.dispose()
    selBinding = fPresets.addBinding(pstate, 'selected', { label: 'load', options })
    selBinding.on('change', (ev: { value: unknown }) => {
      if (ev.value) env.presets.apply(ev.value as string)
    })
  }
  rebuildPresetList()
  fPresets.addBinding(pstate, 'name', { label: 'tên preset' })
  fPresets.addButton({ title: '💾 Lưu preset mới / ghi đè' }).on('click', () => {
    const name = pstate.name.trim()
    if (!name) return
    void env.presets.save(name).then(rebuildPresetList)
  })
  fPresets.addButton({ title: '🗑 Xoá preset đang chọn' }).on('click', () => {
    if (!pstate.selected) return
    void env.presets.remove(pstate.selected).then(() => {
      pstate.selected = ''
      rebuildPresetList()
    })
  })

  // --- simulation -------------------------------------------------------------
  const sim = state.sim as unknown as Record<string, unknown>
  const fSim = pane.addFolder({ title: 'Simulation', expanded: false })
  bind(fSim, sim, 'paused', ['sim'])
  bind(fSim, sim, 'speed', ['sim'], { label: 'speed', min: 0.1, max: 1.5, step: 0.01 })
  bind(fSim, sim, 'simRes', ['sim'], { label: 'sim res', options: { '128': 128, '192': 192, '256': 256 } })
  bind(fSim, sim, 'dyeRes', ['sim'], { label: 'dye res', options: { '512': 512, '1024': 1024, '1440': 1440, '2048': 2048 } })
  bind(fSim, sim, 'curl', ['sim'], { label: 'curl (vorticity)', min: 0, max: 60, step: 1 })
  bind(fSim, sim, 'densityDissipation', ['sim'], { label: 'dye dissipation', min: 0, max: 4, step: 0.01 })
  bind(fSim, sim, 'velocityDissipation', ['sim'], { label: 'vel dissipation', min: 0, max: 4, step: 0.01 })
  bind(fSim, sim, 'pressure', ['sim'], { label: 'pressure', min: 0, max: 1, step: 0.01 })
  bind(fSim, sim, 'pressureIterations', ['sim'], { label: 'pressure iters', min: 10, max: 60, step: 1 })
  bind(fSim, sim, 'maccormack', ['sim'], { label: 'MacCormack dye' })
  bind(fSim, sim, 'splatRadius', ['sim'], { label: 'splat radius', min: 0.01, max: 1, step: 0.01 })
  bind(fSim, sim, 'splatForce', ['sim'], { label: 'splat force', min: 1000, max: 12000, step: 100 })

  // --- palette & color ----------------------------------------------------------
  const visual = state.visual as unknown as Record<string, unknown>
  const paletteOptions: Record<string, string> = {}
  for (const [key, pal] of Object.entries(PALETTES)) paletteOptions[pal.name] = key

  const fColor = pane.addFolder({ title: 'Palette & Color' })
  bind(fColor, visual, 'style', ['visual'], {
    label: 'style',
    options: {
      'auto (theo palette)': 'auto',
      'ink · dark': 'ink',
      'watercolor · paper': 'paper',
      'oil paint': 'oil',
      'contour ink': 'contour',
      neon: 'neon',
      smoke: 'smoke',
      'flow iridescent': 'flow'
    }
  })
  bind(fColor, visual, 'palette', ['visual'], { label: 'palette', options: paletteOptions })
  bind(fColor, visual, 'colorSpread', ['visual'], { label: 'color spread', min: 0, max: 1, step: 0.01 })
  bind(fColor, visual, 'colorCycleSpeed', ['visual'], { label: 'cycle speed', min: 0, max: 1, step: 0.005 })
  bind(fColor, visual, 'bgGradient', ['visual'], { label: 'bg gradient', min: 0, max: 1, step: 0.01 })

  // --- post fx -------------------------------------------------------------------
  const fPost = pane.addFolder({ title: 'Post FX', expanded: false })
  bind(fPost, visual, 'shading', ['visual'], { label: 'shading' })
  bind(fPost, visual, 'bloom', ['visual'], { label: 'bloom' })
  bind(fPost, visual, 'bloomIntensity', ['visual'], { label: '· intensity', min: 0, max: 2, step: 0.01 })
  bind(fPost, visual, 'bloomThreshold', ['visual'], { label: '· threshold', min: 0, max: 1, step: 0.01 })
  bind(fPost, visual, 'bloomSoftKnee', ['visual'], { label: '· soft knee', min: 0, max: 1, step: 0.01 })
  bind(fPost, visual, 'sunrays', ['visual'], { label: 'sunrays' })
  bind(fPost, visual, 'sunraysWeight', ['visual'], { label: '· weight', min: 0, max: 1.5, step: 0.01 })
  bind(fPost, visual, 'sunraysDensity', ['visual'], { label: '· density', min: 0.05, max: 1, step: 0.01 })
  bind(fPost, visual, 'sunraysDecay', ['visual'], { label: '· decay', min: 0.8, max: 0.99, step: 0.005 })

  // --- grading --------------------------------------------------------------------
  const fGrade = pane.addFolder({ title: 'Grading', expanded: false })
  bind(fGrade, visual, 'exposure', ['visual'], { min: 0, max: 3, step: 0.01 })
  bind(fGrade, visual, 'contrast', ['visual'], { min: 0.5, max: 1.5, step: 0.01 })
  bind(fGrade, visual, 'saturation', ['visual'], { min: 0, max: 2, step: 0.01 })
  bind(fGrade, visual, 'lift', ['visual'], { min: -0.1, max: 0.2, step: 0.005 })
  bind(fGrade, visual, 'gamma', ['visual'], { min: 0.5, max: 2, step: 0.01 })
  bind(fGrade, visual, 'gain', ['visual'], { min: 0.5, max: 1.5, step: 0.01 })
  bind(fGrade, visual, 'vignette', ['visual'], { min: 0, max: 1, step: 0.01 })
  bind(fGrade, visual, 'grain', ['visual'], { label: 'film grain', min: 0, max: 0.2, step: 0.005 })
  bind(fGrade, visual, 'texture', ['visual'], { label: 'paper texture', min: 0, max: 1, step: 0.01 })

  // --- audio ------------------------------------------------------------------------
  const audio = state.audio as unknown as Record<string, unknown>
  const fAudio = pane.addFolder({ title: 'Audio' })
  bind(fAudio, audio, 'source', ['audio'], {
    label: 'source',
    options: { none: 'none', 'input device': 'device', 'file (kéo thả vào đây)': 'file', 'demo beat': 'demo' }
  })

  let deviceBinding: BindingApi | null = null
  const rebuildDeviceList = async (): Promise<void> => {
    const options: Record<string, string> = { default: '' }
    try {
      // getUserMedia once so enumerateDevices returns labels
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      for (const d of devices) {
        if (d.kind === 'audioinput') options[d.label || d.deviceId.slice(0, 8)] = d.deviceId
      }
    } catch {
      // no permission / no devices — keep just 'default'
    }
    deviceBinding?.dispose()
    deviceBinding = bind(fAudio, audio, 'deviceId', ['audio'], { label: 'device', options })
  }
  void rebuildDeviceList()
  fAudio.addButton({ title: 'Rescan devices' }).on('click', () => void rebuildDeviceList())

  bind(fAudio, audio, 'monitor', ['audio'], { label: 'monitor (file/demo)' })
  bind(fAudio, audio, 'inputGain', ['audio'], { label: 'input gain', min: 0, max: 4, step: 0.05 })
  bind(fAudio, audio, 'beatSensitivity', ['audio'], { label: 'beat sensitivity', min: 0.5, max: 3, step: 0.05 })
  fAudio.addBinding(env.meters, 'bpm', { readonly: true, label: 'BPM lock', interval: 500 })

  const fEnv = fAudio.addFolder({ title: 'Band envelopes', expanded: false })
  for (const band of ['sub', 'bass', 'mid', 'treble'] as const) {
    const bandObj = state.audio[band] as unknown as Record<string, unknown>
    bind(fEnv, bandObj, 'attackMs', ['audio', band], { label: `${band} attack`, min: 1, max: 300, step: 1 })
    bind(fEnv, bandObj, 'releaseMs', ['audio', band], { label: `${band} release`, min: 10, max: 1000, step: 5 })
  }

  const fMeters = fAudio.addFolder({ title: 'Levels', expanded: false })
  for (const key of ['sub', 'bass', 'mid', 'treble', 'kick', 'snare', 'hat', 'energy'] as const) {
    fMeters.addBinding(env.meters, key, { readonly: true, view: 'graph', min: 0, max: 1, interval: 50 })
  }

  // --- mapping matrix ------------------------------------------------------------------
  const fMap = pane.addFolder({ title: 'Audio Mapping', expanded: false })
  const sourceOptions = {
    none: 'none', sub: 'sub', bass: 'bass', mid: 'mid', treble: 'treble',
    kick: 'kick', snare: 'snare', hat: 'hat', energy: 'energy'
  }
  const curveOptions = { linear: 'linear', 'pow²': 'pow2', '√': 'sqrt' }
  const mappingLabels: Record<MappableParam, string> = {
    simSpeed: 'sim speed ← energy',
    splatForce: 'splat force',
    splatRadius: 'splat radius',
    curl: 'curl',
    emitterSpeed: 'emitter speed',
    hueShift: 'hue shift',
    bloomIntensity: 'bloom intensity'
  }
  for (const param of Object.keys(mappingLabels) as MappableParam[]) {
    const m = state.mappings[param] as unknown as Record<string, unknown>
    const f = fMap.addFolder({ title: mappingLabels[param], expanded: false })
    bind(f, m, 'source', ['mappings', param], { label: 'source', options: sourceOptions })
    bind(f, m, 'amount', ['mappings', param], { label: 'amount', min: 0, max: 2, step: 0.01 })
    bind(f, m, 'curve', ['mappings', param], { label: 'curve', options: curveOptions })
  }

  // --- emitters ----------------------------------------------------------------------------
  const fEmit = pane.addFolder({ title: 'Emitters', expanded: false })
  const orbit = state.emitters.orbit as unknown as Record<string, unknown>
  const fOrbit = fEmit.addFolder({ title: 'Orbit', expanded: false })
  bind(fOrbit, orbit, 'enabled', ['emitters', 'orbit'])
  bind(fOrbit, orbit, 'count', ['emitters', 'orbit'], { min: 1, max: 4, step: 1 })
  bind(fOrbit, orbit, 'radius', ['emitters', 'orbit'], { min: 0.05, max: 0.45, step: 0.01 })
  bind(fOrbit, orbit, 'speed', ['emitters', 'orbit'], { label: 'speed (rev/s)', min: -1, max: 1, step: 0.01 })
  bind(fOrbit, orbit, 'force', ['emitters', 'orbit'], { min: 0, max: 4000, step: 50 })

  const burst = state.emitters.beatBurst as unknown as Record<string, unknown>
  const fBurst = fEmit.addFolder({ title: 'Kick drops', expanded: false })
  bind(fBurst, burst, 'enabled', ['emitters', 'beatBurst'])
  bind(fBurst, burst, 'count', ['emitters', 'beatBurst'], { min: 1, max: 12, step: 1 })
  bind(fBurst, burst, 'force', ['emitters', 'beatBurst'], { min: 0, max: 4000, step: 50 })

  const pulse = state.emitters.pulse as unknown as Record<string, unknown>
  const fPulse = fEmit.addFolder({ title: 'Kick pulse (fluid)', expanded: false })
  bind(fPulse, pulse, 'enabled', ['emitters', 'pulse'])
  bind(fPulse, pulse, 'force', ['emitters', 'pulse'], { min: 0, max: 4000, step: 50 })

  const snare = state.emitters.snareSplash as unknown as Record<string, unknown>
  const fSnare = fEmit.addFolder({ title: 'Snare splash', expanded: false })
  bind(fSnare, snare, 'enabled', ['emitters', 'snareSplash'])
  bind(fSnare, snare, 'count', ['emitters', 'snareSplash'], { min: 1, max: 6, step: 1 })
  bind(fSnare, snare, 'force', ['emitters', 'snareSplash'], { min: 0, max: 4000, step: 50 })

  const hats = state.emitters.hatSparkle as unknown as Record<string, unknown>
  const fHats = fEmit.addFolder({ title: 'Hat sparkle', expanded: false })
  bind(fHats, hats, 'enabled', ['emitters', 'hatSparkle'])
  bind(fHats, hats, 'count', ['emitters', 'hatSparkle'], { min: 1, max: 8, step: 1 })

  const edge = state.emitters.edgeFlow as unknown as Record<string, unknown>
  const fEdge = fEmit.addFolder({ title: 'Edge flow', expanded: false })
  bind(fEdge, edge, 'enabled', ['emitters', 'edgeFlow'])
  bind(fEdge, edge, 'rate', ['emitters', 'edgeFlow'], { label: 'splats/s', min: 0.5, max: 30, step: 0.5 })
  bind(fEdge, edge, 'force', ['emitters', 'edgeFlow'], { min: 0, max: 4000, step: 50 })

  const drip = state.emitters.idleDrip as unknown as Record<string, unknown>
  const fDrip = fEmit.addFolder({ title: 'Idle drip (khi không có audio)', expanded: false })
  bind(fDrip, drip, 'enabled', ['emitters', 'idleDrip'])

  // --- output: resolution + NDI ---------------------------------------------------------
  const output = state.output as unknown as Record<string, unknown>
  const fOutput = pane.addFolder({ title: 'Output', expanded: false })
  bind(fOutput, output, 'resolution', ['output'], {
    label: 'resolution',
    options: {
      'theo cửa sổ': 'window',
      '1280×720': '1280x720',
      '1920×1080': '1920x1080',
      '2560×1080 (ultrawide)': '2560x1080',
      '3840×1080 (dual FHD)': '3840x1080',
      '3840×2160 (4K)': '3840x2160',
      custom: 'custom'
    }
  })
  // step 2: NDI/BGRA takes any size, but video encoders want even dimensions
  bind(fOutput, output, 'customWidth', ['output'], { label: 'custom W', min: 256, max: 16384, step: 2 })
  bind(fOutput, output, 'customHeight', ['output'], { label: 'custom H', min: 256, max: 16384, step: 2 })
  bind(fOutput, output, 'ndi', ['output'], { label: 'NDI out ("LIQUID")' })
  bind(fOutput, output, 'ndiFps', ['output'], { label: 'NDI fps', options: { '60': 60, '30': 30 } })
  bind(fOutput, output, 'crossfadeSec', ['output'], { label: 'preset crossfade (s)', min: 0, max: 5, step: 0.1 })

  // --- floor: second sim + its own NDI sender -------------------------------------------
  const floor = state.output.floor as unknown as Record<string, unknown>
  const fFloor = fOutput.addFolder({ title: 'Floor · NDI "LIQUID FLOOR"' })
  bind(fFloor, floor, 'enabled', ['output', 'floor'], { label: 'floor output' })
  bind(fFloor, floor, 'width', ['output', 'floor'], { label: 'floor W', min: 256, max: 16384, step: 2 })
  bind(fFloor, floor, 'height', ['output', 'floor'], { label: 'floor H', min: 256, max: 16384, step: 2 })
  bind(fFloor, floor, 'ndiScale', ['output', 'floor'], {
    label: 'NDI res (nhẹ máy)',
    options: { '100%': 1, '50% (khuyên dùng)': 0.5, '25%': 0.25 }
  })
  bind(fFloor, floor, 'preview', ['output', 'floor'], { label: 'preview (góc dưới phải)' })

  const ndiInfo = { status: '—' }
  fOutput.addBinding(ndiInfo, 'status', { readonly: true, label: 'NDI status', multiline: true, rows: 2, interval: 1000 })
  window.setInterval(() => {
    void window.liquid.ndiStatus().then((s) => {
      if (!s.available) {
        ndiInfo.status = `unavailable: ${s.loadError ?? 'no NDI runtime'}`
        return
      }
      ndiInfo.status =
        s.senders.length === 0
          ? 'sẵn sàng (đang tắt)'
          : s.senders
              .map((e) => `● ${e.name}: ${e.width}×${e.height} · ${e.frames}f / drop ${e.dropped}`)
              .join('\n')
    })
  }, 2000)

  // --- record & export ------------------------------------------------------------------
  const fRec = pane.addFolder({ title: 'Record & Export', expanded: false })
  fRec.addButton({ title: '⏺ Record WebM (start/stop)' }).on('click', env.toggleRecording)
  fRec.addBinding(env.recording, 'status', { readonly: true, label: 'rec', interval: 500 })
  const exportOpts = { duration: 10, fps: 60 }
  fRec.addBinding(exportOpts, 'duration', { label: 'PNG seq (s)', min: 1, max: 120, step: 1 })
  fRec.addBinding(exportOpts, 'fps', { label: 'PNG seq fps', options: { '60': 60, '30': 30 } })
  fRec.addButton({ title: '🖼 Export PNG sequence' }).on('click', () => {
    env.startExport(exportOpts.duration, exportOpts.fps)
  })
  fRec.addBinding(env.exportJob, 'status', { readonly: true, label: 'export', interval: 500 })

  // --- actions & perf ----------------------------------------------------------------------
  const fActions = pane.addFolder({ title: 'Actions', expanded: false })
  fActions.addButton({ title: 'Random splats' }).on('click', env.randomSplats)
  fActions.addButton({ title: 'Clear dye' }).on('click', env.clearDye)
  fActions.addButton({ title: 'Fullscreen (F)' }).on('click', env.toggleFullscreen)

  const fPerf = pane.addFolder({ title: 'Performance', expanded: false })
  fPerf.addBinding(env.stats, 'fps', { readonly: true, view: 'graph', min: 0, max: 130 })
  fPerf.addBinding(env.stats, 'fps', { readonly: true, format: (v: number) => v.toFixed(0) })
  // "SwiftShader" here = software rendering — the GPU isn't being used at all
  fPerf.addBinding(env.stats, 'gpu', { readonly: true, label: 'GPU', multiline: true, rows: 2, interval: 10000 })

  // patches from other windows/processes (none today, future-proof)
  window.liquid.onStateChanged(() => {
    applyingRemote = true
    pane.refresh()
    applyingRemote = false
  })

  return {
    toggle(): void {
      container.classList.toggle('hidden')
    },
    refresh(): void {
      applyingRemote = true
      pane.refresh()
      applyingRemote = false
    }
  }
}
