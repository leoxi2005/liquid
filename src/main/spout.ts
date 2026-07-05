// Spout sender wrapper (Windows only) around the native/spout N-API addon.
// Same-machine GPU texture sharing for Resolume/TouchDesigner — no network
// encode, so it stays cheap where NDI is CPU-bound. Frames arrive on the same
// hot path as NDI: BGRA top-down, packed on the GPU by the renderer.

import { createRequire } from 'module'
import { join } from 'path'
import { app } from 'electron'
import type { NdiFrameMeta } from '../shared/params'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spout: any = null
let loadError: Error | null = null

if (process.platform === 'win32') {
  try {
    const req = createRequire(__filename)
    const addonPath = app.isPackaged
      ? join(process.resourcesPath, 'spout/spout_addon.node')
      : join(__dirname, '../../native/spout/build/Release/spout_addon.node')
    spout = req(addonPath)
  } catch (err) {
    loadError = err as Error
    console.error('[spout] addon failed to load:', loadError.message)
  }
} else {
  loadError = new Error('Spout chỉ có trên Windows')
}

const frames = new Map<string, number>()

export function isAvailable(): boolean {
  return !!spout
}

export function status(): { available: boolean; loadError: string | null; senders: { name: string; frames: number }[] } {
  return {
    available: !!spout,
    loadError: loadError ? String(loadError.message || loadError) : null,
    senders: Array.from(frames.entries()).map(([name, n]) => ({ name, frames: n }))
  }
}

/** upload one BGRA top-down frame; the sender auto-creates on first use */
export function sendFrame(meta: NdiFrameMeta, bgra: Buffer): void {
  if (!spout) return
  try {
    if (spout.send(meta.name, bgra, meta.width, meta.height)) {
      frames.set(meta.name, (frames.get(meta.name) ?? 0) + 1)
    }
  } catch (err) {
    console.warn('[spout] send failed:', (err as Error).message)
  }
}

export function stopAll(): void {
  if (!spout) return
  try {
    spout.closeAll()
  } catch {
    /* already gone */
  }
  frames.clear()
}
