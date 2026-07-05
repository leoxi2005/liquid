export interface FBO {
  texture: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  attach(id: number): number
  dispose(): void
}

export interface DoubleFBO {
  width: number
  height: number
  texelSizeX: number
  texelSizeY: number
  read: FBO
  write: FBO
  swap(): void
  dispose(): void
}

export function createFBO(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number
): FBO {
  gl.activeTexture(gl.TEXTURE0)
  const texture = gl.createTexture()
  if (!texture) throw new Error('Failed to create texture')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

  const fbo = gl.createFramebuffer()
  if (!fbo) throw new Error('Failed to create framebuffer')
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.viewport(0, 0, w, h)
  gl.clear(gl.COLOR_BUFFER_BIT)

  return {
    texture,
    fbo,
    width: w,
    height: h,
    texelSizeX: 1 / w,
    texelSizeY: 1 / h,
    attach(id: number): number {
      gl.activeTexture(gl.TEXTURE0 + id)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      return id
    },
    dispose(): void {
      gl.deleteTexture(texture)
      gl.deleteFramebuffer(fbo)
    }
  }
}

export function createDoubleFBO(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number
): DoubleFBO {
  let fbo1 = createFBO(gl, w, h, internalFormat, format, type, filter)
  let fbo2 = createFBO(gl, w, h, internalFormat, format, type, filter)

  return {
    width: w,
    height: h,
    texelSizeX: fbo1.texelSizeX,
    texelSizeY: fbo1.texelSizeY,
    get read() {
      return fbo1
    },
    get write() {
      return fbo2
    },
    swap(): void {
      const temp = fbo1
      fbo1 = fbo2
      fbo2 = temp
    },
    dispose(): void {
      fbo1.dispose()
      fbo2.dispose()
    }
  }
}

/**
 * Grid dimensions tracking canvas aspect; `resolution` sets the short side.
 * The long side is capped (ultra-wide canvases would otherwise blow past GPU
 * texture limits) — the short side shrinks to keep the aspect true.
 */
export function getResolution(
  gl: WebGL2RenderingContext,
  resolution: number,
  refW = gl.drawingBufferWidth,
  refH = gl.drawingBufferHeight
): { width: number; height: number } {
  const MAX_SIDE = 8192
  let aspect = refW / refH
  if (aspect < 1) aspect = 1 / aspect
  let min = Math.round(resolution)
  let max = Math.round(resolution * aspect)
  if (max > MAX_SIDE) {
    max = MAX_SIDE
    min = Math.max(64, Math.round(MAX_SIDE / aspect))
  }
  return refW > refH ? { width: max, height: min } : { width: min, height: max }
}

export type BlitFn = (target: FBO | null, clear?: boolean) => void

/** Shared fullscreen quad; every pass draws through this. */
export function createBlit(gl: WebGL2RenderingContext): BlitFn {
  const vertexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW)
  const indexBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enableVertexAttribArray(0)

  return (target: FBO | null, clear = false): void => {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    } else {
      gl.viewport(0, 0, target.width, target.height)
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    }
    if (clear) {
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }
}
