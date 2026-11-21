import type { GlState } from "@swf2es/context3d/device";
import {
  type Geometries,
  type GeometryData,
  GLYPH_FLOATS,
  RELEASE_FRAMES,
  samplesStage,
} from "../geometry.js";
import { FreeRanges } from "./free-ranges.js";
import { GlyphTables } from "./glyph-tables.js";
import {
  COLOR_AT,
  DEPTH_AT,
  GLYPH_AT,
  ORIGIN_AT,
  POSITION_AT,
  RUN_AT,
  TEXEL_AT,
  TINT_AT,
} from "./programs.js";

/**
 * Bytes a vertex in the atlas: its position's two floats, its texel's two, then its colour's four
 * bytes, or a mesh's depth's float.
 */
export const VERTEX_BYTES = 20;
/** Bytes a vertex of advanced text's glyph quads, in an atlas of their own. */
const GLYPH_BYTES = GLYPH_FLOATS * 4;
/** The fewest glyph vertices the glyph atlas holds once a text needs it. */
const GLYPHS_LEAST = 1024;
/** The fewest vertices the atlas holds room for, and its indices thrice that. */
const LEAST = 1 << 16;
/**
 * The vertices, and the indices, staged before an upload: geometries placed
 * one after another go to the GPU in one call for each buffer, not two a
 * geometry, which shapes drawn anew each frame paid for some thousand times
 * a frame. A geometry larger than the staging is uploaded from its own copy.
 */
const STAGED_VERTICES = 1 << 14;
const STAGED_INDICES = 1 << 16;

/**
 * `data`'s `count` vertices interleaved into `floats` from float `at`, `words` the same bytes:
 * a position, a texel or zeros, then the colour's bytes or a mesh's depth.
 */
function interleave(
  data: GeometryData,
  count: number,
  floats: Float32Array,
  words: Uint32Array,
  at: number,
): void {
  const positions = data.positions;
  const texels = data.texels;
  const depths = data.depths;
  const colors = data.colors;
  for (let i = 0; i < count; i++, at += 5) {
    floats[at] = positions[i * 2];
    floats[at + 1] = positions[i * 2 + 1];
    if (texels) {
      floats[at + 2] = texels[i * 2];
      floats[at + 3] = texels[i * 2 + 1];
    } else {
      floats[at + 2] = 0;
      floats[at + 3] = 0;
    }

    if (depths) {
      floats[at + 4] = depths[i];
    } else {
      words[at + 4] = colors[i];
    }
  }
}

/**
 * A vertex and an index buffer of the atlas, its vertex array reading
 * them, the room of each and the vertices live in it.
 */
export interface Page {
  /** Its index in the atlas' pages, which places name it by. */
  index: number;
  vertexArray: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  vertices: FreeRanges;
  indices: FreeRanges;
  live: number;
}

const NO_INDICES = new Uint16Array(0);

/**
 * Atlas frames a geometry small enough to merge (Place.batch) goes unstaged by a run's stream
 * before its arrays are let go of: a still scene's runs are staged once and drawn from their
 * copies after, a moving one's staged anew every frame or few.
 */
export const STREAM_QUIET_FRAMES = 300;

/**
 * `source`, indices into `count` vertices, copied into an array of their own: in 16 bits where
 * they fit, and in a buffer of their own, not the geometry's, which is let go of.
 */
function localIndices(source: Uint16Array | Uint32Array, count: number): Uint16Array | Uint32Array {
  const local = count <= 1 << 16 ? new Uint16Array(source.length) : new Uint32Array(source.length);
  local.set(source);
  return local;
}

/**
 * Where a geometry lies in the atlas, its page and its ranges there, or in
 * the glyph atlas with its text's mode and table, and their slot in the
 * glyph tables (-1 past their room).
 */
export interface Place {
  page: number;
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
  glyphs: { mode: Float32Array; table: Float32Array; slot: number } | null;
  /** Its geometry's flat (GeometryData.flat). */
  flat: boolean;
  /** Whether it samples the stage's pixel (samplesStage), which the stage fill program draws. */
  stage: boolean;
  /**
   * Small, unchanged geometries may be copied into a run's streaming buffer: their vertices from
   * `data` where it is held, else from the page, on the GPU, and their indices from `local`. The
   * frame it was placed on.
   */
  batch: { frame: number } | null;
  /**
   * Its geometry's arrays while the registry holds them, for a run's stream to stage on the CPU:
   * null once let go of (Geometries.release).
   */
  data: GeometryData | null;
  /** Its geometry's id, which the stream names in `GeometryAtlas.wanted`. */
  id: number;
  /**
   * The atlas' frame in which a run's stream last staged it (FillBatches.add), and the one in
   * which its arrays were let go of. One staged within STREAM_QUIET_FRAMES is in runs made anew,
   * as moving content's are, frame after frame: it keeps its arrays (settle), as copying each such
   * geometry from the page on the GPU, thousands of small copies a frame, took ANGLE longer than
   * staging them all on the CPU. One staged twice so after its arrays went is wanted again
   * (GeometryAtlas.wanted): rebuilt, with its arrays, it then keeps them while it is staged.
   */
  stagedIn: number;
  releasedIn: number;
  /**
   * Its indices counted from its first vertex: what moving it in the atlas (repack) or copying it
   * into a run's stream needs, as WebGL copies an index buffer only as it is. Its geometry's own
   * till it has stood RELEASE_FRAMES, then a copy of its own, in 16 bits where its vertices fit,
   * as its arrays are let go of (Geometries.release).
   */
  local: Uint16Array | Uint32Array;
}

/**
 * The geometry atlas: every geometry copied once into a page's vertex and
 * index buffers, and advanced text's glyph quads into an atlas of their
 * own, where the draws find them by their places. Only a geometry's indices
 * stay on the CPU once copied (Place.local), counted from its first vertex,
 * and its registry lets go of its arrays (Geometries.release). A geometry
 * let go of leaves holes in its page, which later geometries are placed in
 * once the top is full; a page is packed again only when what is added
 * finds no room, its vertices moved on the GPU and its indices written
 * again from its own. Repacking every geometry for its holes alone made
 * frames that copied and uploaded the whole atlas again, tens of
 * megabytes, every few seconds of a busy SWF. The glyph atlas is packed
 * again once its holes outweigh what is live, which also frees the texts'
 * tables' slots.
 */
export class GeometryAtlas {
  frame = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  /** The pages, one for now, which places name by index. */
  pages: Page[] = [];
  /** The page the staging is for. */
  private stagedPage: Page | null = null;
  /** Vertices staged for `stagedPage` from vertex `stagedVertexAt`, as floats and as words. */
  private readonly stagedFloats = new Float32Array(STAGED_VERTICES * (VERTEX_BYTES / 4));
  private readonly stagedWords = new Uint32Array(this.stagedFloats.buffer);
  private stagedVertexAt = 0;
  private stagedVertices = 0;
  /** Indices staged for `stagedPage` from index `stagedIndexAt`. */
  private readonly stagedIndices = new Uint32Array(STAGED_INDICES);
  private stagedIndexAt = 0;
  private stagedIndexCount = 0;
  places: (Place | null)[] = [];
  glyphArray!: WebGLVertexArrayObject;
  private glyphBuffer!: WebGLBuffer;
  private glyphIndexBuffer!: WebGLBuffer;
  /** The glyph atlas' room and top, of vertices and of indices, and its vertices live and let go of. */
  private readonly glyphs = {
    capacity: 0,
    top: 0,
    indexCapacity: 0,
    indexTop: 0,
    live: 0,
    holes: 0,
  };
  /** The texts' modes and tables, which the glyph program reads. */
  readonly tables: GlyphTables;
  /**
   * The geometries a run's stream staged twice within STREAM_QUIET_FRAMES after their arrays were
   * let go of, for the registry to rebuild before the next walk (Geometries.want).
   */
  wanted: number[] = [];
  /** The ids counted among a frame's additions, each once (place). */
  private readonly counted = new Set<number>();
  /**
   * The places made, with their ids and frames, whose geometries' arrays are let go of once they
   * have stood RELEASE_FRAMES of their registry's (settle), oldest first.
   */
  private settling: Place[] = [];
  private settlingIds: number[] = [];
  private settlingFrames: number[] = [];

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
    this.tables = new GlyphTables(gl, state);
  }

  /** The buffers and vertex arrays made, both atlases empty, as the context comes or comes back. */
  setUp(): void {
    const gl = this.gl;
    this.pages = [this.makePage(0)];
    this.glyphArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.glyphBuffer = gl.createBuffer() as WebGLBuffer;
    this.glyphIndexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.glyphIndexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, GLYPH_BYTES, 0);
    for (const [at, offset] of [
      [ORIGIN_AT, 8],
      [GLYPH_AT, 24],
      [RUN_AT, 40],
      [TINT_AT, 56],
    ]) {
      gl.enableVertexAttribArray(at);
      gl.vertexAttribPointer(at, 4, gl.FLOAT, false, GLYPH_BYTES, offset);
    }

    Object.assign(this.glyphs, {
      capacity: 0,
      top: 0,
      indexCapacity: 0,
      indexTop: 0,
      live: 0,
      holes: 0,
    });
    this.stagedPage = null;
    this.stagedVertices = 0;
    this.stagedIndexCount = 0;
    this.places = [];
    this.settling = [];
    this.settlingIds = [];
    this.settlingFrames = [];
    this.tables.setUp();
  }

  /** A page's buffers and vertex array made, with no room till it is packed. */
  private makePage(index: number): Page {
    const gl = this.gl;
    const page: Page = {
      index,
      vertexArray: gl.createVertexArray() as WebGLVertexArrayObject,
      vertexBuffer: gl.createBuffer() as WebGLBuffer,
      indexBuffer: gl.createBuffer() as WebGLBuffer,
      vertices: new FreeRanges(),
      indices: new FreeRanges(),
      live: 0,
    };
    this.state.bindVertexArray(page.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, page.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.indexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(TEXEL_AT);
    gl.vertexAttribPointer(TEXEL_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(COLOR_AT);
    gl.vertexAttribPointer(COLOR_AT, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 16);
    // The same bytes as a mesh's depth, which the mesh program reads in place of the colour.
    gl.enableVertexAttribArray(DEPTH_AT);
    gl.vertexAttribPointer(DEPTH_AT, 1, gl.FLOAT, false, VERTEX_BYTES, 16);
    return page;
  }

  /** Geometry `id`'s place, if it has one, let go of: a shape's ranges free in its page. */
  private letGo(id: number): void {
    const place = this.places[id];
    if (!place) {
      return;
    }

    this.places[id] = null;
    // Its geometry's own, where it has not settled: a settling entry would keep them alive.
    place.local = NO_INDICES;
    place.data = null;
    if (place.glyphs) {
      this.glyphs.live -= place.vertices;
      this.glyphs.holes += place.vertices;
    } else {
      const page = this.pages[place.page];
      page.vertices.give(place.vertexStart, place.vertices);
      page.indices.give(place.indexStart, place.indices);
      page.live -= place.vertices;
    }
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in, their arrays then let go of by the registry: the shapes
   * together at their page's top or in a hole that holds them all, else
   * each in the first hole that holds it, else into a page packed again
   * with room for twice what is live; a text at the glyph atlas' top, else
   * into one packed again.
   */
  place(geometries: Geometries): void {
    this.frame++;
    for (let i = 0; i < this.wanted.length; i++) {
      geometries.want(this.wanted[i]);
    }

    this.wanted.length = 0;
    for (const id of geometries.removed) {
      this.letGo(id);
    }

    geometries.removed.length = 0;
    // Nothing left in it: filled again from its start, in the buffers it has.
    for (const page of this.pages) {
      if (page.live === 0) {
        page.vertices.reset(page.vertices.capacity);
        page.indices.reset(page.indices.capacity);
      }
    }

    // Changed in place, which only a geometry added to be kept is: copied again where they lie,
    // else as added.
    for (const id of geometries.updated) {
      const place = this.places[id];
      const data = geometries.get(id);
      if (place && data && !data.glyphs && place.vertices === data.positions.length / 2) {
        this.copyVertices(this.pages[place.page], data, place.vertexStart);
        place.stage = samplesStage(data);
        place.batch = this.batch(data);
        place.data = data;
      } else if (place && data) {
        this.letGo(id);
        geometries.added.push(id);
      }
    }

    geometries.updated.length = 0;
    // Found flat: what is added after reads it from its registry.
    for (const id of geometries.flattened) {
      const place = this.places[id];
      if (place) {
        place.flat = geometries.flat(id);
      }
    }

    geometries.flattened.length = 0;
    // An id let go of and taken again in a frame comes twice, its arrays the second's: counted
    // once, and copied once, as its arrays are let go of once copied.
    const counted = this.counted;
    counted.clear();
    let vertices = 0;
    let indices = 0;
    let glyphVertices = 0;
    let glyphIndices = 0;
    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (!data || counted.has(id)) {
        continue;
      }

      counted.add(id);
      if (data.glyphs) {
        glyphVertices += data.glyphs.vertices.length / GLYPH_FLOATS;
        glyphIndices += data.indices.length;
      } else {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    // Each atlas packed again on its own, so that texts' quads made again often never repack
    // the shapes', nor shapes the texts'. The shapes' page only when what is added outweighs its
    // room, or below, when holes too small for one of them leave it none.
    const g = this.glyphs;
    const page = this.pages[0];
    if (vertices > page.vertices.room() || indices > page.indices.room()) {
      this.repack(vertices, indices);
    }

    if (
      g.top + glyphVertices > g.capacity ||
      g.indexTop + glyphIndices > g.indexCapacity ||
      (g.holes > GLYPHS_LEAST && g.holes > g.live) ||
      this.tables.full
    ) {
      this.repackGlyphs(glyphVertices, glyphIndices);
    }

    // The shapes added together in one range where one holds them all, at the top or in a
    // hole, so that they go up in one upload each for vertices and indices; else each in the
    // first that holds it, which a churning atlas would leave to a call or two a geometry.
    let vertexAt = -1;
    let indexAt = -1;
    if (vertices > 0) {
      vertexAt = page.vertices.take(vertices);
      indexAt = vertexAt < 0 ? -1 : page.indices.take(indices);
      if (vertexAt >= 0 && indexAt < 0) {
        page.vertices.give(vertexAt, vertices);
        vertexAt = -1;
      }
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (!data || !counted.delete(id)) {
        continue;
      }

      // Added again after it was placed, as a geometry kept and changed can be, or after a lost
      // context: its first copy's room given back, which only packing would otherwise find again.
      this.letGo(id);
      if (data.glyphs) {
        this.copyGlyphs(id, data);
      } else if (vertexAt >= 0) {
        this.copyAt(page, id, data, vertexAt, indexAt);
        vertexAt += data.positions.length / 2;
        indexAt += data.indices.length;
      } else if (!this.copyIn(page, id, data)) {
        // Packed with room for this one and those after it, which it then holds.
        this.repack(vertices, indices);
        this.copyIn(page, id, data);
      }

      if (!data.glyphs) {
        vertices -= data.positions.length / 2;
        indices -= data.indices.length;
      }

      this.settling.push(this.places[id] as Place);
      this.settlingIds.push(id);
      this.settlingFrames.push(geometries.frame);
    }

    geometries.added.length = 0;
    this.flush();
    this.tables.upload();
    this.settle(geometries);
  }

  /**
   * The geometries placed RELEASE_FRAMES of their registry's ago or more, by its frames, not the
   * atlas', which a BitmapData's draws advance too, and placed still: their indices copied into
   * arrays of their own and their arrays let go of (Geometries.release), only while the context
   * is not known to be lost: copies made into a lost one are no copies, and the arrays stay for
   * the restore. In Chrome's window before it flags a loss (webgl/losses.ts), arrays may go
   * after copies that never reached the GPU; the restore's Geometries.lost rebuilds them.
   */
  private settle(geometries: Geometries): void {
    const places = this.settling;
    const ids = this.settlingIds;
    const frames = this.settlingFrames;
    let k = 0;
    while (k < places.length && geometries.frame - frames[k] >= RELEASE_FRAMES) {
      k++;
    }

    if (k === 0 || this.gl.isContextLost()) {
      return;
    }

    // Those a run's stream staged lately waited on again, behind the rest.
    const waiting: number[] = [];
    for (let i = 0; i < k; i++) {
      const place = places[i];
      if (this.places[ids[i]] !== place || !geometries.get(ids[i])) {
        continue;
      }

      if (place.batch && this.frame - place.stagedIn < STREAM_QUIET_FRAMES) {
        waiting.push(i);
        continue;
      }

      place.local = localIndices(place.local, place.vertices);
      place.data = null;
      place.releasedIn = this.frame;
      geometries.release(ids[i]);
    }

    for (const i of waiting) {
      places.push(places[i]);
      ids.push(ids[i]);
      frames.push(geometries.frame);
    }

    places.splice(0, k);
    ids.splice(0, k);
    frames.splice(0, k);
  }

  /**
   * The shapes' page packed again, with room for twice its live shapes and
   * `vertices` and `indices` more: its shapes moved in a row from its start,
   * their vertices copied on the GPU, through a buffer of their own, as a
   * new store loses the old one's, and their indices written again from
   * their own (Place.local). Their places are moved, not made anew, so that a run's
   * stream still finds them (Place.batch).
   */
  private repack(vertices: number, indices: number): void {
    const gl = this.gl;
    const page = this.pages[0];
    const moved: Place[] = [];
    let used = 0;
    for (const place of this.places) {
      if (place && !place.glyphs) {
        moved.push(place);
        vertices += place.vertices;
        indices += place.indices;
        used = Math.max(used, place.vertexStart + place.vertices);
      }
    }

    // In their order in the page, so that shapes placed together move in one copy.
    moved.sort((a, b) => a.vertexStart - b.vertexStart);
    // What is staged goes up first, for the copy to hold it.
    this.flush();
    this.state.bindVertexArray(page.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, page.vertexBuffer);
    const copy = used > 0 ? this.copyOf(used * VERTEX_BYTES) : null;
    page.vertices.reset(Math.max(LEAST, vertices * 2));
    page.indices.reset(Math.max(LEAST * 3, indices * 2));
    page.live = 0;
    gl.bufferData(gl.ARRAY_BUFFER, page.vertices.capacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, page.indices.capacity * 4, gl.STATIC_DRAW);
    let from = 0;
    let to = 0;
    let run = 0;
    for (const place of moved) {
      const base = page.vertices.take(place.vertices);
      const indexStart = page.indices.take(place.indices);
      if (run > 0 && place.vertexStart === from + run && base === to + run) {
        run += place.vertices;
      } else {
        this.copyRun(from, to, run, VERTEX_BYTES);
        from = place.vertexStart;
        to = base;
        run = place.vertices;
      }

      this.writeIndices(page, place.local, base, indexStart);
      place.vertexStart = base;
      place.indexStart = indexStart;
      page.live += place.vertices;
    }

    this.copyRun(from, to, run, VERTEX_BYTES);
    this.dropCopy(copy);
    this.flush();
  }

  /**
   * A copy on the GPU of the first `bytes` of the buffer bound to ARRAY_BUFFER, bound to
   * COPY_READ_BUFFER, for copyRun to read from once the buffer is made anew.
   */
  private copyOf(bytes: number): WebGLBuffer {
    const gl = this.gl;
    const copy = gl.createBuffer() as WebGLBuffer;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, copy);
    gl.bufferData(gl.COPY_WRITE_BUFFER, bytes, gl.STREAM_COPY);
    gl.copyBufferSubData(gl.ARRAY_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, bytes);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    gl.bindBuffer(gl.COPY_READ_BUFFER, copy);
    return copy;
  }

  /** `count` vertices of `bytes` each copied from vertex `from` of the copy (copyOf) to vertex `to` of ARRAY_BUFFER's. */
  private copyRun(from: number, to: number, count: number, bytes: number): void {
    if (count > 0) {
      this.gl.copyBufferSubData(
        this.gl.COPY_READ_BUFFER,
        this.gl.ARRAY_BUFFER,
        from * bytes,
        to * bytes,
        count * bytes,
      );
    }
  }

  private dropCopy(copy: WebGLBuffer | null): void {
    if (copy) {
      this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, null);
      this.gl.deleteBuffer(copy);
    }
  }

  /**
   * The glyph atlas packed again, with room for twice its live texts' quads
   * and `vertices` and `indices` more, none till a text needs them: its
   * texts moved in a row from its start as the shapes' are (repack), and
   * their tables given slots again, only the live texts' kept.
   */
  private repackGlyphs(vertices: number, indices: number): void {
    const gl = this.gl;
    const g = this.glyphs;
    const moved: Place[] = [];
    for (const place of this.places) {
      if (place?.glyphs) {
        moved.push(place);
        vertices += place.vertices;
        indices += place.indices;
      }
    }

    moved.sort((a, b) => a.vertexStart - b.vertexStart);
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    const copy = moved.length > 0 && g.top > 0 ? this.copyOf(g.top * GLYPH_BYTES) : null;
    g.capacity = vertices > 0 ? Math.max(GLYPHS_LEAST, vertices * 2) : 0;
    g.indexCapacity = vertices > 0 ? Math.max(GLYPHS_LEAST * 2, indices * 2) : 0;
    gl.bufferData(gl.ARRAY_BUFFER, g.capacity * GLYPH_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indexCapacity * 4, gl.STATIC_DRAW);
    g.top = 0;
    g.indexTop = 0;
    g.live = 0;
    g.holes = 0;
    // Only the live texts' tables kept.
    this.tables.reset();
    let from = 0;
    let to = 0;
    let run = 0;
    let written = 0;
    for (const place of moved) {
      written += place.indices;
    }

    const absolute = new Uint32Array(written);
    for (const place of moved) {
      if (run > 0 && place.vertexStart === from + run && g.top === to + run) {
        run += place.vertices;
      } else {
        this.copyRun(from, to, run, GLYPH_BYTES);
        from = place.vertexStart;
        to = g.top;
        run = place.vertices;
      }

      const local = place.local;
      for (let i = 0; i < local.length; i++) {
        absolute[g.indexTop + i] = local[i] + g.top;
      }

      const glyphs = place.glyphs as NonNullable<Place["glyphs"]>;
      glyphs.slot = this.tables.slot(glyphs.mode, glyphs.table);
      place.vertexStart = g.top;
      place.indexStart = g.indexTop;
      g.top += place.vertices;
      g.indexTop += place.indices;
      g.live += place.vertices;
    }

    this.copyRun(from, to, run, GLYPH_BYTES);
    this.dropCopy(copy);
    if (written > 0) {
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, absolute);
    }
  }

  /**
   * A shape's `data` copied into `page`, at its top or in a hole, its
   * indices made absolute from where its vertices went; false where the
   * page has no room for it.
   */
  private copyIn(page: Page, id: number, data: GeometryData): boolean {
    const count = data.positions.length / 2;
    const base = page.vertices.take(count);
    if (base < 0) {
      return false;
    }

    const indexStart = page.indices.take(data.indices.length);
    if (indexStart < 0) {
      page.vertices.give(base, count);
      return false;
    }

    this.copyAt(page, id, data, base, indexStart);
    return true;
  }

  /**
   * A shape's `data` copied into `page`'s room taken for it, from vertex
   * `base` and index `indexStart`, its indices kept in a copy of their own.
   */
  private copyAt(
    page: Page,
    id: number,
    data: GeometryData,
    base: number,
    indexStart: number,
  ): void {
    const count = data.positions.length / 2;
    const source = data.indices;
    this.copyVertices(page, data, base);
    this.writeIndices(page, source, base, indexStart);
    this.places[id] = {
      page: page.index,
      vertexStart: base,
      vertices: count,
      indexStart,
      indices: source.length,
      glyphs: null,
      flat: data.flat === true,
      stage: samplesStage(data),
      batch: this.batch(data),
      local: source,
      data,
      id,
      // As if staged as it is placed: a moving scene's runs come to it within STREAM_QUIET_FRAMES.
      stagedIn: this.frame,
      releasedIn: Number.POSITIVE_INFINITY,
    };
    page.live += count;
  }

  /** `source`, counted from a geometry's first vertex, made absolute from `base` into `page` from index `indexStart`: staged, or uploaded if too many. */
  private writeIndices(
    page: Page,
    source: Uint16Array | Uint32Array,
    base: number,
    indexStart: number,
  ): void {
    const length = source.length;
    if (length > STAGED_INDICES) {
      const indices = new Uint32Array(length);
      for (let i = 0; i < length; i++) {
        indices[i] = source[i] + base;
      }

      this.flushIndices();
      this.state.bindVertexArray(page.vertexArray);
      this.gl.bufferSubData(this.gl.ELEMENT_ARRAY_BUFFER, indexStart * 4, indices);
      return;
    }

    this.stagePage(page);
    if (
      this.stagedIndexCount + length > STAGED_INDICES ||
      this.stagedIndexAt + this.stagedIndexCount !== indexStart
    ) {
      this.flushIndices();
      this.stagedIndexAt = indexStart;
    }

    const staged = this.stagedIndices;
    const at = this.stagedIndexCount;
    for (let i = 0; i < length; i++) {
      staged[at + i] = source[i] + base;
    }

    this.stagedIndexCount = at + length;
  }

  /** `data`'s vertices interleaved for `page` from vertex `base`: staged, or uploaded if too many. */
  private copyVertices(page: Page, data: GeometryData, base: number): void {
    const count = data.positions.length / 2;
    if (count > STAGED_VERTICES) {
      const floats = new Float32Array(count * (VERTEX_BYTES / 4));
      interleave(data, count, floats, new Uint32Array(floats.buffer), 0);
      this.flushVertices();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, page.vertexBuffer);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
      return;
    }

    this.stagePage(page);
    if (
      this.stagedVertices + count > STAGED_VERTICES ||
      this.stagedVertexAt + this.stagedVertices !== base
    ) {
      this.flushVertices();
      this.stagedVertexAt = base;
    }

    interleave(data, count, this.stagedFloats, this.stagedWords, this.stagedVertices * 5);
    this.stagedVertices += count;
  }

  /** What is staged, uploaded: before anything draws from the atlas. */
  private flush(): void {
    this.flushVertices();
    this.flushIndices();
  }

  /** The staging made `page`'s, what it held for another uploaded first. */
  private stagePage(page: Page): void {
    if (this.stagedPage !== page) {
      this.flush();
      this.stagedPage = page;
    }
  }

  private flushVertices(): void {
    if (this.stagedVertices > 0) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, (this.stagedPage as Page).vertexBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        this.stagedVertexAt * VERTEX_BYTES,
        this.stagedFloats,
        0,
        this.stagedVertices * 5,
      );
      this.stagedVertices = 0;
    }
  }

  private flushIndices(): void {
    if (this.stagedIndexCount > 0) {
      const gl = this.gl;
      this.state.bindVertexArray((this.stagedPage as Page).vertexArray);
      gl.bufferSubData(
        gl.ELEMENT_ARRAY_BUFFER,
        this.stagedIndexAt * 4,
        this.stagedIndices,
        0,
        this.stagedIndexCount,
      );
      this.stagedIndexCount = 0;
    }
  }

  private batch(data: GeometryData): Place["batch"] {
    return data.positions.length <= 512 && data.indices.length <= 1024 && !data.depths
      ? { frame: this.frame }
      : null;
  }

  /**
   * Glyph quads copied in at the top of the glyph atlas, their indices made
   * absolute in it, and kept counted from the text's first vertex as a
   * shape's are.
   */
  private copyGlyphs(id: number, data: GeometryData): void {
    const gl = this.gl;
    const g = this.glyphs;
    const glyphs = data.glyphs as NonNullable<GeometryData["glyphs"]>;
    const count = glyphs.vertices.length / GLYPH_FLOATS;
    const source = data.indices;
    const indices = new Uint32Array(source.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = source[i] + g.top;
    }

    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, g.top * GLYPH_BYTES, glyphs.vertices);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, g.indexTop * 4, indices);
    this.places[id] = {
      page: 0,
      vertexStart: g.top,
      vertices: count,
      indexStart: g.indexTop,
      indices: indices.length,
      glyphs: {
        mode: glyphs.mode,
        table: glyphs.table,
        slot: this.tables.slot(glyphs.mode, glyphs.table),
      },
      flat: false,
      stage: false,
      batch: null,
      local: source,
      data: null,
      id,
      stagedIn: Number.NEGATIVE_INFINITY,
      releasedIn: Number.POSITIVE_INFINITY,
    };
    g.top += count;
    g.indexTop += indices.length;
    g.live += count;
  }

  /** The buffers and vertex arrays made on the context, deleted. */
  destroy(): void {
    const gl = this.gl;
    for (const page of this.pages) {
      gl.deleteVertexArray(page.vertexArray);
      gl.deleteBuffer(page.vertexBuffer);
      gl.deleteBuffer(page.indexBuffer);
    }

    gl.deleteVertexArray(this.glyphArray);
    gl.deleteBuffer(this.glyphBuffer);
    gl.deleteBuffer(this.glyphIndexBuffer);
    this.tables.destroy();
  }
}
