import { app, BrowserWindow, dialog, ipcMain, nativeImage, session } from 'electron'
import { join } from 'path'
import { existsSync, promises as fsp, writeFileSync } from 'fs'
import { defaultState, type AppState, type NdiFrameMeta, type PresetEntry } from '../shared/params'
import { deepMerge } from '../shared/merge'
import { IPC, type Action, type StatePatch } from '../shared/api'
import * as ndi from './ndi'
import * as persist from './persistence'

// audio engine starts before any click — don't let Chromium suspend the AudioContext
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Main process owns state; the renderer patches it and receives external patches.
let state: AppState = JSON.parse(JSON.stringify(defaultState))

let outputWin: BrowserWindow | null = null

app.whenReady().then(() => {
  // restore last session's settings — never restore paused
  const saved = persist.loadSettings() as Record<string, unknown> | null
  if (saved) {
    delete saved.camera // feature removed — stale key would linger in settings.json
    // reactivity retune: saved emitter/mapping values from an older rev would
    // silently override the new (much stronger) defaults
    if ((saved.tuningRev as number | undefined) !== defaultState.tuningRev) {
      delete saved.emitters
      delete saved.mappings
      if (saved.audio) delete (saved.audio as Record<string, unknown>).beatSensitivity
      saved.tuningRev = defaultState.tuningRev
    }
    state = deepMerge(state, saved as StatePatch)
    state.sim.paused = false
  }

  const iconPath = join(__dirname, '../../resources/icon.png')
  if (process.platform === 'darwin' && existsSync(iconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }

  // audio input (loopback via BlackHole etc.) needs mic permission
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  outputWin = new BrowserWindow({
    width: 1500,
    height: 860,
    title: 'LIQUID',
    backgroundColor: '#0a0f0e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // keep rendering at full rate when occluded — critical for capture/NDI
      backgroundThrottling: false
    }
  })
  outputWin.once('ready-to-show', () => outputWin?.show())
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void outputWin.loadURL(`${devUrl}/output/index.html`)
  } else {
    void outputWin.loadFile(join(__dirname, '../renderer/output/index.html'))
  }
  outputWin.on('closed', () => app.quit())
})

app.on('window-all-closed', () => app.quit())

ipcMain.handle(IPC.stateGet, () => state)

ipcMain.on(IPC.statePatch, (event, patch: StatePatch) => {
  state = deepMerge(state, patch)
  persist.scheduleSaveSettings(() => state)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== event.sender.id) {
      win.webContents.send(IPC.stateChanged, patch)
    }
  }
})

ipcMain.handle(IPC.presetsAll, () => persist.allPresets())
ipcMain.handle(IPC.presetsSave, (_e, entry: PresetEntry) => persist.savePreset(entry))
ipcMain.handle(IPC.presetsDelete, (_e, name: string) => persist.deletePreset(name))

// ---- recording / PNG export --------------------------------------------------

ipcMain.handle(IPC.recordSave, async (_e, suggestedName: string, data: ArrayBuffer) => {
  if (!outputWin) return { ok: false }
  const res = await dialog.showSaveDialog(outputWin, {
    defaultPath: join(app.getPath('videos'), suggestedName),
    filters: [{ name: 'WebM video', extensions: ['webm'] }]
  })
  if (res.canceled || !res.filePath) return { ok: false }
  writeFileSync(res.filePath, Buffer.from(data))
  return { ok: true, path: res.filePath }
})

ipcMain.handle(IPC.exportPickDir, async () => {
  if (!outputWin) return null
  const res = await dialog.showOpenDialog(outputWin, {
    title: 'Chọn thư mục xuất PNG sequence',
    properties: ['openDirectory', 'createDirectory']
  })
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
})

ipcMain.handle(IPC.exportFrame, async (_e, dir: string, index: number, data: ArrayBuffer) => {
  const name = `frame_${String(index).padStart(5, '0')}.png`
  await fsp.writeFile(join(dir, name), Buffer.from(data))
})

ipcMain.on(IPC.action, (_event, action: Action) => {
  if (action.type === 'toggleFullscreen') {
    if (outputWin && !outputWin.isDestroyed()) {
      outputWin.setFullScreen(!outputWin.isFullScreen())
    }
    return
  }
  outputWin?.webContents.send(IPC.action, action)
})

// ---- NDI out ---------------------------------------------------------------

ipcMain.handle(IPC.ndiStart, async (_e, cfg: { name: string; width: number; height: number; fps: number }) => {
  try {
    await ndi.startSender(cfg)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error).message || err) }
  }
})

ipcMain.handle(IPC.ndiStop, (_e, name: string) => {
  ndi.stopSender(name)
})

ipcMain.handle(IPC.ndiStatus, () => ndi.status())

// hot path: RGBA frame straight from the output renderer's readPixels
ipcMain.on(IPC.ndiFrame, (_e, meta: NdiFrameMeta, data: Uint8Array) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data)
  ndi.sendFrame(meta, buf)
})

app.on('before-quit', () => {
  ndi.stopAll()
  persist.flushSettings(state)
})
