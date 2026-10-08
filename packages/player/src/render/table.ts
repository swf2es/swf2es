// Graphics drawn alone, a shape's fills and lines, drawn many to a call
// (docs/architecture.md, "Rendering"). Each draws a shared context's
// geometry under its own transform, a draw call apiece: in a crowded room,
// thousands a frame, each binding the context's buffers and setting its
// uniforms. Here the contexts' local vertices go once into one buffer, the
// atlas, and a run of such Graphics is one multi-draw of their index
// ranges, each draw reading its transform and tint from a row of a float
// texture by gl_DrawID, or of a uniform array for a short run: a frame
// writes the rows and uploads them, and no vertex moves. A run too short to
// repay its multi-draw, as filters leave, is drawn by Pixi's pipe. What the
// table cannot draw, a context with a texture or a Graphics that rounds to
// pixels, is drawn by Pixi's own pipe in its place in the run. A Flash
// colour transform's batched copies stay with the colour batcher
// (render/color.ts): drawn here, a few batched draws became thousands of the
// table's, which cost the GPU more than the CPU saved.
import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  color32BitToUniform,
  ExtensionType,
  extensions,
  Geometry,
  GlProgram,
  GpuGraphicsContext,
  type Graphics,
  type GraphicsContext,
  type GraphicsPipe,
  type Instruction,
  type InstructionSet,
  RendererType,
  Shader,
  State,
  Texture,
  UniformGroup,
  type WebGLRenderer,
} from "pixi.js";

const NAME = "flashTable";

/** Texels a row: the linear part, the translation, the tint. */
const ROW_TEXELS = 4;
const TABLE_WIDTH = 1024;
const ROWS_A_LINE = TABLE_WIDTH / ROW_TEXELS;
/**
 * The fewest draws a run makes through the table; Pixi's pipe draws a
 * shorter one. A multi-draw call costs Chrome's GPU process some 5 to 15
 * µs more than its draws would alone, and saves the page well under 1 µs
 * a draw: in a crowd of filtered creatures, each filter ending a run, runs
 * of 2 to 10 draws took a frame 1 to 5 ms longer than Pixi's draws on a
 * GPU, and runs of 22 broke even (`bench.ts --rig 128 --filtered K --gpu`).
 */
const MIN_RUN = 16;
/**
 * The most draws a run passes in uniforms rather than through the table
 * texture, whose upload costs Chrome a few µs more a run: 48 rows of 4
 * vectors leave room for Pixi's under the 256 every WebGL 2 allows a
 * vertex shader.
 */
const SHORT_RUN = 48;
/** Floats a vertex of a context's packed geometry: position, UV, colour, texture and rounding. */
const VERTEX_FLOATS = 6;
/** Atlas vertices dropped contexts may leave as holes before it is packed again. */
const ATLAS_SLACK = 1 << 16;

let enabled = true;
let minRun = MIN_RUN;

/**
 * Draw Graphics alone through the table, or not, from the next frame: a
 * switch to time the two apart. Runs already built draw through Pixi's
 * pipe while it is off; a group built while it was off draws alone until
 * it is built again. `shortest` is the fewest draws a run makes through
 * the table, MIN_RUN by default: the tests have the table draw every run
 * with 1, and the bench times others.
 */
export function setTransformTable(on: boolean, shortest = MIN_RUN): void {
  enabled = on;
  minRun = shortest;
}

/**
 * The vertex shader, reading a draw's row from the table texture or, for a
 * short run (SHORT_RUN), from a uniform array laid out as the table's rows.
 */
const vertex = (short: boolean) => `#version 300 es
#extension GL_ANGLE_multi_draw : require
in vec2 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
${
  short
    ? `uniform vec4 uRows[${SHORT_RUN * ROW_TEXELS}];`
    : `uniform highp sampler2D uTable;
uniform float uBase;`
}
out vec4 vColor;

void main(void) {
${
  short
    ? `  int at = gl_DrawID * ${ROW_TEXELS};
  vec4 m = uRows[at];
  vec4 t = uRows[at + 1];
  vec4 tint = uRows[at + 2];`
    : `  int row = int(uBase) + gl_DrawID;
  ivec2 at = ivec2((row & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, row >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uTable, at, 0);
  vec4 t = texelFetch(uTable, at + ivec2(1, 0), 0);
  vec4 tint = texelFetch(uTable, at + ivec2(2, 0), 0);`
}
  mat3 modelMatrix = mat3(m.x, m.y, 0.0, m.z, m.w, 0.0, t.x, t.y, 1.0);
  mat3 modelViewProjectionMatrix = uProjectionMatrix * uWorldTransformMatrix * modelMatrix;
  gl_Position = vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // As Pixi's graphics shader: the premultiplied fill times the group's tint and the world's.
  vColor = vec4(1.0);
  vColor *= vec4(aColor.rgb * aColor.a, aColor.a);
  vColor *= tint;
  vColor *= uWorldColorAlpha;
}
`;

const fragment = `#version 300 es
in vec4 vColor;
out vec4 finalColor;

void main(void) {
  finalColor = vColor;
}
`;

/** Pixi puts its precision and name first, where an extension may no longer be asked for. */
function tableProgram(short: boolean): GlProgram {
  const program = new GlProgram({
    name: short ? `${NAME}-short` : NAME,
    vertex: vertex(short),
    fragment,
  });
  const directive = "#extension GL_ANGLE_multi_draw : require\n";
  const source = (program.vertex ?? "").replace(directive, "");
  const version = "#version 300 es\n";
  (program as { vertex: string }).vertex = source.startsWith(version)
    ? version + directive + source.slice(version.length)
    : directive + source;
  return program;
}

/** What the atlas reads of a context's render data: its packed vertices, indices and batches. */
export interface Packed {
  batcher: {
    attributeBuffer: { float32View: Float32Array };
    attributeSize: number;
    indexBuffer: ArrayLike<number>;
    indexSize: number;
  };
  instructions: {
    instructionSize: number;
    instructions: ArrayLike<{
      start: number;
      size: number;
      topology: string;
      textures: { count: number; textures: ArrayLike<{ uid: number }> };
    }>;
  };
}

/** Where a context's batches lie in the atlas: each one's index count and first byte. */
export interface Placed {
  vertices: number;
  counts: number[];
  offsets: number[];
}

const atlases = new Set<Atlas>();

/**
 * The local vertices of every context the table has drawn, in one buffer
 * with one index buffer, absolute: each context's are copied in once, as
 * Pixi packed them for it, and stay until it is rebuilt or destroyed. The
 * holes those leave are reclaimed by packing again (compact).
 */
export class Atlas {
  vertices = new Float32Array(VERTEX_FLOATS * 4096);
  indices = new Uint32Array(4096 * 3);
  vertexCount = 0;
  indexCount = 0;
  /** The vertices and indices the GPU's buffers hold; what was added since goes up alone. */
  sentVertices = 0;
  sentIndices = 0;
  /** Whether the buffers must take the atlas whole: it grew into new arrays, or started again. */
  whole = true;
  private readonly placed = new Map<object, Placed | null>();
  private live = 0;
  private holes = 0;
  /** The id of a texture that is no texture, which alone the table draws. */
  private readonly white: number;

  constructor(white: number) {
    this.white = white;
    atlases.add(this);
  }

  /**
   * Where `key`'s batches lie, `packed` copied in first if they are not
   * there yet; null if the table cannot draw them.
   */
  place(key: object, packed: Packed): Placed | null {
    const known = this.placed.get(key);
    if (known !== undefined) {
      return known;
    }

    const { batcher, instructions } = packed;
    for (let i = 0; i < instructions.instructionSize; i++) {
      const batch = instructions.instructions[i];
      const textures = batch.textures;
      let flat = batch.topology === "triangle-list";
      for (let k = 0; k < textures.count; k++) {
        flat &&= textures.textures[k].uid === this.white;
      }

      if (!flat) {
        this.placed.set(key, null);
        return null;
      }
    }

    const vertexCount = batcher.attributeSize / VERTEX_FLOATS;
    this.reserve(vertexCount, batcher.indexSize);
    const base = this.vertexCount;
    this.vertices.set(
      batcher.attributeBuffer.float32View.subarray(0, batcher.attributeSize),
      base * VERTEX_FLOATS,
    );
    const first = this.indexCount;
    for (let i = 0; i < batcher.indexSize; i++) {
      this.indices[first + i] = batcher.indexBuffer[i] + base;
    }

    this.vertexCount += vertexCount;
    this.indexCount += batcher.indexSize;
    this.live += vertexCount;

    const placed: Placed = { vertices: vertexCount, counts: [], offsets: [] };
    for (let i = 0; i < instructions.instructionSize; i++) {
      const batch = instructions.instructions[i];
      if (batch.size) {
        placed.counts.push(batch.size);
        placed.offsets.push((first + batch.start) * 4);
      }
    }

    const shown = placed.counts.length ? placed : null;
    this.placed.set(key, shown);
    if (!shown) {
      this.holes += vertexCount;
      this.live -= vertexCount;
    }

    return shown;
  }

  /** `key`'s context rebuilt or destroyed: its vertices become a hole. */
  release(key: object): void {
    const placed = this.placed.get(key);
    if (placed === undefined) {
      return;
    }

    this.placed.delete(key);
    if (placed) {
      this.live -= placed.vertices;
      this.holes += placed.vertices;
    }
  }

  /**
   * Pack again from scratch if holes pass ATLAS_SLACK and the live
   * vertices: between frames, as a run's draws read where their contexts
   * lie until it is drawn.
   */
  compact(): void {
    if (this.holes > ATLAS_SLACK && this.holes > this.live) {
      this.clear();
    }
  }

  /** Forget every context, to be copied in again as each is next drawn. */
  clear(): void {
    this.placed.clear();
    this.vertexCount = 0;
    this.indexCount = 0;
    this.sentVertices = 0;
    this.sentIndices = 0;
    this.whole = true;
    this.live = 0;
    this.holes = 0;
  }

  destroy(): void {
    this.clear();
    atlases.delete(this);
  }

  private reserve(vertexCount: number, indexCount: number): void {
    const vertices = (this.vertexCount + vertexCount) * VERTEX_FLOATS;
    if (vertices > this.vertices.length) {
      const grown = new Float32Array(Math.max(vertices, this.vertices.length * 2));
      grown.set(this.vertices.subarray(0, this.vertexCount * VERTEX_FLOATS));
      this.vertices = grown;
      this.whole = true;
    }

    const indices = this.indexCount + indexCount;
    if (indices > this.indices.length) {
      const grown = new Uint32Array(Math.max(indices, this.indices.length * 2));
      grown.set(this.indices.subarray(0, this.indexCount));
      this.indices = grown;
      this.whole = true;
    }
  }
}

// A context's GPU data is reset as it is built again and as it is destroyed: its place goes then.
const reset = GpuGraphicsContext.prototype.reset;
GpuGraphicsContext.prototype.reset = function (this: GpuGraphicsContext) {
  for (const atlas of atlases) {
    atlas.release(this);
  }

  reset.call(this);
};

/** A run of Graphics drawn alone, in the order the build added them. */
export interface TableInstruction extends Instruction {
  renderPipeId: typeof NAME;
  items: Graphics[];
}

/** Add `graphics` to the run `instructionSet` ends with, or start one: anything else ends a run. */
export function addToRun(graphics: Graphics, instructionSet: InstructionSet): void {
  const size = instructionSet.instructionSize;
  const last = instructionSet.instructions[size - 1] as TableInstruction | undefined;
  if (size > 0 && last?.renderPipeId === NAME) {
    last.items.push(graphics);
    return;
  }

  const run: TableInstruction = { renderPipeId: NAME, canBundle: false, items: [graphics] };
  instructionSet.add(run);
}

type Multi = {
  multiDrawElementsWEBGL(
    mode: number,
    counts: Int32Array,
    countsOffset: number,
    type: number,
    offsets: Int32Array,
    offsetsOffset: number,
    drawcount: number,
  ): void;
};

type ContextSystem = {
  getGpuContext(context: GraphicsContext): GpuGraphicsContext;
  getContextRenderData(context: GraphicsContext): Packed;
};

type Drawn = Graphics & { _roundPixels: number };

const tableSource = (height: number) =>
  new BufferImageSource({
    resource: new Float32Array(TABLE_WIDTH * height * 4),
    width: TABLE_WIDTH,
    height,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
  });

export class TablePipe {
  static extension = {
    type: [ExtensionType.WebGLPipes, ExtensionType.WebGPUPipes],
    name: NAME,
  } as const;

  private readonly renderer: WebGLRenderer;
  private multi: Multi | null = null;
  /** The most rows the table may hold: as many lines as a texture may be tall. */
  private maxRows = 0;
  private shader: Shader | null = null;
  private shortShader: Shader | null = null;
  /** Where the short shader's program, as last linked, takes its rows. */
  private rows: { program: WebGLProgram; location: WebGLUniformLocation | null } | null = null;
  private readonly uniforms = new UniformGroup({ uBase: { value: 0, type: "f32" } });
  private readonly state = State.for2d();
  /** The next row free this frame. */
  private cursor = 0;
  // Made for WebGL alone, the only renderer that draws the table. The
  // table, the atlas and their buffers never shrink from their peak: a
  // crowded scene's, kept while the renderer lives.
  private table!: BufferImageSource;
  private atlas!: Atlas;
  private attributes!: Buffer;
  private indexBuffer!: Buffer;
  private geometry!: Geometry;
  /** The run being gathered: its first row, blend mode, and its draws' counts and offsets. */
  private counts = new Int32Array(1024);
  private offsets = new Int32Array(1024);
  private draws = 0;
  private runBase = 0;
  private runBlend = "";
  /** The Graphics the run gathered, for Pixi's pipe to draw if it is too short for the table. */
  private segment: Graphics[] = [];

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    if (renderer.type !== RendererType.WEBGL) {
      return;
    }

    this.table = tableSource(16);
    this.atlas = new Atlas(Texture.WHITE.source.uid);
    this.attributes = new Buffer({
      data: this.atlas.vertices,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    this.indexBuffer = new Buffer({
      data: this.atlas.indices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    const stride = VERTEX_FLOATS * 4;
    this.geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.attributes, format: "float32x2", stride, offset: 0 },
        aColor: { buffer: this.attributes, format: "unorm8x4", stride, offset: 4 * 4 },
      },
      indexBuffer: this.indexBuffer,
    });
    renderer.runners.contextChange.add(this);
    renderer.runners.prerender.add(this);
  }

  contextChange(): void {
    const gl = this.renderer.gl;
    this.multi =
      this.renderer.context.webGLVersion === 2
        ? (gl.getExtension("WEBGL_multi_draw") as Multi | null)
        : null;
    this.maxRows = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) * ROWS_A_LINE;
    // A lost context took the atlas' buffers: every context is copied in again as it is drawn.
    this.atlas.clear();
  }

  prerender(): void {
    this.cursor = 0;
    this.atlas.compact();
  }

  /** Whether the table draws for this renderer: switched on, and WebGL 2 with multi-draw. */
  get active(): boolean {
    return enabled && this.multi !== null;
  }

  add(graphics: Graphics, instructionSet: InstructionSet): void {
    addToRun(graphics, instructionSet);
  }

  execute(instruction: TableInstruction): void {
    const renderer = this.renderer;
    const graphicsPipe = renderer.renderPipes.graphics as unknown as GraphicsPipe;
    const contexts = renderer.graphicsContext as unknown as ContextSystem;
    const roundAll = (renderer as unknown as { _roundPixels: number })._roundPixels;
    // Switched off, a context restored without the extension, or a run
    // that cannot reach minRun draws, as most between filters, before a row
    // is written: Pixi's pipe draws it.
    if (!this.active || this.mostDraws(instruction, contexts) < minRun) {
      for (const item of instruction.items) {
        graphicsPipe.execute(item);
      }

      return;
    }

    this.runBase = this.cursor;
    this.draws = 0;

    for (const item of instruction.items) {
      const graphics = item as Drawn;
      if (!graphics.isRenderable) {
        continue;
      }

      const context = graphics.context;
      const gpu = contexts.getGpuContext(context);
      if (!gpu.batches.length) {
        continue;
      }

      const place =
        gpu.isBatchable || context.customShader || roundAll | graphics._roundPixels
          ? null
          : this.atlas.place(gpu, contexts.getContextRenderData(context));
      if (!place || this.cursor + place.counts.length > this.maxRows) {
        this.flush();
        graphicsPipe.execute(graphics);
        continue;
      }

      if (graphics.groupBlendMode !== this.runBlend) {
        this.flush();
        this.runBlend = graphics.groupBlendMode;
      }

      this.segment.push(graphics);
      for (let i = 0; i < place.counts.length; i++) {
        this.row(graphics);
        this.counts[this.draws] = place.counts[i];
        this.offsets[this.draws] = place.offsets[i];
        this.draws++;
      }
    }

    this.flush();
  }

  /** The draws `instruction` makes at most: one for each batch of each Graphics' context. */
  private mostDraws(instruction: TableInstruction, contexts: ContextSystem): number {
    let draws = 0;
    for (const item of instruction.items) {
      draws += contexts.getGpuContext(item.context).batches.length;
      if (draws >= minRun) {
        break;
      }
    }

    return draws;
  }

  /** Write `graphics`' transform and tint into the next row, the table and run grown to hold it. */
  private row(graphics: Drawn): void {
    if (this.cursor >= this.table.height * ROWS_A_LINE) {
      this.grow();
    }

    if (this.draws === this.counts.length) {
      const counts = new Int32Array(this.draws * 2);
      const offsets = new Int32Array(this.draws * 2);
      counts.set(this.counts);
      offsets.set(this.offsets);
      this.counts = counts;
      this.offsets = offsets;
    }

    const out = this.table.resource as Float32Array;
    const at = this.cursor * ROW_TEXELS * 4;
    const m = graphics.groupTransform;
    out[at] = m.a;
    out[at + 1] = m.b;
    out[at + 2] = m.c;
    out[at + 3] = m.d;
    out[at + 4] = m.tx;
    out[at + 5] = m.ty;
    color32BitToUniform(graphics.groupColorAlpha, out, at + 8);

    this.cursor++;
  }

  /** The table twice as tall, at most maxRows, the rows this frame wrote so far brought along. */
  private grow(): void {
    const table = tableSource(Math.min(this.table.height * 2, this.maxRows / ROWS_A_LINE));
    (table.resource as Float32Array).set(this.table.resource as Float32Array);
    this.table.destroy();
    this.table = table;
    if (this.shader) {
      this.shader.resources.uTable = table;
    }
  }

  /**
   * Draw the run gathered as one call, its rows passed in uniforms if few,
   * uploaded if not; or its Graphics through Pixi's pipe if it is too short.
   */
  private flush(): void {
    const draws = this.draws;
    if (draws === 0 || !this.multi) {
      this.segment.length = 0;
      this.draws = 0;
      this.runBase = this.cursor;
      return;
    }

    const renderer = this.renderer;
    if (draws < minRun) {
      const graphicsPipe = renderer.renderPipes.graphics as unknown as GraphicsPipe;
      for (const graphics of this.segment) {
        graphicsPipe.execute(graphics);
      }

      this.segment.length = 0;
      this.draws = 0;
      // Their rows are free again for the next run's.
      this.cursor = this.runBase;
      return;
    }

    this.segment.length = 0;
    const short = draws <= SHORT_RUN;
    if (!short) {
      this.upload(this.runBase, this.cursor);
    }

    this.send();

    const shader = short ? this.shortRunShader() : this.tableShader();
    shader.groups[0] = renderer.globalUniforms.bindGroup;
    this.state.blendMode = this.runBlend as State["blendMode"];
    renderer.state.set(this.state);
    renderer.shader.bind(shader);
    if (short) {
      this.passRows(shader);
    }

    renderer.geometry.bind(this.geometry, shader.glProgram);
    const gl = renderer.gl;
    this.multi.multiDrawElementsWEBGL(
      gl.TRIANGLES,
      this.counts,
      0,
      gl.UNSIGNED_INT,
      this.offsets,
      0,
      draws,
    );

    this.draws = 0;
    // Rows passed in uniforms are free again for the next run's.
    if (short) {
      this.cursor = this.runBase;
    }

    this.runBase = this.cursor;
  }

  private tableShader(): Shader {
    this.shader ??= new Shader({
      glProgram: tableProgram(false),
      resources: { tableUniforms: this.uniforms, uTable: this.table },
    });
    this.uniforms.uniforms.uBase = this.runBase;
    return this.shader;
  }

  private shortRunShader(): Shader {
    this.shortShader ??= new Shader({ glProgram: tableProgram(true), resources: {} });
    return this.shortShader;
  }

  /** Pass the run's rows to the short shader, bound: Pixi knows nothing of its uRows. */
  private passRows(shader: Shader): void {
    const gl = this.renderer.gl;
    const shaders = this.renderer.shader as unknown as {
      _getProgramData(program: GlProgram): { program: WebGLProgram };
    };
    const program = shaders._getProgramData(shader.glProgram).program;
    if (this.rows?.program !== program) {
      this.rows = { program, location: gl.getUniformLocation(program, "uRows") };
    }

    const floats = ROW_TEXELS * 4;
    gl.uniform4fv(
      this.rows.location,
      this.table.resource as Float32Array,
      this.runBase * floats,
      this.draws * floats,
    );
  }

  /**
   * Bring the GPU's atlas buffers up to date: what was added since the
   * last draw alone, as contexts are placed on most frames of an animation
   * into an atlas of hundreds of thousands of vertices; whole only once it
   * grew or started again.
   */
  private send(): void {
    const atlas = this.atlas;
    if (atlas.whole) {
      atlas.whole = false;
      this.attributes.setDataWithSize(atlas.vertices, atlas.vertexCount * VERTEX_FLOATS, true);
      this.indexBuffer.setDataWithSize(atlas.indices, atlas.indexCount, true);
    } else {
      const bytes = VERTEX_FLOATS * 4;
      if (atlas.vertexCount > atlas.sentVertices) {
        this.attributes.update(
          (atlas.vertexCount - atlas.sentVertices) * bytes,
          atlas.sentVertices * bytes,
        );
      }

      if (atlas.indexCount > atlas.sentIndices) {
        this.indexBuffer.update((atlas.indexCount - atlas.sentIndices) * 4, atlas.sentIndices * 4);
      }
    }

    atlas.sentVertices = atlas.vertexCount;
    atlas.sentIndices = atlas.indexCount;
  }

  /**
   * Upload rows `from` up to `to` in one call: the part of the line they
   * lie in, or the whole lines they span. A line's other rows go up again
   * as the CPU holds them: rows a draw already read are as they were, and
   * no draw yet to come reads the rest before writing and uploading them.
   */
  private upload(from: number, to: number): void {
    const renderer = this.renderer;
    const gl = renderer.gl;
    const textures = renderer.texture as unknown as {
      bind(texture: BufferImageSource, location: number): void;
      _activateLocation(location: number): void;
      _premultiplyAlpha: boolean;
    };
    // Bound first, as Pixi binds: a new table is allocated and uploaded whole then.
    textures.bind(this.table, 0);
    // Bound already, bind leaves the active unit as it was, which a render
    // pass may have moved to unbind a back texture: the upload must go to 0.
    textures._activateLocation(0);
    if (textures._premultiplyAlpha) {
      textures._premultiplyAlpha = false;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }

    const first = Math.floor(from / ROWS_A_LINE);
    const lines = Math.floor((to - 1) / ROWS_A_LINE) - first + 1;
    const start = lines > 1 ? first * ROWS_A_LINE : from;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      (start - first * ROWS_A_LINE) * ROW_TEXELS,
      first,
      lines > 1 ? TABLE_WIDTH : (to - from) * ROW_TEXELS,
      lines,
      gl.RGBA,
      gl.FLOAT,
      this.table.resource as Float32Array,
      start * ROW_TEXELS * 4,
    );
  }

  destroy(): void {
    if (this.renderer.type !== RendererType.WEBGL) {
      return;
    }

    this.shader?.destroy(true);
    this.shortShader?.destroy(true);
    this.geometry.destroy(true);
    this.table.destroy();
    this.atlas.destroy();
  }
}

extensions.add(TablePipe);
