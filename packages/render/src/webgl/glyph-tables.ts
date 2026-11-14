import type { GlState } from "@swf2es/context3d/device";
import { TABLE_ENTRIES, TABLE_LINE, TABLE_SLOT, TABLE_UNIT } from "./programs.js";

/** Floats a slot: its texels' four each. */
const SLOT_FLOATS = TABLE_SLOT * 4;
/** Slots a line of the texture. */
const SLOTS_A_LINE = TABLE_LINE / TABLE_SLOT;
/** Floats a text's mode and table take of a slot, compared and hashed. */
const USED_FLOATS = 4 + TABLE_ENTRIES * 4;

/**
 * Advanced text's modes and CSM cutoff tables (GeometryData.glyphs), each
 * distinct one in a slot of a float texture the glyph program reads by
 * texelFetch: the mode in a slot's first texel, its table's entries after
 * it. They were a uniform array the shader indexed by each glyph's table
 * start, the access that hung Intel's GPUs in the fill program's run table
 * (#717), and uploaded whole for every text drawn. Texts alike share a slot; slots are only
 * added, between the glyph atlas' repacks, which take them all afresh
 * (reset), or once the texture is as large as it may be (full). Slot 0 is
 * left for a text past the room (scratch), uploaded as it is drawn.
 */
export class GlyphTables {
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  texture: WebGLTexture | null = null;
  /** The slots' floats as uploaded and to upload, and the texture's lines. */
  private data = new Float32Array(SLOT_FLOATS * SLOTS_A_LINE);
  private words = new Uint32Array(this.data.buffer);
  private lines = 0;
  private lineMost = 1;
  /** Slots taken, the first not yet uploaded, and whether the texture's lines are all taken. */
  private count = 1;
  private uploaded = 1;
  full = false;
  /** The first slot by its contents' hash, then the next of that hash, -1 for none. */
  private readonly byHash = new Map<number, number>();
  private next = new Int32Array(SLOTS_A_LINE);

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
  }

  /** No texture yet, nor slots, as the context comes or comes back. */
  setUp(): void {
    this.texture = null;
    this.lines = 0;
    this.lineMost = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    this.reset();
  }

  /** Every slot but the scratch let go of, for the texts to take theirs again. */
  reset(): void {
    this.count = 1;
    this.uploaded = 1;
    this.full = false;
    this.byHash.clear();
  }

  /** The slot holding `mode` and `table`, taken if none does; -1 where the room is full. */
  slot(mode: Float32Array, table: Float32Array): number {
    let hash = 0x811c9dc5;
    const modeWords = new Uint32Array(mode.buffer, mode.byteOffset, 4);
    const tableWords = new Uint32Array(table.buffer, table.byteOffset, TABLE_ENTRIES * 4);
    for (let i = 0; i < 4; i++) {
      hash = Math.imul(hash ^ modeWords[i], 0x01000193);
    }

    for (let i = 0; i < tableWords.length; i++) {
      hash = Math.imul(hash ^ tableWords[i], 0x01000193);
    }

    const words = this.words;
    let s = this.byHash.get(hash) ?? -1;
    for (; s >= 0; s = this.next[s]) {
      const at = s * SLOT_FLOATS;
      let k = 0;
      while (k < 4 && words[at + k] === modeWords[k]) {
        k++;
      }

      while (k < USED_FLOATS && words[at + k] === tableWords[k - 4]) {
        k++;
      }

      if (k === USED_FLOATS) {
        return s;
      }
    }

    if (this.count >= this.lineMost * SLOTS_A_LINE) {
      this.full = true;
      return -1;
    }

    s = this.count++;
    if (this.count * SLOT_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.words = new Uint32Array(grown.buffer);
      const next = new Int32Array(this.next.length * 2);
      next.set(this.next);
      this.next = next;
    }

    this.write(s, mode, table);
    this.next[s] = this.byHash.get(hash) ?? -1;
    this.byHash.set(hash, s);
    return s;
  }

  /** The slots taken since uploaded: into a texture grown to hold them, all of them if grown. */
  upload(): void {
    const gl = this.gl;
    if (this.uploaded === this.count || gl.isContextLost()) {
      return;
    }

    const lines = Math.ceil(this.count / SLOTS_A_LINE);
    let from = Math.floor(this.uploaded / SLOTS_A_LINE);
    if (!this.texture || lines > this.lines) {
      if (this.texture) {
        this.state.dropTexture(this.texture);
        gl.deleteTexture(this.texture);
      }

      this.lines = Math.min(this.lineMost, Math.max(lines, this.lines * 2));
      this.texture = gl.createTexture() as WebGLTexture;
      this.state.bindTexture(TABLE_UNIT, this.texture);
      this.state.activeTexture(TABLE_UNIT);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, TABLE_LINE, this.lines);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      from = 0;
    }

    this.state.bindTexture(TABLE_UNIT, this.texture);
    this.state.activeTexture(TABLE_UNIT);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      from,
      TABLE_LINE,
      lines - from,
      gl.RGBA,
      gl.FLOAT,
      this.data,
      from * TABLE_LINE * 4,
    );
    this.uploaded = this.count;
  }

  /** The scratch slot made to hold `mode` and `table` now, for a text drawn next past the room. */
  scratch(mode: Float32Array, table: Float32Array): number {
    this.write(0, mode, table);
    const gl = this.gl;
    this.state.bindTexture(TABLE_UNIT, this.texture);
    this.state.activeTexture(TABLE_UNIT);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TABLE_SLOT, 1, gl.RGBA, gl.FLOAT, this.data, 0);
    return 0;
  }

  private write(s: number, mode: Float32Array, table: Float32Array): void {
    const at = s * SLOT_FLOATS;
    this.data.set(mode.subarray(0, 4), at);
    this.data.set(table.subarray(0, TABLE_ENTRIES * 4), at + 4);
  }

  /** The texture made on the context, deleted. */
  destroy(): void {
    if (this.texture) {
      this.state.dropTexture(this.texture);
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
  }
}
