import type { GLContext } from '../gl/context'
import { compileShader, Material, Program } from '../gl/program'
import { createBlit, createFBO, getResolution, type BlitFn, type FBO } from '../gl/fbo'
import { PAPER_STYLES, type FluidStyle, type VisualParams } from '../../../shared/params'
import type { RGB } from '../color'

import baseVertSrc from '../solver/shaders/base.vert.glsl?raw'
import bloomPrefilterSrc from './shaders/bloomPrefilter.frag.glsl?raw'
import bloomBlurSrc from './shaders/bloomBlur.frag.glsl?raw'
import sunraysMaskSrc from './shaders/sunraysMask.frag.glsl?raw'
import sunraysSrc from './shaders/sunrays.frag.glsl?raw'
import blurSrc from './shaders/blur.frag.glsl?raw'
import displaySrc from './shaders/display.frag.glsl?raw'

const BLOOM_BASE_RES = 256
const BLOOM_MAX_MIPS = 7
const SUNRAYS_RES = 196

export interface PostEnv {
  time: number
  bgColor: RGB
  sunraysTint: RGB
  /** live multiplier from the audio mapping matrix */
  bloomIntensityMod: number
  /** resolved render style variant */
  style: FluidStyle
  /** beat envelope 0–1 for the display-side throb */
  beatPulse: number
}

const STYLE_KEYWORDS: Record<FluidStyle, string[]> = {
  ink: [],
  paper: ['PAPER'],
  oil: ['PAPER', 'OIL'],
  contour: ['PAPER', 'CONTOUR'],
  neon: ['NEON'],
  smoke: ['SMOKE'],
  flow: ['FLOW']
}

export class PostChain {
  private gl: WebGL2RenderingContext
  private ext: GLContext['ext']
  private blit: BlitFn

  private bloomPrefilterProgram: Program
  private bloomBlurProgram: Program
  private sunraysMaskProgram: Program
  private sunraysProgram: Program
  private blurProgram: Program
  private displayMaterial: Material

  private bloom!: FBO
  private bloomMips: FBO[] = []
  private mask!: FBO
  private sunrays!: FBO
  private sunraysTemp!: FBO

  constructor(glc: GLContext) {
    this.gl = glc.gl
    this.ext = glc.ext
    const gl = this.gl

    const baseVertex = compileShader(gl, gl.VERTEX_SHADER, baseVertSrc)
    const frag = (src: string): Program =>
      new Program(gl, baseVertex, compileShader(gl, gl.FRAGMENT_SHADER, src))

    this.bloomPrefilterProgram = frag(bloomPrefilterSrc)
    this.bloomBlurProgram = frag(bloomBlurSrc)
    this.sunraysMaskProgram = frag(sunraysMaskSrc)
    this.sunraysProgram = frag(sunraysSrc)
    this.blurProgram = frag(blurSrc)
    this.displayMaterial = new Material(gl, baseVertex, displaySrc)

    this.blit = createBlit(gl)
  }

  /** bloom/sunrays need linear filtering on float textures */
  get available(): boolean {
    return this.ext.supportLinearFiltering
  }

  initFramebuffers(refW?: number, refH?: number): void {
    const gl = this.gl
    const ext = this.ext
    const rw = refW ?? gl.drawingBufferWidth
    const rh = refH ?? gl.drawingBufferHeight
    const texType = ext.halfFloatTexType
    const rgba = ext.formatRGBA
    const r = ext.formatR
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST

    this.bloom?.dispose()
    for (const mip of this.bloomMips) mip.dispose()
    this.bloomMips = []
    this.mask?.dispose()
    this.sunrays?.dispose()
    this.sunraysTemp?.dispose()

    const bloomRes = getResolution(gl, BLOOM_BASE_RES, rw, rh)
    this.bloom = createFBO(gl, bloomRes.width, bloomRes.height, rgba.internalFormat, rgba.format, texType, filtering)
    for (let i = 0; i < BLOOM_MAX_MIPS; i++) {
      const width = bloomRes.width >> (i + 1)
      const height = bloomRes.height >> (i + 1)
      if (width < 2 || height < 2) break
      this.bloomMips.push(createFBO(gl, width, height, rgba.internalFormat, rgba.format, texType, filtering))
    }

    const sunraysRes = getResolution(gl, SUNRAYS_RES, rw, rh)
    this.mask = createFBO(gl, sunraysRes.width, sunraysRes.height, r.internalFormat, r.format, texType, filtering)
    this.sunrays = createFBO(gl, sunraysRes.width, sunraysRes.height, r.internalFormat, r.format, texType, filtering)
    this.sunraysTemp = createFBO(gl, sunraysRes.width, sunraysRes.height, r.internalFormat, r.format, texType, filtering)
  }

  /** target = null → the on-screen canvas; an FBO → offscreen feed (floor) */
  render(dye: FBO, velocity: FBO, p: VisualParams, env: PostEnv, target: FBO | null = null): void {
    const gl = this.gl
    const paper = PAPER_STYLES.includes(env.style)
    const bloomOn = !paper && p.bloom && this.available && this.bloomMips.length > 0
    const sunraysOn = !paper && p.sunrays && this.available

    if (bloomOn) this.applyBloom(dye, p)
    if (sunraysOn) this.applySunrays(dye, p)

    const keywords: string[] = [...STYLE_KEYWORDS[env.style]]
    if (p.shading) keywords.push('SHADING')
    if (bloomOn) keywords.push('BLOOM')
    if (sunraysOn) keywords.push('SUNRAYS')
    this.displayMaterial.setKeywords(keywords)
    this.displayMaterial.bind()
    const u = this.displayMaterial.uniforms

    gl.disable(gl.BLEND)
    const w = target ? target.width : gl.drawingBufferWidth
    const h = target ? target.height : gl.drawingBufferHeight
    gl.uniform2f(u.texelSize, 1 / w, 1 / h)
    gl.uniform1i(u.uTexture, dye.attach(0))
    gl.uniform1f(u.aspect, w / h)
    gl.uniform3f(u.bgColor, env.bgColor[0], env.bgColor[1], env.bgColor[2])
    gl.uniform1f(u.bgGradient, p.bgGradient)
    gl.uniform1f(u.exposure, p.exposure)
    gl.uniform1f(u.contrast, p.contrast)
    gl.uniform1f(u.saturation, p.saturation)
    gl.uniform1f(u.lift, p.lift)
    gl.uniform1f(u.gamma, p.gamma)
    gl.uniform1f(u.gain, p.gain)
    gl.uniform1f(u.vignette, p.vignette)
    gl.uniform1f(u.grain, p.grain)
    gl.uniform1f(u.paperTexture, p.texture)
    gl.uniform1f(u.uTime, env.time)
    gl.uniform1f(u.beatPulse, env.beatPulse)
    if (bloomOn) {
      gl.uniform1i(u.uBloom, this.bloom.attach(1))
      gl.uniform1f(u.bloomIntensity, p.bloomIntensity * env.bloomIntensityMod)
    }
    if (sunraysOn) {
      gl.uniform1i(u.uSunrays, this.sunrays.attach(2))
      gl.uniform3f(u.sunraysColor, env.sunraysTint[0], env.sunraysTint[1], env.sunraysTint[2])
    }
    if (env.style === 'flow') {
      gl.uniform1i(u.uVelocity, velocity.attach(3))
    }
    this.blit(target)
  }

  private applyBloom(source: FBO, p: VisualParams): void {
    const gl = this.gl
    gl.disable(gl.BLEND)

    // threshold with soft knee
    const knee = p.bloomThreshold * p.bloomSoftKnee + 0.0001
    this.bloomPrefilterProgram.bind()
    gl.uniform2f(this.bloomPrefilterProgram.uniforms.texelSize, this.bloom.texelSizeX, this.bloom.texelSizeY)
    gl.uniform3f(this.bloomPrefilterProgram.uniforms.curve, p.bloomThreshold - knee, knee * 2, 0.25 / knee)
    gl.uniform1f(this.bloomPrefilterProgram.uniforms.threshold, p.bloomThreshold)
    gl.uniform1i(this.bloomPrefilterProgram.uniforms.uTexture, source.attach(0))
    this.blit(this.bloom)

    // downsample chain
    this.bloomBlurProgram.bind()
    let last: FBO = this.bloom
    for (const mip of this.bloomMips) {
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY)
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0))
      this.blit(mip)
      last = mip
    }

    // additive upsample back to full bloom res
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.enable(gl.BLEND)
    for (let i = this.bloomMips.length - 2; i >= 0; i--) {
      const dest = this.bloomMips[i]
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY)
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0))
      this.blit(dest)
      last = dest
    }
    gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY)
    gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0))
    this.blit(this.bloom)
    gl.disable(gl.BLEND)
  }

  private applySunrays(dye: FBO, p: VisualParams): void {
    const gl = this.gl
    gl.disable(gl.BLEND)

    this.sunraysMaskProgram.bind()
    gl.uniform2f(this.sunraysMaskProgram.uniforms.texelSize, this.mask.texelSizeX, this.mask.texelSizeY)
    gl.uniform1i(this.sunraysMaskProgram.uniforms.uTexture, dye.attach(0))
    this.blit(this.mask)

    this.sunraysProgram.bind()
    gl.uniform2f(this.sunraysProgram.uniforms.texelSize, this.sunrays.texelSizeX, this.sunrays.texelSizeY)
    gl.uniform1f(this.sunraysProgram.uniforms.weight, p.sunraysWeight)
    gl.uniform1f(this.sunraysProgram.uniforms.density, p.sunraysDensity)
    gl.uniform1f(this.sunraysProgram.uniforms.decay, p.sunraysDecay)
    gl.uniform1i(this.sunraysProgram.uniforms.uTexture, this.mask.attach(0))
    this.blit(this.sunrays)

    // 2-pass soften so the rays don't alias at low res
    this.blurProgram.bind()
    gl.uniform2f(this.blurProgram.uniforms.texelSize, this.sunrays.texelSizeX, this.sunrays.texelSizeY)
    gl.uniform2f(this.blurProgram.uniforms.direction, this.sunrays.texelSizeX, 0)
    gl.uniform1i(this.blurProgram.uniforms.uTexture, this.sunrays.attach(0))
    this.blit(this.sunraysTemp)
    gl.uniform2f(this.blurProgram.uniforms.direction, 0, this.sunrays.texelSizeY)
    gl.uniform1i(this.blurProgram.uniforms.uTexture, this.sunraysTemp.attach(0))
    this.blit(this.sunrays)
  }
}
