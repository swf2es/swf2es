// Graphics drawn alone, a shape's fills and lines, drawn many to a call
// (docs/architecture.md, "Rendering"). Each draws a shared context's
// geometry under its own transform, a draw call apiece: in a crowded room,
// thousands a frame, each binding the context's buffers and setting its
// uniforms. Here the contexts' local vertices go once into one buffer, the
// atlas, and a run of such Graphics is one multi-draw of their index
// ranges, each draw reading its transform and tint from a row of a float
// texture by gl_DrawID, or of a uniform array for a short run: a frame
// writes the rows and uploads them, and no vertex moves. A run too short to
// repay its multi-draw, as filters leave, is drawn from the atlas a call a
// draw, each told its row: its buffers bound once for the run, where
// Pixi's pipe binds each context's own and sets each Graphics' uniforms. What the
// table cannot draw, a context with a texture or a Graphics that rounds to
// pixels, is drawn by Pixi's own pipe in its place in the run. A large
// Graphics under a Flash colour transform, in a group that has not settled,
// is drawn here too, the transform in its row (render/color.ts, showFor):
// as a batched copy, its vertices were packed again with every rebuild and
// every change of the transform. Small ones, and a settled group's, stay
// batched copies: drawn here, a few batched draws became thousands of the
// table's, which cost the GPU more than the CPU saved.
import type { ColorTransform } from "@swf2es/format";
import {
  type Batch,
  Buffer,
  BufferImageSource,
  BufferUsage,
  color32BitToUniform,
  ExtensionType,
  extensions,
  Geometry,
  GlProgram,
  type GpuGraphicsContext,
  type Graphics,
  type GraphicsContextSystem,
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

/**
 * Texels a row: the linear part; the translation, and whether a colour
 * transform applies; the tint; the colour transform's multipliers and its
 * offsets.
 */
const ROW_TEXELS = 5;
const ROWS_A_LINE = 256;
const TABLE_WIDTH = ROWS_A_LINE * ROW_TEXELS;
/**
 * The fewest draws a run makes as one multi-draw; a shorter one is drawn
 * from the atlas a call a draw. A multi-draw call costs Chrome's GPU
 * process some 5 to 15 µs more than its draws would alone, and saves the
 * page well under 1 µs a draw: in a crowd of filtered creatures, each
 * filter ending a run, runs of 2 to 10 draws took a frame 1 to 5 ms longer
 * than Pixi's draws on a GPU, and runs of 22 broke even (`bench.ts --rig
 * 128 --filtered K --gpu`). Drawn a call a draw from the atlas, the same
 * short runs took less than either.
 */
const MIN_RUN = 16;
/**
 * The most draws a run passes in uniforms rather than through the table
 * texture, whose upload costs Chrome a few µs more a run: 40 rows of 5
 * vectors leave room for Pixi's, and for what a driver keeps for itself,
 * under the 256 every WebGL 2 allows a vertex shader.
 */
const SHORT_RUN = 40;
/** Floats a vertex of a context's packed geometry: position, UV, colour, texture and rounding. */
const VERTEX_FLOATS = 6;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
/** Atlas vertices dropped contexts may leave as holes before it is packed again. */
const ATLAS_SLACK = 1 << 16;
/** The fewest vertices the atlas holds room for, and its indices thrice that. */
const ATLAS_LEAST = 4096;
/**
 * How much the atlas grows by when no free stretch fits a context, and how
 * much room it is given over its live vertices as it starts again: doubled,
 * as what is freed is taken again, so that a scene still adding contexts
 * grows it a few times, not every few frames. When the atlas only ever
 * added at the end, a crowded room's held 96 MB of vertices and 48 MB of
 * indices with a third and a fifth of them in use, and grew by half.
 */
const ATLAS_GROWTH = 2;

let enabled = true;
let minRun = MIN_RUN;
let loopShort = true;

/**
 * Draw Graphics alone through the table, or not, from the next frame: a
 * switch to time the two apart. Runs already built draw through Pixi's
 * pipe while it is off; a group built while it was off draws alone until
 * it is built again. `shortest` is the fewest draws a run makes as one
 * multi-draw, MIN_RUN by default: the tests have the table draw every run
 * so with 1, and the bench times others. A shorter run is drawn from the
 * atlas a call a draw, its rows passed in uniforms, or with `loop` false
 * by Pixi's pipe; so is it with `shortest` past SHORT_RUN + 1, as the
 * uniforms hold no more rows.
 */
export function setTransformTable(on: boolean, shortest = MIN_RUN, loop = true): void {
  enabled = on;
  minRun = shortest;
  loopShort = loop;
}

/**
 * The vertex shader, reading a draw's row from the table texture or, for a
 * short run (SHORT_RUN), from a uniform array laid out as the table's rows.
 * Under a Flash colour transform it passes the straight colour as the
 * colour batcher packs it (render/color.ts, straight): the fill's times the
 * Graphics' own tint, rounded to a byte, and its alpha truncated to one; Pixi's group
 * colour is left out, as the transform includes every ancestor's.
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
    ? `uniform vec4 uRows[${SHORT_RUN * ROW_TEXELS}];
uniform int uFirst;`
    : `uniform highp sampler2D uTable;
uniform float uBase;`
}
out vec4 vColor;
flat out float vFlash;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
${
  short
    ? `  int at = (uFirst + gl_DrawID) * ${ROW_TEXELS};
  vec4 m = uRows[at];
  vec4 t = uRows[at + 1];
  vec4 tint = uRows[at + 2];
  vec4 mul = uRows[at + 3];
  vec4 add = uRows[at + 4];`
    : `  int row = int(uBase) + gl_DrawID;
  ivec2 at = ivec2((row & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, row >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uTable, at, 0);
  vec4 t = texelFetch(uTable, at + ivec2(1, 0), 0);
  vec4 tint = texelFetch(uTable, at + ivec2(2, 0), 0);
  vec4 mul = texelFetch(uTable, at + ivec2(3, 0), 0);
  vec4 add = texelFetch(uTable, at + ivec2(4, 0), 0);`
}
  mat3 modelMatrix = mat3(m.x, m.y, 0.0, m.z, m.w, 0.0, t.x, t.y, 1.0);
  mat3 modelViewProjectionMatrix = uProjectionMatrix * uWorldTransformMatrix * modelMatrix;
  gl_Position = vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vFlash = t.z;
  vMul = mul;
  vAdd = add;
  if (t.z > 0.5) {
    // A byte's product is never half way between two, so the rounding is the batcher's.
    vColor = vec4(
      floor(aColor.rgb * tint.rgb * 255.0 + 0.5),
      floor(aColor.a * tint.a * 255.0 + 0.001)
    ) / 255.0;
  } else {
    // As Pixi's graphics shader: the premultiplied fill times the group's tint and the world's.
    vColor = vec4(1.0);
    vColor *= vec4(aColor.rgb * aColor.a, aColor.a);
    vColor *= tint;
    vColor *= uWorldColorAlpha;
  }
}
`;

/** Under a colour transform, as the colour batcher's shader: applied to straight colour, clamped. */
const fragment = `#version 300 es
in vec4 vColor;
flat in float vFlash;
flat in vec4 vMul;
flat in vec4 vAdd;
out vec4 finalColor;

void main(void) {
  if (vFlash > 0.5) {
    vec4 c = clamp(vColor * vMul + vAdd, 0.0, 1.0);
    finalColor = vec4(c.rgb * c.a, c.a);
  } else {
    finalColor = vColor;
  }
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
  /** Its batches, as Pixi's instruction set lists them. */
  instructions: { instructionSize: number; instructions: ArrayLike<Instruction> };
}

/** Where a context's batches lie in the atlas: each one's index count and first byte. */
export interface Placed {
  vertices: number;
  indices: number;
  /** Its first vertex and first index in the atlas. */
  vertexStart: number;
  indexStart: number;
  counts: number[];
  offsets: number[];
}

/**
 * Where an atlas' vertices and indices are kept: the GPU's buffers, which
 * the table writes into and grows there (TablePipe), with no copy on the CPU.
 */
export interface AtlasStore {
  /** Room for `vertices` and `indices`, the first `keptVertices` and `keptIndices` kept. */
  resize(vertices: number, indices: number, keptVertices: number, keptIndices: number): void;
  /** `floats` of `data`, from float `from`, written from vertex `at` on. */
  writeVertices(at: number, data: Float32Array, from: number, floats: number): void;
  /** `count` of `data`, from `from`, written from index `at` on. */
  writeIndices(at: number, data: Uint32Array, from: number, count: number): void;
}

/**
 * Vertices placed and not yet written are gathered in arrays of up to this
 * many, and their indices in up to thrice as many, written in a call for
 * each stretch of the atlas they fill: so a frame that places hundreds of
 * contexts makes a few writes, not hundreds, and keeps no more than these
 * on the CPU, some 2 MB at most.
 */
const STAGED_VERTICES = 1 << 16;
const STAGED_FLOATS = STAGED_VERTICES * VERTEX_FLOATS;
const STAGED_INDICES = STAGED_VERTICES * 3;

/**
 * The free stretches of a buffer that ranges are placed in and given back
 * to: each place taken from the free stretch that fits it most closely,
 * else from the top, past which all is free. A stretch given back joins
 * its free neighbours, and one that reaches the top lowers it.
 */
export class Ranges {
  /** Where ranges end at most: past it all is free. */
  top = 0;
  /** The free units below the top. */
  free = 0;
  /** The free stretches below the top, by where they start. */
  private readonly starts: number[] = [];
  private readonly sizes: number[] = [];

  /** Where `size` units start, taken from the closest fit or the top; -1 if the top would pass `capacity`. */
  take(size: number, capacity: number): number {
    let best = -1;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.sizes.length; i++) {
      const free = this.sizes[i];
      if (free >= size && free < bestSize) {
        best = i;
        bestSize = free;
        if (free === size) {
          break;
        }
      }
    }

    if (best >= 0) {
      const start = this.starts[best];
      if (bestSize === size) {
        this.starts.splice(best, 1);
        this.sizes.splice(best, 1);
      } else {
        this.starts[best] += size;
        this.sizes[best] -= size;
      }

      this.free -= size;
      return start;
    }

    if (this.top + size > capacity) {
      return -1;
    }

    const start = this.top;
    this.top += size;
    return start;
  }

  /** `size` units from `start` free again. */
  give(start: number, size: number): void {
    if (size <= 0) {
      return;
    }

    // The first stretch after it, found by halves.
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] < start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    let end = start + size;
    this.free += size;
    const before = lo - 1;
    if (before >= 0 && this.starts[before] + this.sizes[before] === start) {
      start = this.starts[before];
      size += this.sizes[before];
      this.starts.splice(before, 1);
      this.sizes.splice(before, 1);
      lo--;
    }

    if (lo < this.starts.length && this.starts[lo] === end) {
      size += this.sizes[lo];
      end += this.sizes[lo];
      this.starts.splice(lo, 1);
      this.sizes.splice(lo, 1);
    }

    if (end === this.top) {
      // Free up to the top: no longer a stretch, the top comes down to it.
      this.top = start;
      this.free -= size;
      return;
    }

    this.starts.splice(lo, 0, start);
    this.sizes.splice(lo, 0, size);
  }

  /** Every range given back at once. */
  clear(): void {
    this.top = 0;
    this.free = 0;
    this.starts.length = 0;
    this.sizes.length = 0;
  }

  /** The free stretches below the top. */
  get stretches(): number {
    return this.starts.length;
  }
}

const atlases = new Set<Atlas>();

/**
 * The local vertices of every context the table has drawn, in one buffer
 * with one index buffer, absolute: each context's are copied in once, as
 * Pixi packed them for it, and stay until it is rebuilt or destroyed. What
 * those leave free is taken again by the contexts placed after, each in
 * the free stretch that fits it best (Ranges), so that a scene whose
 * contexts come and go, as morphs, rescaled lines and redrawn Graphics do
 * every frame, stays within its buffers: when it only ever added at the
 * end, a busy scene grew them by half every few frames, each growth a new
 * buffer and a copy of the old on the GPU. Only holes no context fits
 * that outweigh the live vertices twice over are reclaimed by packing
 * again (compact). They are kept on the GPU alone: a crowded room's atlas
 * held some 130 MB on the CPU as well, which only a lost context, after
 * which it starts again anyway, could have used.
 */
export class Atlas {
  /** The vertices and indices the store has room for. */
  capacity = ATLAS_LEAST;
  indexCapacity = ATLAS_LEAST * 3;
  /** What the atlas has done, for a test or a probe to read. */
  readonly stats = { placed: 0, reused: 0, released: 0, grown: 0, compacted: 0 };
  /** Whether the store has room made for the capacity: not as it starts, shrinks or is lost. */
  private allocated = false;
  private readonly vertexRanges = new Ranges();
  private readonly indexRanges = new Ranges();
  /**
   * The ranges of contexts released this frame, given back between frames
   * (compact): a run gathered may still read where its contexts lay until
   * it is drawn, so nothing is written there before.
   */
  private releasedRanges: number[] = [];
  /** What is staged, in arrays grown as a frame places more, up to STAGED_VERTICES. */
  private staged = new Float32Array(0);
  private stagedIndices = new Uint32Array(0);
  private stagedFloats = 0;
  private stagedCount = 0;
  /** Where what is staged goes: an atlas vertex, a staged float and floats, a stretch a write. */
  private readonly vertexWrites: number[] = [];
  /** An atlas index, a staged index and a count, a stretch a write. */
  private readonly indexWrites: number[] = [];
  private readonly placed = new Map<object, Placed | null>();
  private live = 0;
  private liveIndices = 0;
  /** The id of a texture that is no texture, which alone the table draws. */
  private readonly white: number;
  private readonly store: AtlasStore;

  constructor(white: number, store: AtlasStore) {
    this.white = white;
    this.store = store;
    atlases.add(this);
  }

  /** The vertices and indices up to the last placed: what the store must keep as it grows. */
  get vertexCount(): number {
    return this.vertexRanges.top;
  }

  get indexCount(): number {
    return this.indexRanges.top;
  }

  /** Where `key`'s batches lie: null if the table cannot draw them, undefined if not yet placed. */
  where(key: object): Placed | null | undefined {
    return this.placed.get(key);
  }

  /**
   * Where `key`'s batches lie, `packed` copied in first if they are not
   * there yet; null if the table cannot draw them. What is copied in is
   * staged, and the store has it once send is called.
   */
  place(key: object, packed: Packed): Placed | null {
    const known = this.placed.get(key);
    if (known !== undefined) {
      return known;
    }

    const { batcher, instructions } = packed;
    const counts: number[] = [];
    const starts: number[] = [];
    for (let i = 0; i < instructions.instructionSize; i++) {
      const batch = instructions.instructions[i] as Batch;
      const textures = batch.textures;
      let flat = batch.topology === "triangle-list";
      for (let k = 0; k < textures.count; k++) {
        flat &&= textures.textures[k].uid === this.white;
      }

      if (!flat) {
        this.placed.set(key, null);
        return null;
      }

      if (batch.size) {
        counts.push(batch.size);
        starts.push(batch.start);
      }
    }

    if (counts.length === 0) {
      this.placed.set(key, null);
      return null;
    }

    const vertexCount = batcher.attributeSize / VERTEX_FLOATS;
    const indexCount = batcher.indexSize;
    const placed: Placed = {
      vertices: vertexCount,
      indices: indexCount,
      vertexStart: 0,
      indexStart: 0,
      counts,
      offsets: starts,
    };
    this.reserve(placed);
    for (let i = 0; i < starts.length; i++) {
      starts[i] = (placed.indexStart + starts[i]) * 4;
    }

    this.copyIn(placed, batcher.attributeBuffer.float32View, batcher.indexBuffer);
    this.live += vertexCount;
    this.liveIndices += indexCount;
    this.stats.placed++;
    this.placed.set(key, placed);
    return placed;
  }

  /** `key`'s context rebuilt or destroyed: its ranges are free again from the next frame. */
  release(key: object): void {
    const placed = this.placed.get(key);
    if (placed === undefined) {
      return;
    }

    this.placed.delete(key);
    if (placed) {
      this.live -= placed.vertices;
      this.liveIndices -= placed.indices;
      this.releasedRanges.push(
        placed.vertexStart,
        placed.vertices,
        placed.indexStart,
        placed.indices,
      );
      this.stats.released++;
    }
  }

  /**
   * Between frames, as a run's draws read where their contexts lie until
   * it is drawn: the ranges released since free for the next to take, and
   * the atlas packed again from scratch if its holes pass ATLAS_SLACK and
   * twice the live vertices or indices, which no context placed since
   * could fill.
   */
  compact(): void {
    const released = this.releasedRanges;
    for (let i = 0; i < released.length; i += 4) {
      this.vertexRanges.give(released[i], released[i + 1]);
      this.indexRanges.give(released[i + 2], released[i + 3]);
    }

    released.length = 0;
    const vertexHoles = this.vertexRanges.free;
    const indexHoles = this.indexRanges.free;
    if (
      (vertexHoles > ATLAS_SLACK && vertexHoles > 2 * this.live) ||
      (indexHoles > 3 * ATLAS_SLACK && indexHoles > 2 * this.liveIndices)
    ) {
      this.stats.compacted++;
      this.clear();
    }
  }

  /**
   * Forget every context, to be copied in again as each is next drawn: in
   * a store cut down to what was live, with room to grow, when that needs
   * less than half its capacity. Smaller reductions would undo the next
   * growth as animated contexts leave holes and come back again.
   */
  clear(): void {
    const vertices = Math.ceil(Math.max(this.live * ATLAS_GROWTH, ATLAS_LEAST));
    const indices = Math.ceil(Math.max(this.liveIndices * ATLAS_GROWTH, ATLAS_LEAST * 3));
    if (vertices * 2 < this.capacity) {
      this.capacity = vertices;
      this.allocated = false;
    }

    if (indices * 2 < this.indexCapacity) {
      this.indexCapacity = indices;
      this.allocated = false;
    }

    this.placed.clear();
    this.vertexRanges.clear();
    this.indexRanges.clear();
    this.releasedRanges.length = 0;
    this.unstage();
    this.live = 0;
    this.liveIndices = 0;
  }

  /** The store's buffers were lost with their context: every context is copied in again as drawn. */
  lost(): void {
    this.clear();
    this.allocated = false;
  }

  /** Write what was staged into the store, room made for it first if the store has none yet. */
  send(): void {
    this.allocate();
    const vertexWrites = this.vertexWrites;
    for (let i = 0; i < vertexWrites.length; i += 3) {
      this.store.writeVertices(
        vertexWrites[i],
        this.staged,
        vertexWrites[i + 1],
        vertexWrites[i + 2],
      );
    }

    const indexWrites = this.indexWrites;
    for (let i = 0; i < indexWrites.length; i += 3) {
      this.store.writeIndices(
        indexWrites[i],
        this.stagedIndices,
        indexWrites[i + 1],
        indexWrites[i + 2],
      );
    }

    this.unstage();
  }

  destroy(): void {
    this.clear();
    atlases.delete(this);
  }

  private unstage(): void {
    this.vertexWrites.length = 0;
    this.indexWrites.length = 0;
    this.stagedFloats = 0;
    this.stagedCount = 0;
  }

  private allocate(): void {
    if (!this.allocated) {
      // Only ever with nothing sent: as the atlas starts, starts again smaller, or is lost.
      this.store.resize(this.capacity, this.indexCapacity, 0, 0);
      this.allocated = true;
    }
  }

  /**
   * Stage `placed`'s vertices and indices, the indices offset by where its
   * vertices start; written straight into the store if they would not fit
   * the stage, what was staged sent first if they would not fit beside it.
   */
  private copyIn(placed: Placed, vertices: Float32Array, indices: ArrayLike<number>): void {
    const floats = placed.vertices * VERTEX_FLOATS;
    const count = placed.indices;
    const base = placed.vertexStart;
    if (this.stagedFloats + floats > STAGED_FLOATS || this.stagedCount + count > STAGED_INDICES) {
      this.send();
    }

    if (floats > STAGED_FLOATS || count > STAGED_INDICES) {
      // Larger than the stage alone: written as it comes, its indices offset in an array of its own.
      const offset = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        offset[i] = indices[i] + base;
      }

      this.store.writeVertices(base, vertices, 0, floats);
      this.store.writeIndices(placed.indexStart, offset, 0, count);
      return;
    }

    const from = this.stagedFloats;
    const at = this.stagedCount;
    this.stage(from + floats, at + count);
    this.staged.set(vertices.subarray(0, floats), from);
    for (let i = 0; i < count; i++) {
      this.stagedIndices[at + i] = indices[i] + base;
    }

    this.stagedFloats += floats;
    this.stagedCount += count;
    addWrite(this.vertexWrites, base, from, floats, VERTEX_FLOATS);
    addWrite(this.indexWrites, placed.indexStart, at, count, 1);
  }

  /** Staging arrays of at least `floats` and `count`, doubled as need be, what they stage kept. */
  private stage(floats: number, count: number): void {
    if (floats > this.staged.length) {
      const grown = new Float32Array(
        Math.min(STAGED_FLOATS, Math.max(floats, this.staged.length * 2, 4096 * VERTEX_FLOATS)),
      );
      grown.set(this.staged.subarray(0, this.stagedFloats));
      this.staged = grown;
    }

    if (count > this.stagedIndices.length) {
      const grown = new Uint32Array(
        Math.min(STAGED_INDICES, Math.max(count, this.stagedIndices.length * 2, 4096 * 3)),
      );
      grown.set(this.stagedIndices.subarray(0, this.stagedCount));
      this.stagedIndices = grown;
    }
  }

  /**
   * Ranges in the store for `placed`'s vertices and indices, taken where
   * they fit best; the store doubled, or grown to what they need, if they
   * fit nowhere, what it holds kept by the GPU's own copy.
   */
  private reserve(placed: Placed): void {
    this.allocate();
    const vertices = this.vertexRanges;
    const indices = this.indexRanges;
    const freeBefore = vertices.free;
    let vertexStart = vertices.take(placed.vertices, this.capacity);
    let indexStart = indices.take(placed.indices, this.indexCapacity);
    if (vertexStart < 0 || indexStart < 0) {
      // What was staged goes first, to be kept as the store grows.
      this.send();
      if (vertexStart < 0) {
        this.capacity = Math.max(
          vertices.top + placed.vertices,
          Math.ceil(this.capacity * ATLAS_GROWTH),
        );
      }

      if (indexStart < 0) {
        this.indexCapacity = Math.max(
          indices.top + placed.indices,
          Math.ceil(this.indexCapacity * ATLAS_GROWTH),
        );
      }

      // What either took at the top for this context holds nothing yet, to be copied.
      const keptVertices =
        vertexStart >= 0 && vertexStart + placed.vertices === vertices.top
          ? vertexStart
          : vertices.top;
      const keptIndices =
        indexStart >= 0 && indexStart + placed.indices === indices.top ? indexStart : indices.top;
      this.store.resize(this.capacity, this.indexCapacity, keptVertices, keptIndices);
      this.stats.grown++;
      if (vertexStart < 0) {
        vertexStart = vertices.take(placed.vertices, this.capacity);
      }

      if (indexStart < 0) {
        indexStart = indices.take(placed.indices, this.indexCapacity);
      }
    }

    if (vertices.free < freeBefore) {
      this.stats.reused++;
    }

    placed.vertexStart = vertexStart;
    placed.indexStart = indexStart;
  }
}

/**
 * A write of `length` staged from `from` to `at` in the atlas, in units of
 * `unit`, added to `writes`, or joined to the last if it goes on from it
 * there and in the stage.
 */
function addWrite(writes: number[], at: number, from: number, length: number, unit: number): void {
  const last = writes.length - 3;
  if (
    last >= 0 &&
    writes[last] + writes[last + 2] / unit === at &&
    writes[last + 1] + writes[last + 2] === from
  ) {
    writes[last + 2] += length;
    return;
  }

  writes.push(at, from, length);
}

/**
 * A context's GPU data reset, as it is built again and as it is destroyed
 * (render/hooks.ts): its place in each atlas goes then.
 */
export function releaseFromAtlases(gpu: GpuGraphicsContext): void {
  for (const atlas of atlases) {
    atlas.release(gpu);
  }
}

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

type Drawn = Graphics & { _roundPixels: number };
/** A Graphics as render/color.ts marks one under a Flash colour transform. */
type Colored = Graphics & { flashColor?: ColorTransform | null };

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
  /** Where the short shader's program, as last linked, takes its rows and first row, and that row. */
  private rows: {
    program: WebGLProgram;
    location: WebGLUniformLocation | null;
    first: WebGLUniformLocation | null;
    firstValue: number;
  } | null = null;
  private readonly uniforms = new UniformGroup({ uBase: { value: 0, type: "f32" } });
  private readonly state = State.for2d();
  /** The next row free this frame. */
  private cursor = 0;
  // Made for WebGL alone, the only renderer that draws the table. The
  // table never shrinks from its peak, a crowded scene's rows; the atlas
  // shrinks when its live geometry needs substantially less room.
  private table!: BufferImageSource;
  private atlas!: Atlas;
  private attributes!: Buffer;
  private indexBuffer!: Buffer;
  /** The bytes the GPU's copies of the atlas' buffers were last made to hold. */
  private vertexBytes = 0;
  private indexBytes = 0;
  private geometry!: Geometry;
  /** The run being gathered: its first row, blend mode, and its draws' counts and offsets. */
  private counts = new Int32Array(1024);
  private offsets = new Int32Array(1024);
  private draws = 0;
  private runBase = 0;
  private runBlend = "";
  /**
   * The Graphics the run gathered, for Pixi's pipe to draw if it is too
   * short for a multi-draw and the table leaves such runs to it (loops).
   */
  private segment: Graphics[] = [];

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    if (renderer.type !== RendererType.WEBGL) {
      return;
    }

    this.table = tableSource(16);
    // Placeholders: what the buffers hold lives on the GPU alone, written there by the atlas.
    this.attributes = new Buffer({
      data: new Float32Array(0),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    this.indexBuffer = new Buffer({
      data: new Uint32Array(0),
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    // Not to be collected unused for a while, as Pixi would: nothing could upload them again.
    this.attributes.autoGarbageCollect = false;
    this.indexBuffer.autoGarbageCollect = false;
    this.atlas = new Atlas(Texture.WHITE.source.uid, {
      resize: (vertices, indices, keptVertices, keptIndices) => {
        const buffers = this.renderer.buffer;
        if (vertices * VERTEX_BYTES !== this.vertexBytes) {
          this.vertexBytes = vertices * VERTEX_BYTES;
          buffers.resizeOnGpu(this.attributes, this.vertexBytes, keptVertices * VERTEX_BYTES);
        }

        if (indices * 4 !== this.indexBytes) {
          this.indexBytes = indices * 4;
          buffers.resizeOnGpu(this.indexBuffer, this.indexBytes, keptIndices * 4);
        }
      },
      writeVertices: (at, data, from, floats) =>
        this.renderer.buffer.writeOnGpu(this.attributes, at * VERTEX_BYTES, data, from, floats),
      writeIndices: (at, data, from, count) =>
        this.renderer.buffer.writeOnGpu(this.indexBuffer, at * 4, data, from, count),
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
    this.vertexBytes = 0;
    this.indexBytes = 0;
    this.atlas.lost();
  }

  prerender(): void {
    this.cursor = 0;
    this.atlas.compact();
  }

  /** Whether the table draws for this renderer: switched on, and WebGL 2 with multi-draw. */
  get active(): boolean {
    return enabled && this.multi !== null;
  }

  /** Whether a run too short for a multi-draw is drawn from the atlas, a call a draw. */
  private get loops(): boolean {
    return loopShort && minRun <= SHORT_RUN + 1;
  }

  add(graphics: Graphics, instructionSet: InstructionSet): void {
    addToRun(graphics, instructionSet);
  }

  execute(instruction: TableInstruction): void {
    const renderer = this.renderer;
    const graphicsPipe = renderer.renderPipes.graphics;
    const contexts = renderer.graphicsContext;
    const roundAll = renderer._roundPixels;
    // Switched off, a context restored without the extension, or, short
    // runs left to it, a run that cannot reach minRun draws, before a row
    // is written: Pixi's pipe draws it.
    if (!this.active || (!this.loops && this.mostDraws(instruction, contexts) < minRun)) {
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

      let place =
        gpu.isBatchable || context.customShader || roundAll | graphics._roundPixels
          ? null
          : this.atlas.where(gpu);
      if (place === undefined) {
        // What Pixi packed is read only to be copied in, packed again if it was let go of.
        place = this.atlas.place(gpu, contexts.getContextRenderDataOnCpu(context));
      }

      if (!place || this.cursor + place.counts.length > this.maxRows) {
        this.flush();
        graphicsPipe.execute(graphics);
        continue;
      }

      if (graphics.groupBlendMode !== this.runBlend) {
        this.flush();
        this.runBlend = graphics.groupBlendMode;
      }

      if (!this.loops) {
        this.segment.push(graphics);
      }

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
  private mostDraws(instruction: TableInstruction, contexts: GraphicsContextSystem): number {
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
    const ct = (graphics as Colored).flashColor;
    if (ct) {
      // Its own tint and alpha, straight, as the colour batcher's: a glyph's colour.
      const bgr = graphics.localColor;
      out[at + 6] = 1;
      out[at + 8] = (bgr & 0xff) / 255;
      out[at + 9] = ((bgr >> 8) & 0xff) / 255;
      out[at + 10] = ((bgr >> 16) & 0xff) / 255;
      out[at + 11] = graphics.localAlpha;
      out[at + 12] = ct.rMul;
      out[at + 13] = ct.gMul;
      out[at + 14] = ct.bMul;
      out[at + 15] = ct.aMul;
      out[at + 16] = ct.rAdd / 255;
      out[at + 17] = ct.gAdd / 255;
      out[at + 18] = ct.bAdd / 255;
      out[at + 19] = ct.aAdd / 255;
    } else {
      out[at + 6] = 0;
      color32BitToUniform(graphics.groupColorAlpha, out, at + 8);
    }

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
   * uploaded if not. A run too short to repay a multi-draw is drawn from
   * the atlas a call a draw, its rows passed in uniforms at once and each
   * draw told its row: the atlas' buffers bound once, where Pixi's pipe
   * binds each context's own and sets each Graphics' uniforms. Or, with
   * that switched off, its Graphics go through Pixi's pipe.
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
    const loop = draws < minRun;
    if (loop && !this.loops) {
      const graphicsPipe = renderer.renderPipes.graphics;
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

    this.atlas.send();

    const shader = short ? this.shortRunShader() : this.tableShader();
    shader.groups[0] = renderer.globalUniforms.bindGroup;
    this.state.blendMode = this.runBlend as State["blendMode"];
    renderer.state.set(this.state);
    renderer.shader.bind(shader);
    const rows = short ? this.passRows(shader) : null;

    renderer.geometry.bind(this.geometry, shader.glProgram);
    const gl = renderer.gl;
    if (loop && rows) {
      // gl_DrawID is 0 in a draw of its own: uFirst names its row.
      for (let i = 0; i < draws; i++) {
        this.first(rows, i);
        gl.drawElements(gl.TRIANGLES, this.counts[i], gl.UNSIGNED_INT, this.offsets[i]);
      }
    } else {
      if (rows) {
        this.first(rows, 0);
      }

      this.multi.multiDrawElementsWEBGL(
        gl.TRIANGLES,
        this.counts,
        0,
        gl.UNSIGNED_INT,
        this.offsets,
        0,
        draws,
      );
    }

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

  /** Pass the run's rows to the short shader, bound: Pixi knows nothing of its uRows and uFirst. */
  private passRows(shader: Shader): NonNullable<TablePipe["rows"]> {
    const gl = this.renderer.gl;
    const program = this.renderer.shader._getProgramData(shader.glProgram).program;
    if (this.rows?.program !== program) {
      this.rows = {
        program,
        location: gl.getUniformLocation(program, "uRows"),
        first: gl.getUniformLocation(program, "uFirst"),
        firstValue: 0,
      };
    }

    const floats = ROW_TEXELS * 4;
    gl.uniform4fv(
      this.rows.location,
      this.table.resource as Float32Array,
      this.runBase * floats,
      this.draws * floats,
    );
    return this.rows;
  }

  /** Set the short shader's first row, bound, if it is not that already. */
  private first(rows: NonNullable<TablePipe["rows"]>, value: number): void {
    if (rows.firstValue !== value) {
      rows.firstValue = value;
      this.renderer.gl.uniform1i(rows.first, value);
    }
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
    // Bound as Pixi binds, a new table allocated and uploaded whole then, and to the active unit,
    // which a render pass may have moved to unbind a back texture: the upload must go to 0.
    renderer.texture.bindForUpload(this.table, 0);

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
