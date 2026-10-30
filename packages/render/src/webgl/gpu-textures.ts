import type { GlState } from "@swf2es/context3d/device";
import { ROW_FLOATS, ROWS_A_LINE, type Rows } from "../rows.js";
import { MIRROR, REPEAT, SMOOTH } from "../scene.js";
import type { Textures } from "../textures.js";
import { OUTLINE_ROW, OUTLINE_UNIT, ROW_TEXELS, TEXTURE_UNIT } from "./programs.js";

/**
 * The textures the programs read: the registry's, uploaded as they are
 * added or change, and the samplers they are read through; the rows, a
 * float texture uploaded once a frame; and advanced text's outlines.
 */
export class GpuTextures {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  /** The textures uploaded, by the registry's ids, and their sizes; the samplers made, by their bits. */
  textures: (WebGLTexture | null)[] = [];
  private sizes: number[] = [];
  private samplers: (WebGLSampler | null)[] = [];
  rowsTexture!: WebGLTexture;
  private rowLines = 0;
  /** Advanced text's outlines (uploadOutlines), on OUTLINE_UNIT for the glyph program. */
  outlines: WebGLTexture | null = null;
  /** The outlines uploaded: of which epoch, how many segments, and the texture's rows. */
  private outlineEpoch = -1;
  private outlineCount = 0;
  private outlineRows = 0;

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
  }

  /** The rows' texture made, and none other yet, as the context comes or comes back. */
  setUp(): void {
    const gl = this.gl;
    this.outlines = null;
    this.outlineEpoch = -1;
    this.outlineCount = 0;
    this.outlineRows = 0;
    this.textures = [];
    this.samplers = [];
    this.rowsTexture = gl.createTexture() as WebGLTexture;
    this.state.bindTexture(0, this.rowsTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.rowLines = 0;
  }

  /** Whether texture `id` of the frame's is there, for a filter that reads it. */
  readonly hasTexture = (id: number) => id >= 0 && (this.textures[id] ?? null) !== null;

  /**
   * Advanced text's outlines (GeometryData.glyphs), `count` segments of four floats each
   * in `data`, as the player's store holds them: uploaded whole for another
   * `epoch` or a larger store, else the rows added since.
   */
  uploadOutlines(data: Float32Array, count: number, epoch: number): void {
    const gl = this.gl;
    if (gl.isContextLost() || count === 0) {
      return;
    }

    const rows = data.length / 4 / OUTLINE_ROW;
    let from = epoch === this.outlineEpoch ? this.outlineCount : 0;
    if (!this.outlines || rows !== this.outlineRows) {
      if (this.outlines) {
        this.state.dropTexture(this.outlines);
        gl.deleteTexture(this.outlines);
      }

      this.outlines = gl.createTexture() as WebGLTexture;
      this.state.bindTexture(OUTLINE_UNIT, this.outlines);
      this.state.activeTexture(OUTLINE_UNIT);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, OUTLINE_ROW, rows);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.outlineRows = rows;
      from = 0;
    }

    if (from < count) {
      const first = Math.floor(from / OUTLINE_ROW);
      const height = Math.ceil(count / OUTLINE_ROW) - first;
      this.state.bindTexture(OUTLINE_UNIT, this.outlines);
      this.state.activeTexture(OUTLINE_UNIT);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        first,
        OUTLINE_ROW,
        height,
        gl.RGBA,
        gl.FLOAT,
        data,
        first * OUTLINE_ROW * 4,
      );
    }

    this.outlineEpoch = epoch;
    this.outlineCount = count;
  }

  /** The textures removed since the last frame deleted, and those added or changed uploaded, their pixels let go. */
  uploadTextures(textures: Textures): void {
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
      // Floats, a kernel's image, make the texture again each time, as bytes may follow them.
      if (data.pixels instanceof Float32Array) {
        this.sizes[id * 2] = -1;
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          data.width,
          data.height,
          0,
          gl.RGBA,
          gl.FLOAT,
          data.pixels,
        );
        data.pixels = null;
        continue;
      }

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
  sampler(bits: number): WebGLSampler {
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
  uploadRows(rows: Rows): void {
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

  /** The textures made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.rowsTexture);
    if (this.outlines) {
      gl.deleteTexture(this.outlines);
    }

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
  }
}
