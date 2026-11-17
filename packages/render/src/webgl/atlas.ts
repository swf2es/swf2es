import type { GlState } from "@swf2es/context3d/device";
import { type Geometries, type GeometryData, GLYPH_FLOATS } from "../geometry.js";
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
const VERTEX_BYTES = 20;
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
  /** Small, unchanged geometries may be copied into a run's streaming buffer. */
  batch: { data: GeometryData; frame: number } | null;
}

/**
 * The geometry atlas: every geometry copied once into a page's vertex and
 * index buffers, and advanced text's glyph quads into an atlas of their
 * own, where the draws find them by their places. A geometry let go of
 * leaves holes in its page, which later geometries are placed in once the
 * top is full; a page is packed again from the geometries' own arrays only
 * when what is added finds no room. Repacking every geometry for its holes
 * alone made frames that copied and uploaded the whole atlas again, tens of
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
   * copied in: the shapes together at their page's top or in a hole that
   * holds them all, else each in the first hole that holds it, else into a
   * page packed again with room for twice what is live; a text at the
   * glyph atlas' top, else into one packed again.
   */
  place(geometries: Geometries): void {
    this.frame++;
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

    // Changed in place: copied again where they lie, else as added.
    for (const id of geometries.updated) {
      const place = this.places[id];
      const data = geometries.get(id);
      if (place && data && !data.glyphs && place.vertices === data.positions.length / 2) {
        this.copyVertices(this.pages[place.page], data, place.vertexStart);
        place.batch = this.batch(data);
      } else if (place && data) {
        this.letGo(id);
        geometries.added.push(id);
      }
    }

    geometries.updated.length = 0;
    let vertices = 0;
    let indices = 0;
    let glyphVertices = 0;
    let glyphIndices = 0;
    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data?.glyphs) {
        glyphVertices += data.glyphs.vertices.length / GLYPH_FLOATS;
        glyphIndices += data.indices.length;
      } else if (data) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    // Each atlas packed again on its own, so that texts' quads made again often never repack
    // the shapes', nor shapes the texts'. The shapes' page only when what is added outweighs its
    // room, or below, when holes too small for one of them leave it none.
    const g = this.glyphs;
    const page = this.pages[0];
    let shapes = vertices > page.vertices.room() || indices > page.indices.room();
    const texts =
      g.top + glyphVertices > g.capacity ||
      g.indexTop + glyphIndices > g.indexCapacity ||
      (g.holes > GLYPHS_LEAST && g.holes > g.live) ||
      this.tables.full;
    if (shapes) {
      this.repack(geometries);
    }

    if (texts) {
      this.repackGlyphs(geometries);
    }

    // The shapes added together in one range where one holds them all, at the top or in a
    // hole, so that they go up in one upload each for vertices and indices; else each in the
    // first that holds it, which a churning atlas would leave to a call or two a geometry.
    let vertexAt = -1;
    let indexAt = -1;
    if (!shapes && vertices > 0) {
      vertexAt = page.vertices.take(vertices);
      indexAt = vertexAt < 0 ? -1 : page.indices.take(indices);
      if (vertexAt >= 0 && indexAt < 0) {
        page.vertices.give(vertexAt, vertices);
        vertexAt = -1;
      }
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (!data) {
        continue;
      }

      // Added twice in a frame, as an id let go of and taken again can be: its first copy's
      // room given back, which only packing would otherwise find again. A packed atlas holds
      // its geometries already.
      if (data.glyphs) {
        if (!texts) {
          this.letGo(id);
          this.copyGlyphs(id, data);
        }

        continue;
      }

      if (shapes) {
        continue;
      }

      this.letGo(id);
      if (vertexAt >= 0) {
        this.copyAt(page, id, data, vertexAt, indexAt);
        vertexAt += data.positions.length / 2;
        indexAt += data.indices.length;
      } else if (!this.copyIn(page, id, data)) {
        // Packing copies every live shape, those added after this one too.
        shapes = true;
        this.repack(geometries);
      }
    }

    geometries.added.length = 0;
    this.flush();
    this.tables.upload();
  }

  /** Every live shape copied into its page's buffers made anew, with room for twice them. */
  repack(geometries: Geometries): void {
    const gl = this.gl;
    const ids = geometries.live();
    let vertices = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (!data.glyphs) {
        vertices += data.positions.length / 2;
        indices += data.indices.length;
      }
    }

    const page = this.pages[0];
    page.vertices.reset(Math.max(LEAST, vertices * 2));
    page.indices.reset(Math.max(LEAST * 3, indices * 2));
    page.live = 0;
    this.state.bindVertexArray(page.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, page.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, page.vertices.capacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, page.indices.capacity * 4, gl.STATIC_DRAW);
    // What was staged for the buffers replaced is copied again below.
    this.stagedVertices = 0;
    this.stagedIndexCount = 0;
    // Each at the top, which holds twice them all.
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (!data.glyphs) {
        this.copyIn(page, id, data);
      }
    }

    this.flush();
  }

  /** Every live text's quads copied into new glyph buffers: none till a text needs them. */
  repackGlyphs(geometries: Geometries): void {
    const gl = this.gl;
    const g = this.glyphs;
    const ids = geometries.live();
    let vertices = 0;
    let indices = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        vertices += data.glyphs.vertices.length / GLYPH_FLOATS;
        indices += data.indices.length;
      }
    }

    g.capacity = vertices > 0 ? Math.max(GLYPHS_LEAST, vertices * 2) : 0;
    g.indexCapacity = vertices > 0 ? Math.max(GLYPHS_LEAST * 2, indices * 2) : 0;
    this.state.bindVertexArray(this.glyphArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, g.capacity * GLYPH_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indexCapacity * 4, gl.STATIC_DRAW);
    g.top = 0;
    g.indexTop = 0;
    g.live = 0;
    g.holes = 0;
    // Only the live texts' tables kept.
    this.tables.reset();
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        this.copyGlyphs(id, data);
      }
    }

    this.tables.upload();
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

  /** A shape's `data` copied into `page`'s room taken for it, from vertex `base` and index `indexStart`. */
  private copyAt(
    page: Page,
    id: number,
    data: GeometryData,
    base: number,
    indexStart: number,
  ): void {
    const count = data.positions.length / 2;
    const source = data.indices;
    const length = source.length;
    this.copyVertices(page, data, base);
    if (length > STAGED_INDICES) {
      const indices = new Uint32Array(length);
      for (let i = 0; i < length; i++) {
        indices[i] = source[i] + base;
      }

      this.flushIndices();
      this.state.bindVertexArray(page.vertexArray);
      this.gl.bufferSubData(this.gl.ELEMENT_ARRAY_BUFFER, indexStart * 4, indices);
    } else {
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

    this.places[id] = {
      page: page.index,
      vertexStart: base,
      vertices: count,
      indexStart,
      indices: length,
      glyphs: null,
      flat: data.flat === true,
      batch: this.batch(data),
    };
    page.live += count;
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
      ? { data, frame: this.frame }
      : null;
  }

  /** Glyph quads copied in at the top of the glyph atlas, their indices made absolute in it. */
  private copyGlyphs(id: number, data: GeometryData): void {
    const gl = this.gl;
    const g = this.glyphs;
    const glyphs = data.glyphs as NonNullable<GeometryData["glyphs"]>;
    const count = glyphs.vertices.length / GLYPH_FLOATS;
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + g.top;
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
      batch: null,
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
