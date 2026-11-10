import type { GlState } from "@swf2es/context3d/device";
import type { Place } from "./atlas.js";
import { COLOR_AT, DRAW_AT, POSITION_AT, TEXEL_AT } from "./programs.js";

/** Atlas attributes followed by the packed row: transforms and snapping stay in the shader. */
const WORDS = 6;
/** Bound the extra CPU and GPU storage, falling back to the atlas after it fills. */
const VERTICES_MOST = 2 << 20;
const INDICES_MOST = 6 << 20;

/** Small stable geometries merged in painter's order; unchanged streams reuse their GPU buffers. */
export class FillBatches {
  vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  private vertices = new Uint32Array(0);
  private floats = new Float32Array(0);
  private indices = new Uint32Array(0);
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private vertexTop = 0;
  indexTop = 0;
  private readonly previous: NonNullable<Place["batch"]>[] = [];
  private readonly previousRows: number[] = [];
  private cursor = 0;
  /** Stays dirty if preparation aborts before upload, as an overflowing run table can do. */
  private changed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly state: GlState,
  ) {}

  setUp(): void {
    const gl = this.gl;
    this.vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.vertexBuffer = gl.createBuffer() as WebGLBuffer;
    this.indexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, WORDS * 4, 0);
    gl.enableVertexAttribArray(TEXEL_AT);
    gl.vertexAttribPointer(TEXEL_AT, 2, gl.FLOAT, false, WORDS * 4, 8);
    gl.enableVertexAttribArray(COLOR_AT);
    gl.vertexAttribPointer(COLOR_AT, 4, gl.UNSIGNED_BYTE, true, WORDS * 4, 16);
    gl.enableVertexAttribArray(DRAW_AT);
    gl.vertexAttribIPointer(DRAW_AT, 1, gl.INT, WORDS * 4, 20);
    // Disabled in the atlas VAO: a negative attribute selects the existing run-table path.
    gl.vertexAttribI4i(DRAW_AT, -1, 0, 0, 0);
    this.vertexCapacity = 0;
    this.indexCapacity = 0;
    this.previous.length = 0;
    this.previousRows.length = 0;
    this.reset();
  }

  reset(): void {
    this.vertexTop = 0;
    this.indexTop = 0;
    this.cursor = 0;
  }

  /** Append the whole run, or leave it to multi-draw if copying would cost too much. */
  add(places: Place[], rows: Int32Array, count: number, frame: number): void {
    if (count < 32) {
      return;
    }

    let vertices = this.vertexTop;
    let indices = this.indexTop;
    for (let i = 0; i < count; i++) {
      const place = places[i];
      if (!place.batch || place.batch.frame === frame) {
        return;
      }

      vertices += place.vertices;
      indices += place.indices;
    }

    if (vertices > VERTICES_MOST || indices > INDICES_MOST) {
      return;
    }

    if (vertices * WORDS > this.vertices.length) {
      const grown = new Uint32Array(
        Math.min(VERTICES_MOST * WORDS, Math.max(vertices * WORDS, this.vertices.length * 2)),
      );
      grown.set(this.vertices);
      this.vertices = grown;
      this.floats = new Float32Array(grown.buffer);
    }

    if (indices > this.indices.length) {
      const grown = new Uint32Array(
        Math.min(INDICES_MOST, Math.max(indices, this.indices.length * 2)),
      );
      grown.set(this.indices);
      this.indices = grown;
    }

    for (let i = 0; i < count; i++) {
      const place = places[i];
      const batch = place.batch as NonNullable<Place["batch"]>;
      // An unchanged prefix has the same offsets. After a mismatch, rebuild the rest in order.
      this.changed ||=
        this.previous[this.cursor] !== batch || this.previousRows[this.cursor] !== rows[i];
      this.previous[this.cursor] = batch;
      this.previousRows[this.cursor++] = rows[i];
      if (!this.changed) {
        this.vertexTop += place.vertices;
        this.indexTop += place.indices;
        continue;
      }

      const data = batch.data;
      const base = this.vertexTop;
      for (let j = 0; j < place.vertices; j++) {
        const at = (base + j) * WORDS;
        this.floats[at] = data.positions[j * 2];
        this.floats[at + 1] = data.positions[j * 2 + 1];
        this.floats[at + 2] = data.texels ? data.texels[j * 2] : 0;
        this.floats[at + 3] = data.texels ? data.texels[j * 2 + 1] : 0;
        this.vertices[at + 4] = data.colors[j];
        this.vertices[at + 5] = rows[i];
      }

      for (let j = 0; j < place.indices; j++) {
        this.indices[this.indexTop++] = base + data.indices[j];
      }

      this.vertexTop += place.vertices;
    }
  }

  upload(): void {
    this.previous.length = this.cursor;
    this.previousRows.length = this.cursor;
    if (this.indexTop === 0 || !this.changed) {
      return;
    }

    const gl = this.gl;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (this.vertexCapacity < this.vertices.length) {
      this.vertexCapacity = this.vertices.length;
      gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity * 4, gl.DYNAMIC_DRAW);
    }

    if (this.indexCapacity < this.indices.length) {
      this.indexCapacity = this.indices.length;
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity * 4, gl.DYNAMIC_DRAW);
    }

    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices, 0, this.vertexTop * WORDS);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.indices, 0, this.indexTop);
    this.changed = false;
  }

  destroy(): void {
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
  }
}
