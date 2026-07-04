// Webcam → coarse Lucas–Kanade optical flow on a cell grid.
// Body movement produces directional vectors that shove the fluid — the
// classic interactive-installation setup, all CPU, ~0.5ms at 120×68.

import type { CameraParams } from '../../../shared/params'

export const CAM_W = 120
export const CAM_H = 68
const AW = CAM_W
const AH = CAM_H
const CELL = 8
const MAX_VECTORS = 24

export interface FlowVector {
  /** cell center in video texcoords (0–1, y down like the image) */
  x: number
  y: number
  /** flow in pixels/frame at analysis resolution */
  u: number
  v: number
  mag: number
}

export class CameraFlow {
  private video = document.createElement('video')
  private cnv = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private stream: MediaStream | null = null
  private prev: Float32Array | null = null
  private cur = new Float32Array(AW * AH)
  // adaptive background model — the empty scene learned over a few seconds
  private bg: Float32Array | null = null
  /** body silhouette, 0–255 per analysis pixel — upload as a GL texture */
  readonly mask = new Uint8Array(AW * AH)
  private running = false
  private busy = false
  private currentDeviceId = ''

  constructor() {
    this.cnv.width = AW
    this.cnv.height = AH
    const ctx = this.cnv.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.video.muted = true
    this.video.playsInline = true
  }

  get active(): boolean {
    return this.running
  }

  /** idempotent, single-flight — safe to poll every frame */
  async applyConfig(p: CameraParams): Promise<void> {
    if (this.busy) return
    const deviceChanged = p.enabled && this.running && p.deviceId !== this.currentDeviceId
    if (p.enabled && (!this.running || deviceChanged)) {
      this.busy = true
      try {
        this.stop()
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: p.deviceId ? { exact: p.deviceId } : undefined,
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 30 }
          }
        })
        this.video.srcObject = this.stream
        await this.video.play()
        this.currentDeviceId = p.deviceId
        this.running = true
        this.prev = null
      } catch (err) {
        console.error('camera failed:', err)
        this.stop()
      } finally {
        this.busy = false
      }
    } else if (!p.enabled && this.running) {
      this.stop()
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    this.running = false
    this.prev = null
    this.bg = null
    this.mask.fill(0)
  }

  /** per-cell LK flow; returns the strongest motion vectors above threshold */
  update(sensitivity: number): FlowVector[] {
    if (!this.running || this.video.readyState < 2) return []
    this.ctx.drawImage(this.video, 0, 0, AW, AH)
    const rgba = this.ctx.getImageData(0, 0, AW, AH).data
    const cur = this.cur
    for (let i = 0, j = 0; i < cur.length; i++, j += 4) {
      cur[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) / 255
    }
    // --- silhouette: background subtraction with adaptive model ---------------
    if (!this.bg) this.bg = cur.slice()
    const bg = this.bg
    const mask = this.mask
    let bodyPixels = 0
    for (let i = 0; i < cur.length; i++) {
      const diff = Math.abs(cur[i] - bg[i])
      const body = diff > 0.11
      if (body) bodyPixels++
      mask[i] = body ? Math.min(255, ((diff - 0.11) * 1400) | 0) : 0
      // empty scene absorbs fast; a standing person absorbs very slowly
      bg[i] += (cur[i] - bg[i]) * (body ? 0.0025 : 0.03)
    }
    // >60% "body" = exposure/lighting jump, not a person — relearn, don't paint
    if (bodyPixels > cur.length * 0.6) {
      for (let i = 0; i < cur.length; i++) {
        bg[i] += (cur[i] - bg[i]) * 0.5
        mask[i] = 0
      }
    }

    if (!this.prev) {
      this.prev = cur.slice()
      return []
    }
    const prev = this.prev
    // sensitivity 0 → only broad gestures, 1 → fingertip twitches
    const threshold = 1.6 - sensitivity * 1.45
    const out: FlowVector[] = []

    for (let gy = 1; gy < AH - CELL - 1; gy += CELL) {
      for (let gx = 1; gx < AW - CELL - 1; gx += CELL) {
        let ixx = 0
        let ixy = 0
        let iyy = 0
        let ixt = 0
        let iyt = 0
        for (let y = gy; y < gy + CELL; y++) {
          for (let x = gx; x < gx + CELL; x++) {
            const i = y * AW + x
            const ix = (cur[i + 1] - cur[i - 1]) * 0.5
            const iy = (cur[i + AW] - cur[i - AW]) * 0.5
            const it = cur[i] - prev[i]
            ixx += ix * ix
            ixy += ix * iy
            iyy += iy * iy
            ixt += ix * it
            iyt += iy * it
          }
        }
        const det = ixx * iyy - ixy * ixy
        if (det < 1e-6) continue
        const u = (ixy * iyt - iyy * ixt) / det
        const v = (ixy * ixt - ixx * iyt) / det
        const mag = Math.hypot(u, v)
        // below threshold = sensor noise; above 20 = lighting jump / scene cut
        if (mag < threshold || mag > 20) continue
        out.push({ x: (gx + CELL / 2) / AW, y: (gy + CELL / 2) / AH, u, v, mag })
      }
    }
    this.prev.set(cur)
    out.sort((a, b) => b.mag - a.mag)
    return out.slice(0, MAX_VECTORS)
  }
}
