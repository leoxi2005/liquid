import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type Action, type LiquidApi, type StatePatch } from '../shared/api'
import type { AudioLevels, PresetEntry } from '../shared/params'

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: LiquidApi = {
  getState: () => ipcRenderer.invoke(IPC.stateGet),
  patchState: (patch: StatePatch) => ipcRenderer.send(IPC.statePatch, patch),
  onStateChanged: (cb) => subscribe(IPC.stateChanged, cb),
  sendAction: (action: Action) => ipcRenderer.send(IPC.action, action),
  onAction: (cb) => subscribe(IPC.action, cb),
  reportFps: (fps: number) => ipcRenderer.send(IPC.fpsReport, fps),
  onFps: (cb) => subscribe(IPC.fpsChanged, cb),
  reportAudioLevels: (levels: AudioLevels) => ipcRenderer.send(IPC.audioReport, levels),
  onAudioLevels: (cb) => subscribe(IPC.audioChanged, cb),
  ndiStart: (cfg) => ipcRenderer.invoke(IPC.ndiStart, cfg),
  ndiStop: (name) => ipcRenderer.invoke(IPC.ndiStop, name),
  ndiStatus: () => ipcRenderer.invoke(IPC.ndiStatus),
  ndiFrame: (meta, data) => ipcRenderer.send(IPC.ndiFrame, meta, data),
  spoutStatus: () => ipcRenderer.invoke(IPC.spoutStatus),
  presetsAll: () => ipcRenderer.invoke(IPC.presetsAll),
  presetsSave: (entry: PresetEntry) => ipcRenderer.invoke(IPC.presetsSave, entry),
  presetsDelete: (name: string) => ipcRenderer.invoke(IPC.presetsDelete, name),
  saveRecording: (suggestedName: string, data: ArrayBuffer) => ipcRenderer.invoke(IPC.recordSave, suggestedName, data),
  pickExportDir: () => ipcRenderer.invoke(IPC.exportPickDir),
  writeExportFrame: (dir: string, index: number, data: ArrayBuffer) =>
    ipcRenderer.invoke(IPC.exportFrame, dir, index, data)
}

contextBridge.exposeInMainWorld('liquid', api)
