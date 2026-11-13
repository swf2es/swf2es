import type { GlState } from "@swf2es/context3d/device";
import type { Place } from "./atlas.js";
import { COLOR_AT, DRAW_AT, MERGED_LINE, MERGED_UNIT, POSITION_AT, TEXEL_AT } from "./programs.js";

/**
 * Atlas attributes followed by where the draw's packed row is in the rows'
 * texture: transforms and snapping stay in the shader, and a row that
 * changes changes no vertex.
 */
const WORDS = 6;
/** Bound the extra CPU and GPU storage, falling back to the atlas after it fills. */
const VERTICES_MOST = 2 << 20;
const INDICES_MOST = 6 << 20;
/** The least room the GPU buffers and the staging keep, which shrinking stops at. */
const VERTICES_LEAST = 1 << 14;
const INDICES_LEAST = 3 << 14;
/** Frames over which the most used is watched; room four times that is let go of after them. */
const SHRINK_FRAMES = 240;

type Batch = NonNullable<Place["batch"]>;

/** A run's geometries copied in a row into the stream, where every run of the same geometries finds them. */
interface Segment {
  batches: Batch[];
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
  /** Where its draws' rows are in the rows' texture, one after another. */
  slot: number;
  /** The last frame a run used it (FillBatches.frame). */
  frame: number;
}

/**
 * Small geometries merged run by run in painter's order, each run's copy a
 * segment of one stream that any later run of the same geometries draws
 * again, wherever it comes in the frame: its rows are in a texture of its
 * own, written each frame, not in its vertices. Only the segments a frame adds are staged on the
 * CPU, after the stream's top, and uploaded there at once; what is below
 * stays on the GPU alone, and a buffer grown keeps it by a copy there.
 * Segments no run used in a frame are let go of, and their room once the
 * stream is twice what the last frame used, the stream then made anew.
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
  /** Where this frame's staging starts in the stream: its top as the frame began. */
  private fromVertex = 0;
  private fromIndex = 0;
  /**
   * The segments' rows, slot by slot (Segment.slot), as their texture holds
   * them, the slots taken, and the range of them this frame changed.
   */
  rowsTexture: WebGLTexture | null = null;
  private rows = new Int32Array(0);
  private rowsLines = 0;
  private slotTop = 0;
  private slotsMost = 0;
  private changedFrom = 0;
  private changedTo = 0;
  /** The segments by their first geometry. */
  private readonly segments = new Map<Batch, Segment[]>();
  private frame = 0;
  /** What the frame's runs used of the stream, each segment once. */
  private liveVertices = 0;
  private liveIndices = 0;
  /**
   * The keys of the runs this frame and the last asked for (add's
   * `settled`), so that a run is copied only once it is drawn again.
   */
  private seen = new Set<number>();
  private seenBefore = new Set<number>();
  /** A frame prepared but not uploaded, as an overflowing run table leaves one: its staging lost. */
  private pending = false;
  /** Whether a run found no room this frame, so that the next makes the stream anew. */
  private full = false;
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

  /** The buffers and the rows' texture made, `textureMost` lines at most, as the context comes. */
  setUp(textureMost: number): void {
    const gl = this.gl;
    this.rowsTexture = null;
    this.rowsLines = 0;
    this.rows = new Int32Array(0);
    this.slotsMost = MERGED_LINE * textureMost;
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
    this.clear();
  }

  /** No segment kept: the stream made anew from its start. */
  private clear(): void {
    this.segments.clear();
    this.vertexTop = 0;
    this.indexTop = 0;
    this.slotTop = 0;
    this.pending = false;
    this.full = false;
  }

  /** A frame's preparation begun: staging from the stream's top, or from its start once it is mostly dead. */
  reset(): void {
    if (this.pending) {
      // Rows written and not uploaded: the texture made again, so that the CPU's copy is its own.
      this.rowsLines = 0;
    }

    if (
      this.pending ||
      // Room let go of where a run found none, unless the last frame used all of the stream.
      (this.full && (this.vertexTop > this.liveVertices || this.indexTop > this.liveIndices)) ||
      (this.vertexTop > VERTICES_LEAST && this.vertexTop > this.liveVertices * 2) ||
      (this.indexTop > INDICES_LEAST && this.indexTop > this.liveIndices * 2)
    ) {
      this.clear();
    }

    this.full = false;
    const seen = this.seenBefore;
    this.seenBefore = this.seen;
    this.seen = seen;
    seen.clear();
    this.frame++;
    this.fromVertex = this.vertexTop;
    this.fromIndex = this.indexTop;
    this.liveVertices = 0;
    this.liveIndices = 0;
    this.changedFrom = this.slotTop;
    this.changedTo = 0;
    this.pending = true;
  }

  /**
   * The segment that draws the run, of at least `least` draws: one kept, or
   * one staged now; null leaves it to the atlas, where copying would cost
   * too much: a run short or of geometry added this `frame` is cheaper
   * drawn from it, and with `settled` a run not drawn the frame before
   * too, as a run that changes from frame to frame, as an animation's do,
   * would be copied again each frame. Its vertices carry each draw's place
   * in the run, which the run table's rows follow.
   */
  add(
    places: Place[],
    rows: Int32Array,
    count: number,
    frame: number,
    least: number,
    settled: boolean,
  ): { indexStart: number; indices: number } | null {
    if (count < least) {
      return null;
    }

    let vertices = 0;
    let indices = 0;
    // The run's geometries by where they lie in the atlas, which no two live geometries share.
    let key = count;
    for (let i = 0; i < count; i++) {
      const place = places[i];
      if (!place.batch || place.batch.frame === frame) {
        return null;
      }

      vertices += place.vertices;
      indices += place.indices;
      key = Math.imul(key ^ place.indexStart, 0x9e3779b1) ^ place.indices;
    }

    const first = places[0].batch as Batch;
    let list = this.segments.get(first);
    if (list) {
      for (const segment of list) {
        // A copy a run drew this frame already serves another only with the same rows.
        if (
          segment.batches.length === count &&
          this.holds(segment, places) &&
          (segment.frame !== this.frame || this.rowsAre(segment.slot, rows, count))
        ) {
          this.use(segment);
          this.writeRows(segment.slot, rows, count);
          return segment;
        }
      }
    }

    // A key alike by chance merges a run a frame early, which costs a copy and draws the same.
    this.seen.add(key);
    if (settled && !this.seenBefore.has(key)) {
      return null;
    }

    if (
      this.vertexTop + vertices > VERTICES_MOST ||
      this.indexTop + indices > INDICES_MOST ||
      this.slotTop + count > this.slotsMost
    ) {
      this.full = true;
      return null;
    }

    const segment: Segment = {
      batches: new Array<Batch>(count),
      vertexStart: this.vertexTop,
      vertices,
      indexStart: this.indexTop,
      indices,
      slot: this.slotTop,
      frame: -1,
    };
    this.slotTop += count;
    this.stageRoom(
      this.vertexTop + vertices - this.fromVertex,
      this.indexTop + indices - this.fromIndex,
    );
    const floats = this.floats;
    const words = this.words;
    const staged = this.indices;
    for (let i = 0; i < count; i++) {
      const place = places[i];
      const batch = place.batch as Batch;
      segment.batches[i] = batch;
      const data = batch.data;
      const base = this.vertexTop;
      for (let j = 0; j < place.vertices; j++) {
        const at = (base - this.fromVertex + j) * WORDS;
        floats[at] = data.positions[j * 2];
        floats[at + 1] = data.positions[j * 2 + 1];
        floats[at + 2] = data.texels ? data.texels[j * 2] : 0;
        floats[at + 3] = data.texels ? data.texels[j * 2 + 1] : 0;
        words[at + 4] = data.colors[j];
        words[at + 5] = segment.slot + i;
      }

      let at = this.indexTop - this.fromIndex;
      for (let j = 0; j < place.indices; j++) {
        staged[at++] = base + data.indices[j];
      }

      this.vertexTop += place.vertices;
      this.indexTop += place.indices;
    }

    if (!list) {
      list = [];
      this.segments.set(first, list);
    }

    list.push(segment);
    this.use(segment);
    this.writeRows(segment.slot, rows, count);
    return segment;
  }

  /** Whether the `count` rows from `slot` are `rows`. */
  private rowsAre(slot: number, rows: Int32Array, count: number): boolean {
    for (let i = 0; i < count; i++) {
      if (this.rows[slot + i] !== rows[i]) {
        return false;
      }
    }

    return true;
  }

  /** `rows` written from `slot` on, what changes counted for the upload. */
  private writeRows(slot: number, rows: Int32Array, count: number): void {
    if (slot + count > this.rows.length) {
      const lines = Math.ceil(Math.max(slot + count, this.rows.length * 2) / MERGED_LINE);
      const grown = new Int32Array(lines * MERGED_LINE);
      grown.set(this.rows);
      this.rows = grown;
    }

    const held = this.rows;
    for (let i = 0; i < count; i++) {
      if (held[slot + i] !== rows[i]) {
        held[slot + i] = rows[i];
        this.changedFrom = Math.min(this.changedFrom, slot + i);
        this.changedTo = Math.max(this.changedTo, slot + i + 1);
      }
    }
  }

  /** The rows' texture made tall enough for the slots taken, and the lines this frame changed uploaded. */
  private uploadRows(): void {
    const gl = this.gl;
    const lines = Math.ceil(this.slotTop / MERGED_LINE);
    if (lines > this.rowsLines) {
      if (this.rowsTexture) {
        this.state.dropTexture(this.rowsTexture);
        gl.deleteTexture(this.rowsTexture);
      }

      // A new texture holds zeros: the rows taken uploaded again, the CPU's past them zeros too.
      this.rows.fill(0, this.slotTop);
      this.rowsLines = Math.min(this.slotsMost / MERGED_LINE, Math.max(lines, this.rowsLines * 2));
      this.rowsTexture = gl.createTexture();
      this.state.bindTexture(MERGED_UNIT, this.rowsTexture);
      this.state.activeTexture(MERGED_UNIT);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32I, MERGED_LINE, this.rowsLines);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.changedFrom = 0;
      this.changedTo = this.slotTop;
    }

    if (this.changedTo <= this.changedFrom) {
      return;
    }

    const from = Math.floor(this.changedFrom / MERGED_LINE);
    const to = Math.ceil(this.changedTo / MERGED_LINE);
    this.state.bindTexture(MERGED_UNIT, this.rowsTexture);
    this.state.activeTexture(MERGED_UNIT);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      from,
      MERGED_LINE,
      to - from,
      gl.RED_INTEGER,
      gl.INT,
      this.rows,
      from * MERGED_LINE,
    );
  }

  /** Whether `segment` is of the geometries of `places`, in their order. */
  private holds(segment: Segment, places: Place[]): boolean {
    const batches = segment.batches;
    for (let i = 0; i < batches.length; i++) {
      if (batches[i] !== places[i].batch) {
        return false;
      }
    }

    return true;
  }

  /** `segment` used this frame, counted once among what the frame used. */
  private use(segment: Segment): void {
    if (segment.frame !== this.frame) {
      segment.frame = this.frame;
      this.liveVertices += segment.vertices;
      this.liveIndices += segment.indices;
    }
  }

  /**
   * The staged segments uploaded where they lie, the buffers grown to fit
   * them first, keeping what is below; the segments no run used let go of;
   * and, once a watch of SHRINK_FRAMES has used a quarter of the room or
   * less, the buffers and the staging made smaller.
   */
  upload(): void {
    const staging = this.vertexTop > this.fromVertex;
    if (staging) {
      this.uploadStaged();
    }

    if (this.slotTop > 0) {
      this.uploadRows();
    }

    for (const [first, list] of this.segments) {
      let kept = 0;
      for (const segment of list) {
        if (segment.frame === this.frame) {
          list[kept++] = segment;
        }
      }

      if (kept === 0) {
        this.segments.delete(first);
      } else {
        list.length = kept;
      }
    }

    this.pending = false;
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
  }

  destroy(): void {
    if (this.rowsTexture) {
      this.state.dropTexture(this.rowsTexture);
      this.gl.deleteTexture(this.rowsTexture);
      this.rowsTexture = null;
    }

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
    const keepVertices = this.vertexTop;
    const keepIndices = this.indexTop;
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
