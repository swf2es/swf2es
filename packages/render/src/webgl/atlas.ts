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

/** Where a geometry lies in the atlas, or the glyph atlas with its text's mode and table. */
export interface Place {
  vertexStart: number;
  vertices: number;
  indexStart: number;
  indices: number;
  glyphs: { mode: Float32Array; table: Float32Array } | null;
}

/**
 * The geometry atlas: every geometry copied once into a vertex and an index
 * buffer, and advanced text's glyph quads into an atlas of their own, where
 * the draws find them by their places. A geometry let go of leaves a hole,
 * and each atlas is packed again from the geometries' own arrays once the
 * holes outweigh what is live.
 */
export class GeometryAtlas {
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
    this.places = [];
  }

  /**
   * The geometries removed since the last frame let go of, and those added
   * copied in: at the top while they fit, else into an atlas packed again,
   * grown to twice what is live.
   */
  place(geometries: Geometries): void {
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
    // Changed in place: copied again where they lie, else as added.
    for (const id of geometries.updated) {
      const place = this.places[id];
      const data = geometries.get(id);
      if (place && data && !data.glyphs && place.vertices === data.positions.length / 2) {
        this.copyVertices(data, place.vertexStart);
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

    const gl = this.gl;
    const count = data.positions.length / 2;
    const base = this.vertexTop;
    this.copyVertices(data, base);
    const indices = new Uint32Array(data.indices.length);
    for (let i = 0; i < indices.length; i++) {
      indices[i] = data.indices[i] + base;
    }

    this.state.bindVertexArray(this.vertexArray);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, this.indexTop * 4, indices);
    this.places[id] = {
      vertexStart: base,
      vertices: count,
      indexStart: this.indexTop,
      indices: indices.length,
      glyphs: null,
    };
    this.vertexTop += count;
    this.indexTop += indices.length;
    this.live += count;
  }

  /** `data`'s vertices interleaved into the atlas from vertex `base`. */
  private copyVertices(data: GeometryData, base: number): void {
    const gl = this.gl;
    const count = data.positions.length / 2;
    const bytes = new ArrayBuffer(count * VERTEX_BYTES);
    const floats = new Float32Array(bytes);
    const words = new Uint32Array(bytes);
    const texels = data.texels;
    const depths = data.depths;
    for (let i = 0; i < count; i++) {
      floats[i * 5] = data.positions[i * 2];
      floats[i * 5 + 1] = data.positions[i * 2 + 1];
      floats[i * 5 + 2] = texels ? texels[i * 2] : 0;
      floats[i * 5 + 3] = texels ? texels[i * 2 + 1] : 0;
      if (depths) {
        floats[i * 5 + 4] = depths[i];
      } else {
        words[i * 5 + 4] = data.colors[i];
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, base * VERTEX_BYTES, floats);
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
