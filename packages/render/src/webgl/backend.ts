import { GlState, linkProgram } from "@swf2es/context3d/device";
import { CLEAR, type Commands, RUN, STENCIL_POP, STENCIL_PUSH } from "../commands.js";
import type { Geometries, GeometryData } from "../geometry.js";
import { ROW_FLOATS, ROWS_A_LINE, type Rows } from "../rows.js";
import { DRAW, MIRROR, REPEAT, type SceneList, SMOOTH } from "../scene.js";
import type { Textures } from "../textures.js";
import { fillFragment, fillVertex, ROW_TEXELS } from "./programs.js";

/** Bytes a vertex in the atlas: its position's two floats, its texel's two, then its colour's four bytes. */
const VERTEX_BYTES = 20;
/** The most masks the stencil's eight bits count. */
const STENCIL_MOST = 255;
/** The texture unit an entry's texture is bound to; the rows are on 0. */
const TEXTURE_UNIT = 1;
/** The fewest vertices the atlas holds room for, and its indices thrice that. */
const LEAST = 1 << 16;
/** Holes past which, and past the live vertices, the atlas is packed again. */
const SLACK = 1 << 16;

/** Where a geometry lies in the atlas. */
interface Place {
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
}

/** Where a frame is drawn: the target's size in pixels, and how stage pixels map onto it. */
export interface Target {
  width: number;
  height: number;
  /** Target pixels a stage pixel, and where the stage's origin lies on the target. */
  scale: number;
  x: number;
  y: number;
}

/**
 * Executes a frame's commands on a WebGL 2 context it owns, through one
 * cache of its state. Every geometry is copied once into an atlas of a
 * vertex and an index buffer, and drawn from it a call an entry, the
 * buffers bound once and the entry told its row; rows go up once a frame
 * into a float texture. A geometry let go of leaves a hole, and the atlas
 * is packed again from the geometries' own arrays once the holes outweigh
 * what is live.
 */
export class WebGLBackend {
  readonly gl: WebGL2RenderingContext;
  readonly state: GlState;
  private program!: WebGLProgram;
  private rowLocation: WebGLUniformLocation | null = null;
  private viewLocation: WebGLUniformLocation | null = null;
  private texturedLocation: WebGLUniformLocation | null = null;
  /** The row and texture the last draw was told, so neither is told again. */
  private lastRow = -1;
  private lastTexture = -2;
  /** The textures uploaded, by the registry's ids, and their sizes; the samplers made, by their bits. */
  private textures: (WebGLTexture | null)[] = [];
  private sizes: number[] = [];
  private samplers: (WebGLSampler | null)[] = [];
  private vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  private rowsTexture!: WebGLTexture;
  private rowLines = 0;
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private vertexTop = 0;
  private indexTop = 0;
  private live = 0;
  private holes = 0;
  private places: (Place | null)[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.state = new GlState(gl);
    this.setUp();
  }

  /**
   * The context came back after it was lost: everything made again, every
   * geometry copied in again from the registry's arrays. The textures were
   * lost with it, which their owners add again (Textures.lost).
   */
  restore(geometries: Geometries): void {
    this.setUp();
    geometries.added.length = 0;
    geometries.removed.length = 0;
    this.repack(geometries);
  }

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    this.program = linkProgram(gl, fillVertex, fillFragment);
    this.rowLocation = gl.getUniformLocation(this.program, "uRow");
    this.viewLocation = gl.getUniformLocation(this.program, "uView");
    this.state.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uRows"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), TEXTURE_UNIT);
    this.texturedLocation = gl.getUniformLocation(this.program, "uTextured");
    this.textures = [];
    this.samplers = [];
    this.vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.vertexBuffer = gl.createBuffer() as WebGLBuffer;
    this.indexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    const position = gl.getAttribLocation(this.program, "aPosition");
    const texel = gl.getAttribLocation(this.program, "aTexel");
    const color = gl.getAttribLocation(this.program, "aColor");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(texel);
    gl.vertexAttribPointer(texel, 2, gl.FLOAT, false, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 16);
    this.rowsTexture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(0, this.rowsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.rowLines = 0;
    this.vertexCapacity = 0;
    this.indexCapacity = 0;
    this.places = [];
  }

  /** Draw a frame: what the geometries added and removed first, then the rows, then the commands. */
  execute(
    commands: Commands,
    scene: SceneList,
    rows: Rows,
    geometries: Geometries,
    textures: Textures,
    target: Target,
  ): void {
    const gl = this.gl;
    if (gl.isContextLost()) {
      return;
    }

    this.place(geometries);
    this.uploadTextures(textures);
    this.uploadRows(rows);
    const state = this.state;
    state.bindFramebuffer(null);
    state.viewport(0, 0, target.width, target.height);
    state.scissor(null);
    state.colorMask(15);
    state.useProgram(this.program);
    state.bindVertexArray(this.vertexArray);
    state.bindTexture(0, this.rowsTexture);
    gl.uniform4f(
      this.viewLocation,
      (2 * target.scale) / target.width,
      (-2 * target.scale) / target.height,
      -1 + (2 * target.x) / target.width,
      1 - (2 * target.y) / target.height,
    );

    this.lastRow = -1;
    this.lastTexture = -2;
    gl.uniform1i(this.texturedLocation, 0);
    // The masks pushed: what is drawn passes where the stencil holds as many. Its eight bits hold
    // 255: those pushed past that are left out, and their pops with them.
    let depth = 0;
    let past = 0;
    state.stencil(null);
    const ops = commands.ops;
    for (let k = 0; k < commands.length; k++) {
      const at = k * 4;
      switch (ops[at]) {
        case CLEAR: {
          const p = commands.params;
          const from = ops[at + 1];
          gl.clearColor(p[from], p[from + 1], p[from + 2], p[from + 3]);
          gl.clearStencil(0);
          gl.stencilMask(0xff);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          break;
        }

        case RUN:
          // Premultiplied, as every blend mode will be.
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], false);
          break;
        case STENCIL_PUSH:
        case STENCIL_POP: {
          // The mask's coverage, once a pixel however its fills overlap: counted up into the
          // stencil where the masks pushed before it pass, and back down where it and they did.
          const push = ops[at] === STENCIL_PUSH;
          if (push ? depth >= STENCIL_MOST || past > 0 : past > 0) {
            past += push ? 1 : -1;
            break;
          }

          state.colorMask(0);
          state.stencil(gl.EQUAL, depth, push ? gl.INCR : gl.DECR);
          this.drawEntries(scene, ops[at + 1], ops[at + 1] + ops[at + 2], true);
          depth += push ? 1 : -1;
          state.colorMask(15);
          state.stencil(depth > 0 ? gl.EQUAL : null, depth, gl.KEEP);
          break;
        }
      }
    }

    state.stencil(null);
  }

  /** The draws at `scene`'s entries from `first` up to `end`; for the stencil alone, untextured. */
  private drawEntries(scene: SceneList, first: number, end: number, stencil: boolean): void {
    const gl = this.gl;
    const state = this.state;
    for (let i = first; i < end; i++) {
      if (scene.kind[i] !== DRAW) {
        continue;
      }

      const place = this.places[scene.geometry[i]];
      if (!place) {
        continue;
      }

      const row = scene.row[i];
      if (row !== this.lastRow) {
        this.lastRow = row;
        gl.uniform1i(this.rowLocation, row);
      }

      const id = stencil ? -1 : scene.texture[i];
      const texture = id >= 0 ? (this.textures[id] ?? null) : null;
      if (id >= 0 && !texture) {
        continue;
      }

      if (id >= 0 !== this.lastTexture >= 0) {
        gl.uniform1i(this.texturedLocation, id >= 0 ? 1 : 0);
      }

      this.lastTexture = id;
      if (texture) {
        state.bindTexture(TEXTURE_UNIT, texture);
        state.bindSampler(TEXTURE_UNIT, this.sampler(scene.sampler[i]));
      }

      gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
    }
  }

  /** The textures removed since the last frame deleted, and those added or changed uploaded, their pixels let go. */
  private uploadTextures(textures: Textures): void {
    const gl = this.gl;
    for (const id of textures.removed) {
      const texture = this.textures[id];
      if (texture) {
        this.state.dropTexture(texture);
        gl.deleteTexture(texture);
        this.textures[id] = null;
      }
    }

    textures.removed.length = 0;
    for (const id of textures.pending) {
      const data = textures.get(id);
      if (!data?.pixels) {
        continue;
      }

      let texture = this.textures[id];
      if (!texture) {
        texture = gl.createTexture() as WebGLTexture;
        this.textures[id] = texture;
        this.sizes[id * 2] = -1;
      }

      this.state.bindTexture(TEXTURE_UNIT, texture);
      this.state.activeTexture(TEXTURE_UNIT);
      // Pixels of the same size go into the texture there is; another size makes it again.
      if (this.sizes[id * 2] === data.width && this.sizes[id * 2 + 1] === data.height) {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          data.width,
          data.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data.pixels,
        );
        data.pixels = null;
        continue;
      }

      this.sizes[id * 2] = data.width;
      this.sizes[id * 2 + 1] = data.height;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        data.width,
        data.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data.pixels,
      );
      data.pixels = null;
    }

    textures.pending.length = 0;
  }

  /** The sampler for `bits` (SMOOTH, and REPEAT or MIRROR), made as first asked for. */
  private sampler(bits: number): WebGLSampler {
    const known = this.samplers[bits];
    if (known) {
      return known;
    }

    const gl = this.gl;
    const sampler = gl.createSampler() as WebGLSampler;
    const filter = bits & SMOOTH ? gl.LINEAR : gl.NEAREST;
    const wrap = bits & REPEAT ? gl.REPEAT : bits & MIRROR ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, wrap);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, wrap);
    this.samplers[bits] = sampler;
    return sampler;
  }

  /** The rows a frame wrote, uploaded in one call, the texture made taller first if they need it. */
  private uploadRows(rows: Rows): void {
    const gl = this.gl;
    const lines = Math.max(1, Math.ceil(rows.count / ROWS_A_LINE));
    const width = ROWS_A_LINE * ROW_TEXELS;
    this.state.bindTexture(0, this.rowsTexture);
    this.state.activeTexture(0);
    if (lines > this.rowLines) {
      this.rowLines = Math.max(lines, this.rowLines * 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, this.rowLines, 0, gl.RGBA, gl.FLOAT, null);
    }

    if (rows.count > 0) {
      // Whole lines: the data holds ROW_FLOATS a row for as many rows as its lines hold.
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        width,
        lines,
        gl.RGBA,
        gl.FLOAT,
        rows.data.subarray(0, lines * ROWS_A_LINE * ROW_FLOATS),
      );
    }
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in: at the top while they fit, else into an atlas packed again,
   * grown to twice what is live.
   */
  private place(geometries: Geometries): void {
    for (const id of geometries.removed) {
      const place = this.places[id];
      if (place) {
        this.places[id] = null;
        this.live -= place.vertices;
        this.holes += place.vertices;
      }
    }

    geometries.removed.length = 0;
    let vertices = 0;
    let indices = 0;
    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    if (
      this.vertexTop + vertices > this.vertexCapacity ||
      this.indexTop + indices > this.indexCapacity ||
      (this.holes > SLACK && this.holes > this.live)
    ) {
      geometries.added.length = 0;
      this.repack(geometries);
      return;
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data) {
        this.copyIn(id, data);
      }
    }

    geometries.added.length = 0;
  }

  /** Every live geometry copied into new buffers, with room for twice what is live. */
  private repack(geometries: Geometries): void {
    const gl = this.gl;
    const ids = geometries.live();
    let vertices = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      vertices += data.positions.length / 2;
      indices += data.indices.length;
    }

    this.vertexCapacity = Math.max(LEAST, vertices * 2);
    this.indexCapacity = Math.max(LEAST * 3, indices * 2);
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity * 4, gl.STATIC_DRAW);
    this.vertexTop = 0;
    this.indexTop = 0;
    this.live = 0;
    this.holes = 0;
    this.places = [];
    for (const id of ids) {
      this.copyIn(id, geometries.get(id) as GeometryData);
    }
  }

  /** `data` copied in at the top of the atlas, its indices made absolute. */
  private copyIn(id: number, data: GeometryData): void {
    const gl = this.gl;
    const count = data.positions.length / 2;
    const bytes = new ArrayBuffer(count * VERTEX_BYTES);
    const floats = new Float32Array(bytes);
    const words = new Uint32Array(bytes);
    const texels = data.texels;
    for (let i = 0; i < count; i++) {
      floats[i * 5] = data.positions[i * 2];
      floats[i * 5 + 1] = data.positions[i * 2 + 1];
      floats[i * 5 + 2] = texels ? texels[i * 2] : 0;
      floats[i * 5 + 3] = texels ? texels[i * 2 + 1] : 0;
      words[i * 5 + 4] = data.colors[i];
    }

    const base = this.vertexTop;
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + base;
    }

    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, this.indexTop * 4, indices);
    this.places[id] = {
      vertexStart: base,
      vertices: count,
      indexStart: this.indexTop,
      indices: indices.length,
    };
    this.vertexTop += count;
    this.indexTop += indices.length;
    this.live += count;
  }

  /** What the backend made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteTexture(this.rowsTexture);
    for (const texture of this.textures) {
      if (texture) {
        gl.deleteTexture(texture);
      }
    }

    for (const sampler of this.samplers) {
      if (sampler) {
        gl.deleteSampler(sampler);
      }
    }

    this.state.forget();
  }
}
