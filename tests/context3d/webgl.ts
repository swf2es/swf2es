import { type ProgramType, type ShaderSource, translate } from "./agal.ts";
import type { Buffer3D, Context3D, Program3D } from "./backend.ts";

function range(start: number, count: number, length: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    start < 0 ||
    count < 0 ||
    start > length - count
  ) {
    throw new Error("Context3D experiment: range outside resource");
  }
}

interface BufferState {
  handle: WebGLBuffer;
  indices: Uint16Array | null;
  uploaded: Uint8Array;
}

interface ProgramState {
  handle: WebGLProgram | null;
  attributes: number[];
  vertex: (WebGLUniformLocation | null)[];
  fragment: (WebGLUniformLocation | null)[];
}

/** An owned WebGL2 context, deliberately independent of the 2D renderer. */
export class WebGLContext3D implements Context3D {
  readonly gl: WebGL2RenderingContext;
  width = 0;
  height = 0;
  disposed = false;
  private readonly buffers = new Map<Buffer3D, BufferState>();
  private bufferBytes = 0;
  private readonly programs = new Map<Program3D, ProgramState>();
  private readonly vertices: ({ buffer: Buffer3D; offset: number; size: number } | null)[] =
    new Array(8).fill(null);
  private selected: Program3D | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private readonly vertexConstants = new Float32Array(128 * 4);
  private readonly fragmentConstants = new Float32Array(28 * 4);
  private pixels = new Uint8Array(0);
  private topDown = new Uint8Array(0);
  private readonly vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("Context3D experiment: cannot create vertex array");
    }

    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
  }

  private alive(): void {
    if (this.disposed || this.gl.isContextLost()) {
      throw new Error("Context3D experiment: context disposed or lost");
    }
  }

  private target(): void {
    this.alive();
    if (!this.framebuffer) {
      throw new Error("Context3D experiment: configure the back buffer first");
    }

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  configure(width: number, height: number): void {
    this.alive();
    range(1, width - 1, 2048);
    range(1, height - 1, 2048);
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new Error("Context3D experiment: cannot allocate back buffer");
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      throw new Error("Context3D experiment: incomplete back buffer");
    }

    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.framebuffer);
    this.texture = texture;
    this.framebuffer = framebuffer;
    this.width = width;
    this.height = height;
    gl.canvas.width = width;
    gl.canvas.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.topDown = new Uint8Array(this.pixels.length);
    this.clear(0, 0, 0, 1);
  }

  clear(red: number, green: number, blue: number, alpha: number): void {
    this.target();
    this.gl.clearColor(red, green, blue, alpha);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  createBuffer(count: number, stride: number): Buffer3D {
    this.alive();
    range(1, count - 1, stride === 0 ? 524287 : 65535);
    range(0, stride, 64);
    if (this.buffers.size >= 128) {
      throw new Error("Context3D experiment: buffer limit");
    }

    const gl = this.gl;
    const handle = gl.createBuffer();
    if (!handle) {
      throw new Error("Context3D experiment: cannot allocate buffer");
    }

    const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
    const bytes = count * (stride === 0 ? 2 : stride * 4);
    if (this.bufferBytes + bytes > 64 * 1024 * 1024) {
      gl.deleteBuffer(handle);
      throw new Error("Context3D experiment: buffer memory limit");
    }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(target, handle);
    gl.bufferData(target, bytes, gl.STATIC_DRAW);
    const state: BufferState = {
      handle,
      indices: stride === 0 ? new Uint16Array(count) : null,
      uploaded: new Uint8Array(count),
    };
    const buffer: Buffer3D = {
      count,
      stride,
      upload: (values, start, amount) => {
        this.alive();
        this.buffer(buffer);
        range(start, amount, count);
        const size = stride || 1;
        range(0, amount * size, values.length);
        const data = stride === 0 ? new Uint16Array(amount) : new Float32Array(amount * stride);
        for (let i = 0; i < data.length; i++) {
          data[i] = values[i];
        }

        state.indices?.set(data, start);
        state.uploaded.fill(1, start, start + amount);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(target, handle);
        gl.bufferSubData(target, start * size * (stride === 0 ? 2 : 4), data);
      },
      dispose: () => {
        if (!this.buffers.delete(buffer)) {
          return;
        }

        gl.deleteBuffer(handle);
        this.bufferBytes -= bytes;
        state.indices = null;
        state.uploaded = new Uint8Array(0);
        for (let i = 0; i < this.vertices.length; i++) {
          if (this.vertices[i]?.buffer === buffer) {
            this.vertices[i] = null;
          }
        }
      },
    };
    this.buffers.set(buffer, state);
    this.bufferBytes += bytes;
    return buffer;
  }

  private buffer(buffer: Buffer3D): BufferState {
    const state = this.buffers.get(buffer);
    if (!state) {
      throw new Error("Context3D experiment: buffer disposed or from another context");
    }

    return state;
  }

  createProgram(): Program3D {
    this.alive();
    if (this.programs.size >= 128) {
      throw new Error("Context3D experiment: program limit");
    }

    const state: ProgramState = { handle: null, attributes: [], vertex: [], fragment: [] };
    const program: Program3D = {
      upload: (vertex, fragment) => {
        this.alive();
        this.program(program);
        // Translate both before allocating anything on the GPU.
        const vs = translate(vertex, "vertex");
        const fs = translate(fragment, "fragment");
        const handle = this.link(vs, fs);
        const gl = this.gl;
        gl.deleteProgram(state.handle);
        state.handle = handle;
        state.attributes = vs.attributes;
        state.vertex = [];
        state.fragment = [];
        for (let i = 0; i < vs.constants.length; i++) {
          const index = vs.constants[i];
          state.vertex[index] = gl.getUniformLocation(handle, `vc${index}`);
        }

        for (let i = 0; i < fs.constants.length; i++) {
          const index = fs.constants[i];
          state.fragment[index] = gl.getUniformLocation(handle, `fc${index}`);
        }
      },
      dispose: () => {
        if (!this.programs.delete(program)) {
          return;
        }

        this.gl.deleteProgram(state.handle);
        state.handle = null;
        if (this.selected === program) {
          this.selected = null;
        }
      },
    };
    this.programs.set(program, state);
    return program;
  }

  private program(program: Program3D): ProgramState {
    const state = this.programs.get(program);
    if (!state) {
      throw new Error("Context3D experiment: program disposed or from another context");
    }

    return state;
  }

  private link(vertex: ShaderSource, fragment: ShaderSource): WebGLProgram {
    const gl = this.gl;
    const v = gl.createShader(gl.VERTEX_SHADER);
    const f = gl.createShader(gl.FRAGMENT_SHADER);
    const p = gl.createProgram();
    let linked = false;
    let attached = false;
    try {
      if (!v || !f || !p) {
        throw new Error("Context3D experiment: cannot allocate shader");
      }

      gl.shaderSource(v, vertex.source);
      gl.shaderSource(f, fragment.source);
      gl.compileShader(v);
      gl.compileShader(f);
      if (
        !gl.getShaderParameter(v, gl.COMPILE_STATUS) ||
        !gl.getShaderParameter(f, gl.COMPILE_STATUS)
      ) {
        throw new Error(`Context3D shader: ${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
      }

      gl.attachShader(p, v);
      gl.attachShader(p, f);
      attached = true;
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`Context3D link: ${gl.getProgramInfoLog(p)}`);
      }

      linked = true;
      return p;
    } finally {
      if (attached && p && v) {
        gl.detachShader(p, v);
      }
      if (attached && p && f) {
        gl.detachShader(p, f);
      }
      gl.deleteShader(v);
      gl.deleteShader(f);
      if (!linked) {
        gl.deleteProgram(p);
      }
    }
  }

  setProgram(program: Program3D): void {
    this.alive();
    if (!this.program(program).handle) {
      throw new Error("Context3D experiment: program not uploaded");
    }

    this.selected = program;
  }

  setVertex(index: number, buffer: Buffer3D | null, offset: number, size: number): void {
    this.alive();
    range(index, 1, 8);
    if (buffer === null) {
      this.vertices[index] = null;
      return;
    }

    this.buffer(buffer);
    range(1, size - 1, 4);
    range(offset, size, buffer.stride);
    this.vertices[index] = { buffer, offset, size };
  }

  setConstants(stage: ProgramType, first: number, values: ArrayLike<number>, count: number): void {
    this.alive();
    const dest = stage === "vertex" ? this.vertexConstants : this.fragmentConstants;
    range(first, count, dest.length / 4);
    range(0, count * 4, values.length);
    for (let i = 0; i < count * 4; i++) {
      dest[first * 4 + i] = values[i];
    }
  }

  draw(indices: Buffer3D, first: number, triangles: number): void {
    this.target();
    const index = this.buffer(indices);
    if (!index.indices || !this.selected) {
      throw new Error("Context3D experiment: draw needs indices and a program");
    }

    const state = this.program(this.selected);
    const count = triangles === -1 ? indices.count - first : triangles * 3;
    range(first, count, indices.count);
    if (count % 3 !== 0) {
      throw new Error("Context3D experiment: incomplete triangle");
    }

    for (let i = first; i < first + count; i++) {
      if (!index.uploaded[i]) {
        throw new Error("Context3D experiment: index not uploaded");
      }
    }

    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    for (let i = 0; i < 8; i++) {
      gl.disableVertexAttribArray(i);
    }

    for (let i = 0; i < state.attributes.length; i++) {
      const slot = state.attributes[i];
      const binding = this.vertices[slot];
      if (!binding) {
        throw new Error("Context3D experiment: missing vertex binding");
      }

      const buffer = this.buffer(binding.buffer);
      for (let j = first; j < first + count; j++) {
        if (!buffer.uploaded[index.indices[j]]) {
          throw new Error("Context3D experiment: vertex not uploaded or out of range");
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(
        slot,
        binding.size,
        gl.FLOAT,
        false,
        binding.buffer.stride * 4,
        binding.offset * 4,
      );
    }

    gl.useProgram(state.handle);
    this.uniforms(state.vertex, this.vertexConstants);
    this.uniforms(state.fragment, this.fragmentConstants);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index.handle);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
  }

  private uniforms(locations: (WebGLUniformLocation | null)[], data: Float32Array): void {
    for (let i = 0; i < locations.length; i++) {
      if (locations[i]) {
        this.gl.uniform4fv(locations[i], data, i * 4, 4);
      }
    }
  }

  read(): Uint8Array {
    this.target();
    const gl = this.gl;
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    const row = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const from = (this.height - y - 1) * row;
      const to = y * row;
      for (let x = 0; x < row; x++) {
        this.topDown[to + x] = this.pixels[from + x];
      }
    }

    return this.topDown;
  }

  present(): void {
    this.target();
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width,
      this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.flush();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const buffer of this.buffers.keys()) {
      buffer.dispose();
    }
    for (const program of this.programs.keys()) {
      program.dispose();
    }
    this.gl.bindVertexArray(null);
    this.gl.useProgram(null);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
    this.framebuffer = null;
    this.texture = null;
    this.pixels = new Uint8Array(0);
    this.topDown = new Uint8Array(0);
  }
}
