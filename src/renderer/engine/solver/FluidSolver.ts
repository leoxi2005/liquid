import type { GLContext } from '../gl/context'
import { compileShader, Program } from '../gl/program'
import { createBlit, createDoubleFBO, createFBO, getResolution, type BlitFn, type DoubleFBO, type FBO } from '../gl/fbo'
import type { SimParams } from '../../../shared/params'
import type { RGB } from '../color'

import baseVertSrc from './shaders/base.vert.glsl?raw'
import copyFragSrc from './shaders/copy.frag.glsl?raw'
import clearFragSrc from './shaders/clear.frag.glsl?raw'
import splatFragSrc from './shaders/splat.frag.glsl?raw'
import advectionFragSrc from './shaders/advection.frag.glsl?raw'
import maccormackFragSrc from './shaders/maccormack.frag.glsl?raw'
import curlFragSrc from './shaders/curl.frag.glsl?raw'
import vorticityFragSrc from './shaders/vorticity.frag.glsl?raw'
import divergenceFragSrc from './shaders/divergence.frag.glsl?raw'
import pressureFragSrc from './shaders/pressure.frag.glsl?raw'
import gradientSubtractFragSrc from './shaders/gradientSubtract.frag.glsl?raw'

export class FluidSolver {
  private gl: WebGL2RenderingContext
  private ext: GLContext['ext']
  private blit: BlitFn

  private copyProgram: Program
  private clearProgram: Program
  private splatProgram: Program
  private advectionProgram: Program
  private maccormackProgram: Program
  private curlProgram: Program
  private vorticityProgram: Program
  private divergenceProgram: Program
  private pressureProgram: Program
  private gradientSubtractProgram: Program

  private dye!: DoubleFBO
  private velocity!: DoubleFBO
  private divergence!: FBO
  private curl!: FBO
  private pressure!: DoubleFBO
  // scratch targets for MacCormack forward/backward estimates
  private dyeTemp1!: FBO
  private dyeTemp2!: FBO
  // fixed output size (offscreen targets like the floor feed);
  // null → follow the live drawing buffer, as the on-screen sim always did
  private outW: number | null = null
  private outH: number | null = null

  constructor(glc: GLContext) {
    this.gl = glc.gl
    this.ext = glc.ext
    const gl = this.gl

    const baseVertex = compileShader(gl, gl.VERTEX_SHADER, baseVertSrc)
    const frag = (src: string, keywords?: string[]): Program =>
      new Program(gl, baseVertex, compileShader(gl, gl.FRAGMENT_SHADER, src, keywords))

    const filterKeywords = this.ext.supportLinearFiltering ? undefined : ['MANUAL_FILTERING']
    this.copyProgram = frag(copyFragSrc)
    this.clearProgram = frag(clearFragSrc)
    this.splatProgram = frag(splatFragSrc)
    this.advectionProgram = frag(advectionFragSrc, filterKeywords)
    this.maccormackProgram = frag(maccormackFragSrc)
    this.curlProgram = frag(curlFragSrc)
    this.vorticityProgram = frag(vorticityFragSrc)
    this.divergenceProgram = frag(divergenceFragSrc)
    this.pressureProgram = frag(pressureFragSrc)
    this.gradientSubtractProgram = frag(gradientSubtractFragSrc)

    this.blit = createBlit(gl)
  }

  /** current dye texture — input to the post chain */
  get dyeRead(): FBO {
    return this.dye.read
  }

  /** current velocity field — the 'flow' style colors by direction */
  get velocityRead(): FBO {
    return this.velocity.read
  }

  initFramebuffers(simResParam: number, dyeResParam: number, outW?: number, outH?: number): void {
    const gl = this.gl
    const ext = this.ext
    this.outW = outW ?? null
    this.outH = outH ?? null
    const refW = this.outW ?? gl.drawingBufferWidth
    const refH = this.outH ?? gl.drawingBufferHeight
    const simRes = getResolution(gl, simResParam, refW, refH)
    const dyeRes = getResolution(gl, dyeResParam, refW, refH)
    const texType = ext.halfFloatTexType
    const rgba = ext.formatRGBA
    const rg = ext.formatRG
    const r = ext.formatR
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST

    gl.disable(gl.BLEND)

    // dye & velocity survive resizes (content copied); the rest is transient
    this.dye = this.dye
      ? this.resizeDoubleFBO(this.dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)
      : createDoubleFBO(gl, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)

    this.velocity = this.velocity
      ? this.resizeDoubleFBO(this.velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering)
      : createDoubleFBO(gl, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering)

    this.divergence?.dispose()
    this.curl?.dispose()
    this.pressure?.dispose()
    this.dyeTemp1?.dispose()
    this.dyeTemp2?.dispose()

    this.divergence = createFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST)
    this.curl = createFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST)
    this.pressure = createDoubleFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST)
    this.dyeTemp1 = createFBO(gl, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)
    this.dyeTemp2 = createFBO(gl, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering)
  }

  private resizeDoubleFBO(
    target: DoubleFBO,
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    filter: number
  ): DoubleFBO {
    if (target.width === w && target.height === h) return target
    const gl = this.gl
    const next = createDoubleFBO(gl, w, h, internalFormat, format, type, filter)
    this.copyProgram.bind()
    gl.uniform2f(this.copyProgram.uniforms.texelSize, 1 / w, 1 / h)
    gl.uniform1i(this.copyProgram.uniforms.uTexture, target.read.attach(0))
    this.blit(next.read)
    target.dispose()
    return next
  }

  step(dt: number, p: SimParams): void {
    const gl = this.gl
    gl.disable(gl.BLEND)

    const vw = this.velocity.read.texelSizeX
    const vh = this.velocity.read.texelSizeY

    this.curlProgram.bind()
    gl.uniform2f(this.curlProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.curlProgram.uniforms.uVelocity, this.velocity.read.attach(0))
    this.blit(this.curl)

    this.vorticityProgram.bind()
    gl.uniform2f(this.vorticityProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.vorticityProgram.uniforms.uVelocity, this.velocity.read.attach(0))
    gl.uniform1i(this.vorticityProgram.uniforms.uCurl, this.curl.attach(1))
    gl.uniform1f(this.vorticityProgram.uniforms.curl, p.curl)
    gl.uniform1f(this.vorticityProgram.uniforms.dt, dt)
    this.blit(this.velocity.write)
    this.velocity.swap()

    this.divergenceProgram.bind()
    gl.uniform2f(this.divergenceProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.divergenceProgram.uniforms.uVelocity, this.velocity.read.attach(0))
    this.blit(this.divergence)

    // damp last frame's pressure as the Jacobi warm start
    this.clearProgram.bind()
    gl.uniform2f(this.clearProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.clearProgram.uniforms.uTexture, this.pressure.read.attach(0))
    gl.uniform1f(this.clearProgram.uniforms.value, p.pressure)
    this.blit(this.pressure.write)
    this.pressure.swap()

    this.pressureProgram.bind()
    gl.uniform2f(this.pressureProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.pressureProgram.uniforms.uDivergence, this.divergence.attach(0))
    for (let i = 0; i < p.pressureIterations; i++) {
      gl.uniform1i(this.pressureProgram.uniforms.uPressure, this.pressure.read.attach(1))
      this.blit(this.pressure.write)
      this.pressure.swap()
    }

    this.gradientSubtractProgram.bind()
    gl.uniform2f(this.gradientSubtractProgram.uniforms.texelSize, vw, vh)
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uPressure, this.pressure.read.attach(0))
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uVelocity, this.velocity.read.attach(1))
    this.blit(this.velocity.write)
    this.velocity.swap()

    // velocity self-advection: plain semi-Lagrangian is stable enough here
    this.advectionProgram.bind()
    gl.uniform2f(this.advectionProgram.uniforms.texelSize, vw, vh)
    if (!this.ext.supportLinearFiltering) {
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, vw, vh)
    }
    const velocityId = this.velocity.read.attach(0)
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, velocityId)
    gl.uniform1i(this.advectionProgram.uniforms.uSource, velocityId)
    gl.uniform1f(this.advectionProgram.uniforms.dt, dt)
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, p.velocityDissipation)
    this.blit(this.velocity.write)
    this.velocity.swap()

    if (p.maccormack) {
      this.advectDyeMacCormack(dt, p)
    } else {
      if (!this.ext.supportLinearFiltering) {
        gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, this.dye.read.texelSizeX, this.dye.read.texelSizeY)
      }
      gl.uniform1i(this.advectionProgram.uniforms.uVelocity, this.velocity.read.attach(0))
      gl.uniform1i(this.advectionProgram.uniforms.uSource, this.dye.read.attach(1))
      gl.uniform1f(this.advectionProgram.uniforms.dissipation, p.densityDissipation)
      this.blit(this.dye.write)
      this.dye.swap()
    }
  }

  private advectDyeMacCormack(dt: number, p: SimParams): void {
    const gl = this.gl
    const dyeTexelX = this.dye.read.texelSizeX
    const dyeTexelY = this.dye.read.texelSizeY

    // forward + backward estimates share the advection program, decay-free
    this.advectionProgram.bind()
    if (!this.ext.supportLinearFiltering) {
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, dyeTexelX, dyeTexelY)
    }
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, 0)
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, this.velocity.read.attach(0))
    gl.uniform1i(this.advectionProgram.uniforms.uSource, this.dye.read.attach(1))
    gl.uniform1f(this.advectionProgram.uniforms.dt, dt)
    this.blit(this.dyeTemp1)

    gl.uniform1i(this.advectionProgram.uniforms.uSource, this.dyeTemp1.attach(1))
    gl.uniform1f(this.advectionProgram.uniforms.dt, -dt)
    this.blit(this.dyeTemp2)

    this.maccormackProgram.bind()
    gl.uniform2f(this.maccormackProgram.uniforms.texelSize, this.velocity.read.texelSizeX, this.velocity.read.texelSizeY)
    gl.uniform2f(this.maccormackProgram.uniforms.dyeTexelSize, dyeTexelX, dyeTexelY)
    gl.uniform1i(this.maccormackProgram.uniforms.uVelocity, this.velocity.read.attach(0))
    gl.uniform1i(this.maccormackProgram.uniforms.uSource, this.dye.read.attach(1))
    gl.uniform1i(this.maccormackProgram.uniforms.uForward, this.dyeTemp1.attach(2))
    gl.uniform1i(this.maccormackProgram.uniforms.uBackward, this.dyeTemp2.attach(3))
    gl.uniform1f(this.maccormackProgram.uniforms.dt, dt)
    gl.uniform1f(this.maccormackProgram.uniforms.dissipation, p.densityDissipation)
    this.blit(this.dye.write)
    this.dye.swap()
  }

  /** output aspect this sim renders at (fixed for offscreen targets) */
  private outAspect(): number {
    return this.outW && this.outH ? this.outW / this.outH : this.gl.drawingBufferWidth / this.gl.drawingBufferHeight
  }

  /** x/y in texcoords (0–1, y up), dx/dy velocity impulse, color dye RGB */
  splat(x: number, y: number, dx: number, dy: number, color: RGB, radiusParam: number): void {
    const gl = this.gl
    this.splatProgram.bind()
    gl.uniform2f(this.splatProgram.uniforms.texelSize, this.velocity.read.texelSizeX, this.velocity.read.texelSizeY)
    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.velocity.read.attach(0))
    gl.uniform1f(this.splatProgram.uniforms.aspectRatio, this.outAspect())
    gl.uniform2f(this.splatProgram.uniforms.point, x, y)
    gl.uniform3f(this.splatProgram.uniforms.color, dx, dy, 0)
    gl.uniform1f(this.splatProgram.uniforms.radius, this.correctRadius(radiusParam / 100))
    gl.uniform1f(this.splatProgram.uniforms.clampValue, 1e6)
    this.blit(this.velocity.write)
    this.velocity.swap()

    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.dye.read.attach(0))
    gl.uniform3f(this.splatProgram.uniforms.color, color[0], color[1], color[2])
    gl.uniform1f(this.splatProgram.uniforms.clampValue, 1.3)
    this.blit(this.dye.write)
    this.dye.swap()
  }

  multipleSplats(amount: number, splatRadius: number, colorFn: () => RGB): void {
    for (let i = 0; i < amount; i++) {
      const x = 0.1 + Math.random() * 0.8
      const y = 0.15 + Math.random() * 0.7
      // gentle push — drops should bloom in place, not smear across the canvas
      const dx = 300 * (Math.random() - 0.5)
      const dy = 300 * (Math.random() - 0.5)
      this.splat(x, y, dx, dy, colorFn(), splatRadius)
    }
  }

  clearDye(): void {
    const gl = this.gl
    for (const target of [this.dye.read, this.dye.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  private correctRadius(radius: number): number {
    const aspect = this.outAspect()
    return aspect > 1 ? radius * aspect : radius
  }
}
