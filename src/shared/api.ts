import type { AppState, AudioLevels, NdiFrameMeta, NdiStatus, PresetEntry, SpoutStatus } from './params'
import type { DeepPartial } from './merge'

export type StatePatch = DeepPartial<AppState>

export type Action =
  | { type: 'randomSplats'; count: number }
  | { type: 'clearDye' }
  | { type: 'toggleFullscreen' }

export const IPC = {
  stateGet: 'state:get',
  statePatch: 'state:patch',
  stateChanged: 'state:changed',
  action: 'action',
  fpsReport: 'fps:report',
  fpsChanged: 'fps:changed',
  audioReport: 'audio:report',
  audioChanged: 'audio:changed',
  ndiStart: 'ndi:start',
  ndiStop: 'ndi:stop',
  ndiStatus: 'ndi:status',
  ndiFrame: 'ndi:frame',
  spoutStatus: 'spout:status',
  presetsAll: 'presets:all',
  presetsSave: 'presets:save',
  presetsDelete: 'presets:delete',
  recordSave: 'record:save',
  exportPickDir: 'export:pickDir',
  exportFrame: 'export:frame'
} as const

/** Bridge exposed by preload as window.liquid */
export interface LiquidApi {
  getState(): Promise<AppState>
  patchState(patch: StatePatch): void
  onStateChanged(cb: (patch: StatePatch) => void): () => void
  sendAction(action: Action): void
  onAction(cb: (action: Action) => void): () => void
  reportFps(fps: number): void
  onFps(cb: (fps: number) => void): () => void
  reportAudioLevels(levels: AudioLevels): void
  onAudioLevels(cb: (levels: AudioLevels) => void): () => void
  ndiStart(cfg: { name: string; width: number; height: number; fps: number }): Promise<{ ok: boolean; error?: string }>
  ndiStop(name: string): Promise<void>
  ndiStatus(): Promise<NdiStatus>
  /** hot path — packed video frame; main routes it to NDI and/or Spout */
  ndiFrame(meta: NdiFrameMeta, data: Uint8Array): void
  spoutStatus(): Promise<SpoutStatus>
  presetsAll(): Promise<PresetEntry[]>
  /** save-or-overwrite; returns the updated list */
  presetsSave(entry: PresetEntry): Promise<PresetEntry[]>
  presetsDelete(name: string): Promise<PresetEntry[]>
  /** save-dialog + write a finished WebM recording */
  saveRecording(suggestedName: string, data: ArrayBuffer): Promise<{ ok: boolean; path?: string }>
  pickExportDir(): Promise<string | null>
  /** write one PNG frame; awaiting it gives natural backpressure */
  writeExportFrame(dir: string, index: number, data: ArrayBuffer): Promise<void>
}
