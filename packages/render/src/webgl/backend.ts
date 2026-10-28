import { GlState, linkProgram } from "@swf2es/context3d/device";
import { CLEAR, type Commands, RUN } from "../commands.js";
import type { Geometries, GeometryData } from "../geometry.js";
import { ROW_FLOATS, ROWS_A_LINE, type Rows } from "../rows.js";
import type { SceneList } from "../scene.js";
import { fillFragment, fillVertex, ROW_TEXELS } from "./programs.js";

/** Bytes a vertex in the atlas: its position's two floats, then its colour's four bytes. */
const VERTEX_BYTES = 12;
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

  /** Programs, buffers and textures made, as the context comes or comes back. */
  private setUp(): void {
    const gl = this.gl;
    this.state.forget();
    this.program = linkProgram(gl, fillVertex, fillFragment);
    this.rowLocation = gl.getUniformLocation(this.program, "uRow");
    this.viewLocation = gl.getUniformLocation(this.program, "uView");
    this.state.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uRows"), 0);
    this.vertexArray = gl.createVertexArray() as WebGLVertexArrayObject;
    this.vertexBuffer = gl.createBuffer() as WebGLBuffer;
    this.indexBuffer = gl.createBuffer() as WebGLBuffer;
    this.state.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    const position = gl.getAttribLocation(this.program, "aPosition");
    const color = gl.getAttribLocation(this.program, "aColor");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 8);
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
    target: Target,
  ): void {
    const gl = this.gl;
    if (gl.isContextLost()) {
      return;
    }

    this.place(geometries);
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

    let lastRow = -1;
    const ops = commands.ops;
    for (let k = 0; k < commands.length; k++) {
      const at = k * 4;
      switch (ops[at]) {
        case CLEAR: {
          const p = commands.params;
          const from = ops[at + 1];
          gl.clearColor(p[from], p[from + 1], p[from + 2], p[from + 3]);
          gl.clear(gl.COLOR_BUFFER_BIT);
          break;
        }

        case RUN: {
          // Premultiplied, as every blend mode will be.
          state.setBlend(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const end = ops[at + 1] + ops[at + 2];
          for (let i = ops[at + 1]; i < end; i++) {
            const place = this.places[scene.geometry[i]];
            if (!place) {
              continue;
            }

            const row = scene.row[i];
            if (row !== lastRow) {
              lastRow = row;
              gl.uniform1i(this.rowLocation, row);
            }

            gl.drawElements(gl.TRIANGLES, place.indices, gl.UNSIGNED_INT, place.indexStart * 4);
          }

          break;
        }
      }
    }
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
    for (let i = 0; i < count; i++) {
      floats[i * 3] = data.positions[i * 2];
      floats[i * 3 + 1] = data.positions[i * 2 + 1];
      words[i * 3 + 2] = data.colors[i];
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
    this.state.forget();
  }
}
