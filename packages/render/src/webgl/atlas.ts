import type { GlState } from "@swf2es/context3d/device";
import { type Geometries, type GeometryData, GLYPH_FLOATS } from "../geometry.js";
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
/** Holes past which, and past the live vertices, the atlas is packed again. */
const SLACK = 1 << 16;
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

/** Where a geometry lies in the atlas, or the glyph atlas with its text's mode and table. */
export interface Place {
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
  glyphs: { mode: Float32Array; table: Float32Array } | null;
  /** Its geometry's flat (GeometryData.flat). */
  flat: boolean;
  /** Small, unchanged geometries may be copied into a run's streaming buffer. */
  batch: { data: GeometryData; frame: number } | null;
}

/**
 * The geometry atlas: every geometry copied once into a vertex and an index
 * buffer, and advanced text's glyph quads into an atlas of their own, where
 * the draws find them by their places. A geometry let go of leaves a hole,
 * and each atlas is packed again from the geometries' own arrays once the
 * holes outweigh what is live.
 */
export class GeometryAtlas {
  frame = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly state: GlState;
  vertexArray!: WebGLVertexArrayObject;
  private vertexBuffer!: WebGLBuffer;
  private indexBuffer!: WebGLBuffer;
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private vertexTop = 0;
  private indexTop = 0;
  private live = 0;
  private holes = 0;
  /** Vertices staged for the atlas from vertex `stagedVertexAt`, as floats and as words. */
  private readonly stagedFloats = new Float32Array(STAGED_VERTICES * (VERTEX_BYTES / 4));
  private readonly stagedWords = new Uint32Array(this.stagedFloats.buffer);
  private stagedVertexAt = 0;
  private stagedVertices = 0;
  /** Indices staged for the atlas from index `stagedIndexAt`. */
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

  constructor(gl: WebGL2RenderingContext, state: GlState) {
    this.gl = gl;
    this.state = state;
  }

  /** The buffers and vertex arrays made, both atlases empty, as the context comes or comes back. */
  setUp(): void {
    const gl = this.gl;
    this.vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.vertexBuffer = gl.createBuffer() as WebGLBuffer;
    this.indexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.enableVertexAttribArray(POSITION_AT);
    gl.vertexAttribPointer(POSITION_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(TEXEL_AT);
    gl.vertexAttribPointer(TEXEL_AT, 2, gl.FLOAT, false, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(COLOR_AT);
    gl.vertexAttribPointer(COLOR_AT, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 16);
    // The same bytes as a mesh's depth, which the mesh program reads in place of the colour.
    gl.enableVertexAttribArray(DEPTH_AT);
    gl.vertexAttribPointer(DEPTH_AT, 1, gl.FLOAT, false, VERTEX_BYTES, 16);
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
    this.vertexCapacity = 0;
    this.indexCapacity = 0;
    this.stagedVertices = 0;
    this.stagedIndexCount = 0;
    this.places = [];
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in: at the top while they fit, else into an atlas packed again,
   * grown to twice what is live.
   */
  place(geometries: Geometries): void {
    this.frame++;
    for (const id of geometries.removed) {
      const place = this.places[id];
      if (place?.glyphs) {
        this.places[id] = null;
        this.glyphs.live -= place.vertices;
        this.glyphs.holes += place.vertices;
      } else if (place) {
        this.places[id] = null;
        this.live -= place.vertices;
        this.holes += place.vertices;
      }
    }

    geometries.removed.length = 0;
    // Nothing left in it: filled again from its start, in the buffers it has.
    if (this.live === 0) {
      this.vertexTop = 0;
      this.indexTop = 0;
      this.holes = 0;
    }

    // Changed in place: copied again where they lie, else as added.
    for (const id of geometries.updated) {
      const place = this.places[id];
      const data = geometries.get(id);
      if (place && data && !data.glyphs && place.vertices === data.positions.length / 2) {
        this.copyVertices(data, place.vertexStart);
        place.batch = this.batch(data);
      } else if (place && data) {
        this.places[id] = null;
        if (place.glyphs) {
          this.glyphs.live -= place.vertices;
          this.glyphs.holes += place.vertices;
        } else {
          this.live -= place.vertices;
          this.holes += place.vertices;
        }

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
    // the shapes', nor shapes the texts'.
    const g = this.glyphs;
    const shapes =
      this.vertexTop + vertices > this.vertexCapacity ||
      this.indexTop + indices > this.indexCapacity ||
      (this.holes > SLACK && this.holes > this.live);
    const texts =
      g.top + glyphVertices > g.capacity ||
      g.indexTop + glyphIndices > g.indexCapacity ||
      (g.holes > GLYPHS_LEAST && g.holes > g.live);
    if (shapes) {
      this.repack(geometries);
    }

    if (texts) {
      this.repackGlyphs(geometries);
    }

    for (const id of geometries.added) {
      const data = geometries.get(id);
      if (data && !(data.glyphs ? texts : shapes)) {
        this.copyIn(id, data);
      }
    }

    geometries.added.length = 0;
    this.flush();
  }

  /** Every live shape's geometry copied into new buffers, with room for twice what is live. */
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

    this.vertexCapacity = Math.max(LEAST, vertices * 2);
    this.indexCapacity = Math.max(LEAST * 3, indices * 2);
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity * VERTEX_BYTES, gl.STATIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity * 4, gl.STATIC_DRAW);
    // What was staged for the buffers replaced is copied again below.
    this.stagedVertices = 0;
    this.stagedIndexCount = 0;
    this.vertexTop = 0;
    this.indexTop = 0;
    this.live = 0;
    this.holes = 0;
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (!data.glyphs) {
        this.copyIn(id, data);
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
    for (const id of ids) {
      const data = geometries.get(id) as GeometryData;
      if (data.glyphs) {
        this.copyGlyphs(id, data);
      }
    }
  }

  /** `data` copied in at the top of the atlas, its indices made absolute. */
  private copyIn(id: number, data: GeometryData): void {
    if (data.glyphs) {
      this.copyGlyphs(id, data);
      return;
    }

    const count = data.positions.length / 2;
    const base = this.vertexTop;
    this.copyVertices(data, base);
    const source = data.indices;
    const length = source.length;
    if (length > STAGED_INDICES) {
      const indices = new Uint32Array(length);
      for (let i = 0; i < length; i++) {
        indices[i] = source[i] + base;
      }

      this.flushIndices();
      this.state.bindVertexArray(this.vertexArray);
      this.gl.bufferSubData(this.gl.ELEMENT_ARRAY_BUFFER, this.indexTop * 4, indices);
    } else {
      if (
        this.stagedIndexCount + length > STAGED_INDICES ||
        this.stagedIndexAt + this.stagedIndexCount !== this.indexTop
      ) {
        this.flushIndices();
        this.stagedIndexAt = this.indexTop;
      }

      const staged = this.stagedIndices;
      const at = this.stagedIndexCount;
      for (let i = 0; i < length; i++) {
        staged[at + i] = source[i] + base;
      }

      this.stagedIndexCount = at + length;
    }

    this.places[id] = {
      vertexStart: base,
      vertices: count,
      indexStart: this.indexTop,
      indices: length,
      glyphs: null,
      flat: data.flat === true,
      batch: this.batch(data),
    };
    this.vertexTop += count;
    this.indexTop += length;
    this.live += count;
  }

  /** `data`'s vertices interleaved for the atlas from vertex `base`: staged, or uploaded if too many. */
  private copyVertices(data: GeometryData, base: number): void {
    const count = data.positions.length / 2;
    if (count > STAGED_VERTICES) {
      const floats = new Float32Array(count * (VERTEX_BYTES / 4));
      interleave(data, count, floats, new Uint32Array(floats.buffer), 0);
      this.flushVertices();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
      return;
    }

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

  private flushVertices(): void {
    if (this.stagedVertices > 0) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
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
      this.state.bindVertexArray(this.vertexArray);
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
      vertexStart: g.top,
      vertices: count,
      indexStart: g.indexTop,
      indices: indices.length,
      glyphs: { mode: glyphs.mode, table: glyphs.table },
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
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteVertexArray(this.glyphArray);
    gl.deleteBuffer(this.glyphBuffer);
    gl.deleteBuffer(this.glyphIndexBuffer);
  }
}
