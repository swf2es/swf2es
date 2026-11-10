import type { GlState } from "@swf2es/context3d/device";
import type { Place } from "./atlas.js";
import { COLOR_AT, DRAW_AT, POSITION_AT, TEXEL_AT } from "./programs.js";

/** Atlas attributes followed by the packed row: transforms and snapping stay in the shader. */
const WORDS = 6;
/** Bound the extra CPU and GPU storage, falling back to the atlas after it fills. */
const VERTICES_MOST = 2 << 20;
const INDICES_MOST = 6 << 20;
/** The least room the GPU buffers and the staging keep, which shrinking stops at. */
const VERTICES_LEAST = 1 << 14;
const INDICES_LEAST = 3 << 14;
/** Frames over which the most used is watched; room four times that is let go of after them. */
const SHRINK_FRAMES = 240;

/**
 * Small stable geometries merged in painter's order; unchanged streams reuse
 * their GPU buffers. Only what changed since the last frame, from the first
 * draw that differs to the stream's end, is staged on the CPU and uploaded
 * where it lies: the stream before it stays on the GPU alone, and a buffer
 * grown keeps it by a copy there.
 */
export class FillBatches {
  vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  /** The staged words, the same bytes as floats, and indices: the stream from fromVertex and fromIndex. */
  private words = new Uint32Array(0);
  private floats = new Float32Array(0);
  private indices = new Uint32Array(0);
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private vertexTop = 0;
  indexTop = 0;
  /** Where this frame's staging starts in the stream: the first draw that differs from the last frame's. */
  private fromVertex = 0;
  private fromIndex = 0;
  private readonly previous: NonNullable<Place["batch"]>[] = [];
  private readonly previousRows: number[] = [];
  private cursor = 0;
  /** Stays dirty if preparation aborts before upload, as an overflowing run table can do. */
  private changed = false;
  /** The frames of the current watch, and the most of the stream and of the staging they used. */
  private frames = 0;
  private mostVertices = 0;
  private mostIndices = 0;
  private mostStaged = 0;
  private mostStagedIndices = 0;

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
    this.changed = false;
    this.reset();
  }

  reset(): void {
    this.vertexTop = 0;
    this.indexTop = 0;
    this.cursor = 0;
    // A preparation that aborted left the whole stream to stage again.
    this.fromVertex = 0;
    this.fromIndex = 0;
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

    for (let i = 0; i < count; i++) {
      const place = places[i];
      const batch = place.batch as NonNullable<Place["batch"]>;
      // An unchanged prefix has the same offsets. After a mismatch, stage the rest in order.
      if (
        !this.changed &&
        (this.previous[this.cursor] !== batch || this.previousRows[this.cursor] !== rows[i])
      ) {
        this.changed = true;
        this.fromVertex = this.vertexTop;
        this.fromIndex = this.indexTop;
      }

      this.previous[this.cursor] = batch;
      this.previousRows[this.cursor++] = rows[i];
      if (!this.changed) {
        this.vertexTop += place.vertices;
        this.indexTop += place.indices;
        continue;
      }

      this.stageRoom(vertices - this.fromVertex, indices - this.fromIndex);
      const data = batch.data;
      const base = this.vertexTop;
      const floats = this.floats;
      const words = this.words;
      for (let j = 0; j < place.vertices; j++) {
        const at = (base - this.fromVertex + j) * WORDS;
        floats[at] = data.positions[j * 2];
        floats[at + 1] = data.positions[j * 2 + 1];
        floats[at + 2] = data.texels ? data.texels[j * 2] : 0;
        floats[at + 3] = data.texels ? data.texels[j * 2 + 1] : 0;
        words[at + 4] = data.colors[j];
        words[at + 5] = rows[i];
      }

      const staged = this.indices;
      let at = this.indexTop - this.fromIndex;
      for (let j = 0; j < place.indices; j++) {
        staged[at++] = base + data.indices[j];
      }

      this.vertexTop += place.vertices;
      this.indexTop += place.indices;
    }
  }

  /**
   * The staged part of the stream uploaded where it lies, the buffers grown
   * to fit it first, keeping what is before it; and, once a watch of
   * SHRINK_FRAMES has used a quarter of the room or less, the buffers and
   * the staging made smaller.
   */
  upload(): void {
    this.previous.length = this.cursor;
    this.previousRows.length = this.cursor;
    const staging = this.changed && this.indexTop > 0;
    if (staging) {
      this.uploadStaged();
    }

    this.watch(staging);
  }

  /** What add staged uploaded where it lies, the buffers grown first to fit the stream. */
  private uploadStaged(): void {
    const gl = this.gl;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (this.vertexTop > this.vertexCapacity) {
      this.vertexCapacity = Math.min(
        VERTICES_MOST,
        Math.max(this.vertexTop, this.vertexCapacity * 2),
      );
      this.resize(
        gl.ARRAY_BUFFER,
        this.vertexBuffer,
        this.vertexCapacity * WORDS * 4,
        this.fromVertex * WORDS * 4,
      );
    }

    if (this.indexTop > this.indexCapacity) {
      this.indexCapacity = Math.min(INDICES_MOST, Math.max(this.indexTop, this.indexCapacity * 2));
      this.resize(
        gl.ELEMENT_ARRAY_BUFFER,
        this.indexBuffer,
        this.indexCapacity * 4,
        this.fromIndex * 4,
      );
    }

    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      this.fromVertex * WORDS * 4,
      this.words,
      0,
      (this.vertexTop - this.fromVertex) * WORDS,
    );
    gl.bufferSubData(
      gl.ELEMENT_ARRAY_BUFFER,
      this.fromIndex * 4,
      this.indices,
      0,
      this.indexTop - this.fromIndex,
    );
    this.changed = false;
  }

  destroy(): void {
    this.gl.deleteVertexArray(this.vertexArray);
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.words = new Uint32Array(0);
    this.floats = new Float32Array(0);
    this.indices = new Uint32Array(0);
  }

  /** Staging for at least `vertices` and `indices` from its start, what is staged kept. */
  private stageRoom(vertices: number, indices: number): void {
    if (vertices * WORDS > this.words.length) {
      const grown = new Uint32Array(
        Math.min(VERTICES_MOST * WORDS, Math.max(vertices * WORDS, this.words.length * 2)),
      );
      grown.set(this.words);
      this.words = grown;
      this.floats = new Float32Array(grown.buffer);
    }

    if (indices > this.indices.length) {
      const grown = new Uint32Array(
        Math.min(INDICES_MOST, Math.max(indices, this.indices.length * 2)),
      );
      grown.set(this.indices);
      this.indices = grown;
    }
  }

  /**
   * A frame's use counted, after its upload; at a watch's end, room four
   * times what it used at most let go of: the GPU buffers keep the stream,
   * all of it there now, and the staging, whose bytes matter only between
   * add and upload, is made anew.
   */
  private watch(staging: boolean): void {
    this.mostVertices = Math.max(this.mostVertices, this.vertexTop);
    this.mostIndices = Math.max(this.mostIndices, this.indexTop);
    if (staging) {
      this.mostStaged = Math.max(this.mostStaged, this.vertexTop - this.fromVertex);
      this.mostStagedIndices = Math.max(this.mostStagedIndices, this.indexTop - this.fromIndex);
    }

    if (++this.frames < SHRINK_FRAMES) {
      return;
    }

    const gl = this.gl;
    // With nothing uploaded for a change, as for a stream of no draws, nothing on the GPU is kept.
    const kept = !this.changed;
    const keepVertices = kept ? this.vertexTop : 0;
    const keepIndices = kept ? this.indexTop : 0;
    const vertices = Math.max(VERTICES_LEAST, this.mostVertices * 2);
    if (this.mostVertices * 4 <= this.vertexCapacity && vertices < this.vertexCapacity) {
      this.state.bindVertexArray(this.vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      this.vertexCapacity = vertices;
      this.resize(
        gl.ARRAY_BUFFER,
        this.vertexBuffer,
        vertices * WORDS * 4,
        keepVertices * WORDS * 4,
      );
    }

    const indices = Math.max(INDICES_LEAST, this.mostIndices * 2);
    if (this.mostIndices * 4 <= this.indexCapacity && indices < this.indexCapacity) {
      this.state.bindVertexArray(this.vertexArray);
      this.indexCapacity = indices;
      this.resize(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer, indices * 4, keepIndices * 4);
    }

    const staged = Math.max(VERTICES_LEAST, this.mostStaged * 2) * WORDS;
    if (this.mostStaged * 4 * WORDS <= this.words.length && staged < this.words.length) {
      this.words = new Uint32Array(staged);
      this.floats = new Float32Array(this.words.buffer);
    }

    const stagedIndices = Math.max(INDICES_LEAST, this.mostStagedIndices * 2);
    if (this.mostStagedIndices * 4 <= this.indices.length && stagedIndices < this.indices.length) {
      this.indices = new Uint32Array(stagedIndices);
    }

    this.frames = 0;
    this.mostVertices = 0;
    this.mostIndices = 0;
    this.mostStaged = 0;
    this.mostStagedIndices = 0;
  }

  /**
   * `buffer`, bound to `target` (the index buffer through this VAO), made
   * `bytes` long, its first `keep` bytes kept by copies on the GPU, through
   * a buffer of their own, as a new store loses the old one's.
   */
  private resize(target: number, buffer: WebGLBuffer, bytes: number, keep: number): void {
    const gl = this.gl;
    if (keep <= 0) {
      gl.bufferData(target, bytes, gl.DYNAMIC_DRAW);
      return;
    }

    const copy = gl.createBuffer() as WebGLBuffer;
    if (target === gl.ELEMENT_ARRAY_BUFFER) {
      // WebGL copies only between buffers of one kind: the copy becomes an index buffer by a
      // binding as one, outside this VAO, whose own it would replace.
      this.state.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, copy);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      this.state.bindVertexArray(this.vertexArray);
    }

    gl.bindBuffer(gl.COPY_WRITE_BUFFER, copy);
    gl.bufferData(gl.COPY_WRITE_BUFFER, keep, gl.STREAM_COPY);
    gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, keep);
    gl.bufferData(target, bytes, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.COPY_READ_BUFFER, copy);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, target, 0, 0, keep);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    gl.deleteBuffer(copy);
  }
}
