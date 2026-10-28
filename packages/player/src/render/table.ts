// Graphics drawn alone, a shape's fills and lines, drawn many to a call
// (docs/architecture.md, "Rendering"). Each draws a shared context's
// geometry under its own transform, a draw call apiece: in a crowded room,
// thousands a frame, each binding the context's buffers and setting its
// uniforms. Here the contexts' local vertices go once into an atlas, and a
// run of such Graphics is one instanced draw call: each index' vertex kept
// in a texture, the expanded atlas, which the vertex shader fetches, an
// instance a chunk of a batch's indices, the chunk naming them and the
// Graphics' row of a float texture, its transform and tint (TablePipe,
// pulled draws). A frame writes the rows and chunks of every run and
// uploads them at once, and no vertex moves. Where WebGL 2 lacks float
// framebuffers, on a renderer that draws on the CPU (SOFTWARE), or
// switched off to time the two, the atlas is a vertex
// and an index buffer, and a run is one multi-draw of their index ranges,
// each draw reading its row by gl_DrawID, or from a uniform array for a
// short run; a run too short to repay its multi-draw, as filters leave, is
// drawn from the atlas a call a draw, each told its row: its buffers bound
// once for the run, where Pixi's pipe binds each context's own and sets
// each Graphics' uniforms. Chrome's GPU process pays for each draw of a
// multi-draw as for a call, which a pulled draw is not. What the
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
  type Container,
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
  Sprite,
  State,
  Texture,
  type TextureSource,
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

/**
 * Texels a line of the expanded atlas' texture, and of the pulled draws'
 * chunks: WebGL 2's least MAX_TEXTURE_SIZE.
 */
const ATLAS_WIDTH = 2048;
/**
 * Past this a float no longer holds every integer: the most indices the
 * expanded atlas holds, as the chunks name them in floats.
 */
const EXACT = 1 << 24;
/**
 * Vertices an instance of a pulled draw: a chunk of a batch's, a whole
 * number of triangles, the last of a batch's chunks drawn short. Its
 * vertices past the batch's end are dropped, which costs the GPU little
 * against finding a vertex' batch among thousands (on `bench.ts --rig 400
 * --gpu`, a search by halves took GL's time from 13 to 15-17 ms on an
 * integrated GPU).
 */
const CHUNK = 96;

let enabled = true;
let minRun = MIN_RUN;
let loopShort = true;
/** Pulled draws asked for or refused (setTransformTable); undefined leaves it to the GPU. */
let pullWanted: boolean | undefined;
/**
 * A renderer that draws on the CPU, by its name (WARP's is "Microsoft
 * Basic Render Driver"): pulled draws took SwiftShader twice the GL time
 * of the multi-draws, so it makes those.
 */
const SOFTWARE = /swiftshader|llvmpipe|software|basic render driver/i;
/**
 * What the table has drawn: its draw calls, and the draws of contexts'
 * batches they made; and the times its atlases grew.
 */
const drawn = { calls: 0, draws: 0, grown: 0 };

/**
 * Draw Graphics alone through the table, or not, from the next frame: a
 * switch to time the two apart. Runs already built draw through Pixi's
 * pipe while it is off; a group built while it was off draws alone until
 * it is built again. With `pull` true, a run is a draw call whose vertex
 * shader fetches its vertices (TablePipe, pulled draws), where WebGL 2 has
 * float framebuffers; with false, the table makes the multi-draws it made
 * before them, which the rest is about; left out, pulled draws on a GPU
 * and multi-draws on a renderer that draws on the CPU (SOFTWARE).
 * `shortest` is the fewest draws a run makes as one multi-draw, MIN_RUN by
 * default: the tests have the table draw every run so with 1, and the
 * bench times others. A shorter run is drawn from the atlas a call a draw,
 * its rows passed in uniforms, or with `loop` false by Pixi's pipe; so is
 * it with `shortest` past SHORT_RUN + 1, as the uniforms hold no more
 * rows.
 */
export function setTransformTable(
  on: boolean,
  shortest = MIN_RUN,
  loop = true,
  pull?: boolean,
): void {
  enabled = on;
  minRun = shortest;
  loopShort = loop;
  pullWanted = pull;
}

/**
 * What the table has drawn since the page loaded: draw calls, and the
 * contexts' batches drawn in them; and the times its atlases grew.
 */
export function transformTableDrawn(): Readonly<{ calls: number; draws: number; grown: number }> {
  return drawn;
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
${placed}}
`;

/** A vertex placed by its row, m t tint mul add, and coloured: the same for every program. */
const placed = `  mat3 modelMatrix = mat3(m.x, m.y, 0.0, m.z, m.w, 0.0, t.x, t.y, 1.0);
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
`;

/**
 * The vertex shader of a pulled draw, which draws a run in one call with no
 * attributes, an instance a chunk of a batch's vertices: the chunk's texel
 * names its row, where its indices start in the expanded atlas and how many
 * it has; a vertex past them is put outside the clip volume, its triangle
 * with it. The index' vertex, as the expanded atlas keeps it, is placed and
 * coloured as the other programs place and colour an attribute's, its
 * colour's bytes normalized as GL normalizes unorm8x4.
 */
const pulledVertex = `#version 300 es
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform highp sampler2D uTable;
uniform highp sampler2D uAtlas;
uniform highp sampler2D uChunks;
uniform float uFirst;
out vec4 vColor;
flat out float vFlash;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
  int chunk = int(uFirst) + gl_InstanceID;
  vec4 c = texelFetch(uChunks, ivec2(chunk & ${ATLAS_WIDTH - 1}, chunk >> ${Math.log2(ATLAS_WIDTH)}), 0);
  vColor = vec4(0.0);
  vFlash = 0.0;
  vMul = vec4(0.0);
  vAdd = vec4(0.0);
  if (float(gl_VertexID) >= c.z) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  int index = int(c.y) + gl_VertexID;
  vec4 a = texelFetch(uAtlas, ivec2(index & ${ATLAS_WIDTH - 1}, index >> ${Math.log2(ATLAS_WIDTH)}), 0);
  vec2 aPosition = a.xy;
  // Each byte pair split exactly: a whole number below 65,536 over 256, floored.
  vec2 upper = floor(a.zw / 256.0);
  vec4 aColor = vec4(a.z - upper.x * 256.0, upper.x, a.w - upper.y * 256.0, upper.y) / 255.0;
  int row = int(c.x);
  ivec2 at = ivec2((row & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, row >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uTable, at, 0);
  vec4 t = texelFetch(uTable, at + ivec2(1, 0), 0);
  vec4 tint = texelFetch(uTable, at + ivec2(2, 0), 0);
  vec4 mul = texelFetch(uTable, at + ivec2(3, 0), 0);
  vec4 add = texelFetch(uTable, at + ivec2(4, 0), 0);
${placed}}
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

/**
 * Step 0 of docs/renderer.md, a throwaway prototype: with it on, every
 * Graphics whose fills the atlas can hold, batched copies included, and
 * every plain Sprite go into runs of their own (proto runs) in place of
 * Pixi's batches and the table's runs, and a run of one blend mode is
 * one pulled draw of up to `units` textures. `reset` resets Pixi's GL
 * state after each run, the blunt handoff, to time it.
 */
const proto = {
  on: false,
  units: 8,
  reset: false,
  sprites: true,
  graphics: true,
  retain: true,
};
/** What proto runs drew, and what planning them cost, since the page loaded. */
const protoDrawn = {
  runs: 0,
  calls: 0,
  chunks: 0,
  sprites: 0,
  graphics: 0,
  textures: 0,
  planMs: 0,
  resets: 0,
  /** Runs planned again, and drawn as kept from an earlier render (retain). */
  planned: 0,
  kept: 0,
  /** Items it could not draw: a context the atlas would not take, or rows past the most. */
  missed: 0,
};
const PROTO_UNITS = 16;
/** Texels a sprite's record: its rectangle, then its texture's uvs, two corners a texel. */
const SPRITE_TEXELS = 3;
const SPRITES_A_LINE = 256;

/** Switch the prototype, from the next build of each render group (rebuildGroups). */
export function setProto(options: Partial<typeof proto>): void {
  Object.assign(proto, options);
  proto.units = Math.max(1, Math.min(PROTO_UNITS, proto.units));
}

export function protoOptions(): Readonly<typeof proto> {
  return proto;
}

export function protoStats(): Readonly<typeof protoDrawn> {
  return protoDrawn;
}

/** Every render group under `root` built again, as a switch of the prototype needs. */
export function rebuildGroups(root: Container): void {
  const group = (root as { renderGroup?: { structureDidChange: boolean } | null }).renderGroup;
  if (group) {
    group.structureDidChange = true;
  }

  for (const child of root.children) {
    rebuildGroups(child);
  }
}

/** A container the prototype draws: a Graphics or a Sprite, marked as it was last added. */
type ProtoItem = Container & {
  $proto?: boolean;
  $protoRun?: TableInstruction;
  isRenderable: boolean;
};

export function isProtoItem(item: Container): boolean {
  return (item as ProtoItem).$proto === true;
}

/** `item`, the prototype's, changed: its run is planned again (retain). */
export function protoChanged(item: Container): void {
  const run = (item as ProtoItem).$protoRun;
  if (run) {
    run.protoDirty = true;
  }
}

/**
 * Whether the prototype takes `graphics`: switched on, no custom shader or
 * rounding, and its context's batches flat triangles, as the atlas takes.
 */
export function protoTakesGraphics(graphics: Graphics, renderer: WebGLRenderer): boolean {
  if (!proto.on || !proto.graphics || renderer._roundPixels | (graphics as Drawn)._roundPixels) {
    return false;
  }

  // The context it shows, built as Pixi's pipe would build it.
  const context = graphics.context;
  if (context.customShader) {
    return false;
  }

  // Flat triangles, and at most one texture beside white, which the prototype's atlas takes.
  const white = Texture.WHITE.source.uid;
  let texture: TextureSource | null = null;
  for (const batch of renderer.graphicsContext.updateGpuContext(context).batches) {
    const source = batch.texture.source;
    if (
      batch.topology !== "triangle-list" ||
      (source.uid !== white && texture && texture !== source)
    ) {
      return false;
    }

    if (source.uid !== white) {
      texture = source;
    }
  }

  return true;
}

export function protoTakesSprite(sprite: Sprite, renderer: WebGLRenderer): boolean {
  return (
    proto.on &&
    proto.sprites &&
    sprite.renderPipeId === "sprite" &&
    !(renderer._roundPixels | (sprite as Sprite & { _roundPixels: number })._roundPixels)
  );
}

/** Mark `item` as the prototype's, or not, as it is added to an instruction set. */
export function markProto(item: Container, taken: boolean): void {
  (item as ProtoItem).$proto = taken;
}

/** Add `item` to the proto run `instructionSet` ends with, or start one. */
export function addToProtoRun(item: Container, instructionSet: InstructionSet): void {
  const size = instructionSet.instructionSize;
  const last = instructionSet.instructions[size - 1] as TableInstruction | undefined;
  if (size > 0 && last?.renderPipeId === NAME && last.protoItems) {
    last.protoItems.push(item as ProtoItem);
    (item as ProtoItem).$protoRun = last;
    return;
  }

  const run: TableInstruction = {
    renderPipeId: NAME,
    canBundle: false,
    items: [],
    protoItems: [item as ProtoItem],
  };
  (item as ProtoItem).$protoRun = run;
  instructionSet.add(run);
}

/**
 * The prototype's vertex shader: the pulled one, where a chunk whose
 * fourth word is a texture's slot plus one is a sprite, its six vertices
 * made from its record (rectangle and uvs) as Pixi's batcher makes a
 * quad's, and its colour the white a sprite's vertices carry.
 */
const protoVertex = `#version 300 es
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform highp sampler2D uTable;
uniform highp sampler2D uAtlas;
uniform highp sampler2D uChunks;
uniform highp sampler2D uSprites;
uniform float uFirst;
out vec4 vColor;
out vec2 vUV;
flat out float vTex;
flat out float vFlash;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
  int chunk = int(uFirst) + gl_InstanceID;
  vec4 c = texelFetch(uChunks, ivec2(chunk & ${ATLAS_WIDTH - 1}, chunk >> ${Math.log2(ATLAS_WIDTH)}), 0);
  vColor = vec4(0.0);
  vUV = vec2(0.0);
  vTex = -1.0;
  vFlash = 0.0;
  vMul = vec4(0.0);
  vAdd = vec4(0.0);
  if (float(gl_VertexID) >= c.z) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 aPosition;
  vec4 aColor;
  if (c.w > 0.5) {
    int record = int(c.y);
    ivec2 s = ivec2((record & ${SPRITES_A_LINE - 1}) * ${SPRITE_TEXELS}, record >> ${Math.log2(SPRITES_A_LINE)});
    vec4 rect = texelFetch(uSprites, s, 0);
    vec4 uv01 = texelFetch(uSprites, s + ivec2(1, 0), 0);
    vec4 uv23 = texelFetch(uSprites, s + ivec2(2, 0), 0);
    // Pixi's quad, corners 0 1 2 and 0 2 3.
    int corner = gl_VertexID < 3 ? gl_VertexID : (gl_VertexID == 3 ? 0 : gl_VertexID - 2);
    aPosition = vec2(corner == 1 || corner == 2 ? rect.z : rect.x, corner >= 2 ? rect.w : rect.y);
    vUV = corner == 0 ? uv01.xy : (corner == 1 ? uv01.zw : (corner == 2 ? uv23.xy : uv23.zw));
    aColor = vec4(1.0);
    vTex = c.w - 1.0;
  } else {
    // Two texels an index: position and colour, then uv and whether it samples the batch's texture.
    int texel = (int(c.y) + gl_VertexID) * 2;
    vec4 a = texelFetch(uAtlas, ivec2(texel & ${ATLAS_WIDTH - 1}, texel >> ${Math.log2(ATLAS_WIDTH)}), 0);
    vec4 b = texelFetch(uAtlas, ivec2((texel + 1) & ${ATLAS_WIDTH - 1}, (texel + 1) >> ${Math.log2(ATLAS_WIDTH)}), 0);
    aPosition = a.xy;
    vec2 upper = floor(a.zw / 256.0);
    aColor = vec4(a.z - upper.x * 256.0, upper.x, a.w - upper.y * 256.0, upper.y) / 255.0;
    if (c.w < -0.5 && b.z > 0.5) {
      vUV = b.xy;
      vTex = -c.w - 1.0;
    }
  }

  int row = int(c.x);
  ivec2 at = ivec2((row & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, row >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uTable, at, 0);
  vec4 t = texelFetch(uTable, at + ivec2(1, 0), 0);
  vec4 tint = texelFetch(uTable, at + ivec2(2, 0), 0);
  vec4 mul = texelFetch(uTable, at + ivec2(3, 0), 0);
  vec4 add = texelFetch(uTable, at + ivec2(4, 0), 0);
${placed}}
`;

/**
 * A fill as the table's fragment shader colours it; a sprite's texel
 * times its colour as Pixi's batcher does, or under a Flash colour
 * transform as the colour batcher does, unpremultiplied first.
 */
const protoFragment = (units: number) => `#version 300 es
in vec4 vColor;
in vec2 vUV;
flat in float vTex;
flat in float vFlash;
flat in vec4 vMul;
flat in vec4 vAdd;
uniform sampler2D uTextures[${units}];
out vec4 finalColor;

vec4 texel(int slot, vec2 uv) {
${Array.from({ length: units }, (_, i) => `  if (slot == ${i}) return texture(uTextures[${i}], uv);`).join("\n")}
  return vec4(0.0);
}

void main(void) {
  if (vTex < -0.5) {
    if (vFlash > 0.5) {
      vec4 c = clamp(vColor * vMul + vAdd, 0.0, 1.0);
      finalColor = vec4(c.rgb * c.a, c.a);
    } else {
      finalColor = vColor;
    }
    return;
  }

  vec4 t = texel(int(vTex + 0.5), vUV);
  if (vFlash > 0.5) {
    if (t.a == 0.0) {
      finalColor = vec4(0.0);
    } else {
      vec4 straight = vec4(t.rgb / t.a * vColor.rgb, t.a * vColor.a);
      vec4 c = clamp(straight * vMul + vAdd, 0.0, 1.0);
      finalColor = vec4(c.rgb * c.a, c.a);
    }
  } else {
    finalColor = t * vColor;
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
  /** A textured atlas' (the prototype's): each batch's one texture, or null for flat colour. */
  textures?: (TextureSource | null)[];
}

/**
 * Where an atlas' vertices and indices are kept: the GPU's buffers, which
 * the table writes into and grows there (TablePipe), with no copy on the
 * CPU; or, for an expanded atlas, a texture of a texel an index.
 */
export interface AtlasStore {
  /** Room for `vertices` and `indices`, the first `keptVertices` and `keptIndices` kept. */
  resize(vertices: number, indices: number, keptVertices: number, keptIndices: number): void;
  /** `floats` of `data`, from float `from`, written from vertex `at` on. */
  writeVertices(at: number, data: Float32Array, from: number, floats: number): void;
  /**
   * `count` indices of `data`, from index `from`, written from index `at`
   * on: for an expanded atlas, EXPANDED_WORDS words an index.
   */
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
 * Words an index of an expanded atlas, a float texel: its vertex' position,
 * and its colour's bytes two to a float, red and green, blue and alpha,
 * each pair a whole number a float holds exactly. A float texture, not an
 * integer one, as Pixi binds an empty texture over an integer one on any
 * unit a batch's shader might read (unbindIntegerTextures).
 */
export const EXPANDED_WORDS = 4;

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
  /** The most indices the store may hold, which growth stops at. */
  mostIndices = Number.POSITIVE_INFINITY;
  /** What the atlas has done, for a test or a probe to read. */
  readonly stats = { placed: 0, reused: 0, released: 0, grown: 0, compacted: 0, cleared: 0 };
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
  /**
   * Whether each index is kept as its vertex, EXPANDED_WORDS words, for a
   * shader to fetch by where it lies (the table's pulled draws), with no
   * vertices apart: the atlas then counts no vertices.
   */
  private readonly expanded: boolean;
  /** The words an index takes in the stage and the store. */
  private readonly words: number;

  /**
   * Whether it takes batches of a texture beside white (the prototype's):
   * each index then two texels, the second its uv and whether its vertex
   * samples the batch's texture.
   */
  private readonly textured: boolean;

  constructor(white: number, store: AtlasStore, expanded = false, textured = false) {
    this.white = white;
    this.store = store;
    this.expanded = expanded;
    this.textured = expanded && textured;
    this.words = expanded ? (this.textured ? EXPANDED_WORDS * 2 : EXPANDED_WORDS) : 1;
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
    const batchTextures: (TextureSource | null)[] = [];
    for (let i = 0; i < instructions.instructionSize; i++) {
      const batch = instructions.instructions[i] as Batch;
      const textures = batch.textures;
      let flat = batch.topology === "triangle-list";
      let texture: TextureSource | null = null;
      for (let k = 0; k < textures.count; k++) {
        const source = textures.textures[k] as TextureSource;
        if (source.uid === this.white) {
          continue;
        }

        // A textured atlas takes one texture a batch beside white; a flat one none.
        flat &&= this.textured && (texture === null || texture === source);
        texture = source;
      }

      if (!flat) {
        this.placed.set(key, null);
        return null;
      }

      if (batch.size) {
        counts.push(batch.size);
        starts.push(batch.start);
        batchTextures.push(texture);
      }
    }

    if (counts.length === 0) {
      this.placed.set(key, null);
      return null;
    }

    const vertexCount = this.expanded ? 0 : batcher.attributeSize / VERTEX_FLOATS;
    const indexCount = batcher.indexSize;
    const placed: Placed = {
      vertices: vertexCount,
      indices: indexCount,
      vertexStart: 0,
      indexStart: 0,
      counts,
      offsets: starts,
      textures: this.textured ? batchTextures : undefined,
    };
    this.reserve(placed);
    for (let i = 0; i < starts.length; i++) {
      starts[i] = (placed.indexStart + starts[i]) * 4;
    }

    this.copyIn(
      placed,
      batcher.attributeBuffer.float32View,
      batcher.indexBuffer,
      this.textured ? sampling(instructions, batcher, this.white) : null,
    );
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

    this.stats.cleared++;
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
  private copyIn(
    placed: Placed,
    vertices: Float32Array,
    indices: ArrayLike<number>,
    samples: Uint8Array | null = null,
  ): void {
    const floats = placed.vertices * VERTEX_FLOATS;
    const count = placed.indices;
    const base = placed.vertexStart;
    if (this.stagedFloats + floats > STAGED_FLOATS || this.stagedCount + count > STAGED_INDICES) {
      this.send();
    }

    if (floats > STAGED_FLOATS || count > STAGED_INDICES) {
      // Larger than the stage alone: written as it comes, its indices in an array of their own.
      const offset = new Uint32Array(count * this.words);
      if (this.expanded) {
        expand(offset, 0, vertices, indices, count, samples);
      } else {
        for (let i = 0; i < count; i++) {
          offset[i] = indices[i] + base;
        }

        this.store.writeVertices(base, vertices, 0, floats);
      }

      this.store.writeIndices(placed.indexStart, offset, 0, count);
      return;
    }

    const from = this.stagedFloats;
    const at = this.stagedCount;
    this.stage(from + floats, (at + count) * this.words);
    if (this.expanded) {
      expand(this.stagedIndices, at * this.words, vertices, indices, count, samples);
    } else {
      this.staged.set(vertices.subarray(0, floats), from);
      for (let i = 0; i < count; i++) {
        this.stagedIndices[at + i] = indices[i] + base;
      }
    }

    this.stagedFloats += floats;
    this.stagedCount += count;
    if (!this.expanded) {
      addWrite(this.vertexWrites, base, from, floats, VERTEX_FLOATS);
    }

    addWrite(this.indexWrites, placed.indexStart, at, count, 1);
  }

  /** Staging arrays of at least `floats` and `count` words, doubled as need be, what they stage kept. */
  private stage(floats: number, count: number): void {
    if (floats > this.staged.length) {
      const grown = new Float32Array(
        Math.min(STAGED_FLOATS, Math.max(floats, this.staged.length * 2, 4096 * VERTEX_FLOATS)),
      );
      grown.set(this.staged.subarray(0, this.stagedFloats));
      this.staged = grown;
    }

    if (count > this.stagedIndices.length) {
      const most = STAGED_INDICES * this.words;
      const grown = new Uint32Array(
        Math.min(most, Math.max(count, this.stagedIndices.length * 2, 4096 * 3 * this.words)),
      );
      grown.set(this.stagedIndices.subarray(0, this.stagedCount * this.words));
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
        // Doubled no further than the store may hold: past it only if what is needed is.
        this.indexCapacity = Math.max(
          indices.top + placed.indices,
          Math.min(Math.ceil(this.indexCapacity * ATLAS_GROWTH), this.mostIndices),
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
      drawn.grown++;
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
 * Each of `count` indices' vertex into `out` from word `at` on, as an
 * expanded atlas keeps it (EXPANDED_WORDS): its position's two floats,
 * and its colour's word as Pixi packed it, its four bytes from the lowest
 * as red, green, blue and alpha (VERTEX_FLOATS a vertex).
 */
function expand(
  out: Uint32Array,
  at: number,
  vertices: Float32Array,
  indices: ArrayLike<number>,
  count: number,
  samples: Uint8Array | null = null,
): void {
  const floats = new Float32Array(out.buffer, out.byteOffset, out.length);
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const step = samples ? EXPANDED_WORDS * 2 : EXPANDED_WORDS;
  for (let i = 0, o = at; i < count; i++, o += step) {
    const index = indices[i];
    const v = index * VERTEX_FLOATS;
    const color = words[v + 4];
    out[o] = words[v];
    out[o + 1] = words[v + 1];
    floats[o + 2] = color & 0xffff;
    floats[o + 3] = color >>> 16;
    if (samples) {
      // The prototype's second texel: the vertex' uv, and whether it samples its batch's texture.
      out[o + 4] = words[v + 2];
      out[o + 5] = words[v + 3];
      floats[o + 6] = samples[index];
      floats[o + 7] = 0;
    }
  }
}

/**
 * For each vertex Pixi packed, 1 if it samples a texture other than white:
 * its texture's id, the high half of its fifth word, names one of its
 * batch's textures.
 */
function sampling(
  instructions: Packed["instructions"],
  batcher: Packed["batcher"],
  white: number,
): Uint8Array {
  const vertices = batcher.attributeBuffer.float32View;
  const words = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const samples = new Uint8Array(batcher.attributeSize / VERTEX_FLOATS);
  for (let i = 0; i < instructions.instructionSize; i++) {
    const batch = instructions.instructions[i] as Batch;
    const textures = batch.textures;
    for (let k = batch.start; k < batch.start + batch.size; k++) {
      const v = batcher.indexBuffer[k];
      const id = words[v * VERTEX_FLOATS + 5] >>> 16;
      samples[v] = id < textures.count && textures.textures[id].uid !== white ? 1 : 0;
    }
  }

  return samples;
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
  /** How a pipe draws it in pulled draws, as planned for a render. */
  plan?: Plan;
  /** A proto run's Graphics and Sprites (setProto), and its plan. */
  protoItems?: ProtoItem[];
  protoPlan?: ProtoPlan;
  /** Whether an item of the run changed since it was planned (render/hooks.ts, updateRenderable). */
  protoDirty?: boolean;
}

/** A proto run's steps: Plan's, and the textures each binds, from `texStart`, `texCount` of them. */
interface ProtoPlan extends Plan {
  texStart: number[];
  texCount: number[];
  textures: TextureSource[];
  /** The atlas' clearings it was planned after, and the texture units it was planned for. */
  cleared: number;
  units: number;
  /** Kept (retain): where its rows, chunks and sprite records lie in the kept textures, and how many. */
  kept: boolean;
  rowStart: number;
  rowCount: number;
  chunkStart: number;
  chunkCount: number;
  spriteStart: number;
  spriteCount: number;
  /** The render it was last drawn in, for kept ranges to be given back once unused. */
  used: number;
}

/**
 * A run's steps as a render planned them before any was drawn (TablePipe,
 * prepare): each a pulled draw of `chunks` chunks from `first`, of `rows`
 * rows, under a blend mode, or a Graphics for Pixi's pipe to draw.
 */
interface Plan {
  pipe: TablePipe;
  /** The render it was planned for, and the atlas' releases by then. */
  render: number;
  releases: number;
  steps: number;
  alone: (Graphics | null)[];
  first: number[];
  chunks: number[];
  rows: number[];
  blends: string[];
  /** The contexts its draws read, and where each lay in the atlas as planned. */
  contexts: GpuGraphicsContext[];
  places: Placed[];
}

/** Add `graphics` to the run `instructionSet` ends with, or start one: anything else ends a run. */
export function addToRun(graphics: Graphics, instructionSet: InstructionSet): void {
  const size = instructionSet.instructionSize;
  const last = instructionSet.instructions[size - 1] as TableInstruction | undefined;
  // A proto run is the table's too, but not one to join.
  if (size > 0 && last?.renderPipeId === NAME && !last.protoItems) {
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

const tableSource = (height: number, width = TABLE_WIDTH) =>
  new BufferImageSource({
    resource: new Float32Array(width * height * 4),
    width,
    height,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
  });

/**
 * The expanded atlas' texture, `height` lines of ATLAS_WIDTH texels made on
 * the GPU alone, as the table writes into it with no copy on the CPU: Pixi
 * allocates a source with no resource empty.
 */
function atlasSource(height: number): BufferImageSource {
  const source = new BufferImageSource({
    resource: new Float32Array(EXPANDED_WORDS),
    width: ATLAS_WIDTH,
    height,
    format: "rgba32float",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
  });
  (source as { resource: unknown }).resource = null;
  return source;
}

/** `graphics`' transform and tint written as a row from float `at` of `out`. */
function writeRow(out: Float32Array, at: number, graphics: Graphics): void {
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
}

/**
 * Draws runs of Graphics drawn alone. Where WebGL 2 has float
 * framebuffers, a run is planned as each render group is made ready
 * (prepare), before anything is drawn: its rows written, and its batches'
 * chunks of CHUNK indices, each naming its row and where its indices lie
 * in the expanded atlas, and the rows and chunks of every run uploaded at
 * once as the first is drawn; then each stretch of a run of one blend mode
 * is one drawArraysInstanced, an instance a chunk, whose vertex shader
 * fetches its vertices (pulledVertex), one uniform set for it. Multi-draws
 * cost Chrome's GPU process as much a draw as the draws would alone; this
 * is one draw. Without, on a renderer that draws on the CPU (SOFTWARE), or
 * switched off for a test or a bench (setTransformTable), the table makes
 * the multi-draws of before.
 */
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
  /** Whether the renderer has what pulled draws need: WebGL 2, with float framebuffers to blit. */
  private pullable = false;
  /** Whether the renderer draws on the CPU, which pulled draws are left to by default (SOFTWARE). */
  private software = false;
  /** Whether the expanded atlas outgrew the most its texture may hold, which leaves pulled draws till a new context. */
  private pullFailed = false;
  /** Counts the renders, for a plan to tell whether it is this one's. */
  private render = 0;
  /** The pulled draws' expanded atlas, its texture, and the most lines that may be. */
  private pulled!: Atlas;
  private atlasTexture: BufferImageSource | null = null;
  private atlasMostLines = 0;
  /** The pulled draws' rows and chunks, the next free of each this render, and those uploaded so far. */
  private pulledRows!: BufferImageSource;
  private rowCursor = 0;
  private uploaded = 0;
  private chunks!: BufferImageSource;
  private chunkCursor = 0;
  private chunksUploaded = 0;
  private pulledShader: Shader | null = null;
  private readonly pulledUniforms = new UniformGroup({ uFirst: { value: 0, type: "f32" } });
  /**
   * The texture units the pulled draws' rows, atlas and chunks are bound
   * to: the last three, which no batch or filter takes, so that they stay bound
   * between the run's draws and the others; and the program, as last
   * linked, its samplers were pointed at them in.
   */
  private rowsUnit = 0;
  private atlasUnit = 0;
  private chunksUnit = 0;
  private pointed: WebGLProgram | null = null;
  /** A geometry of no attributes, which pulled draws bind. */
  private empty!: Geometry;
  /** Framebuffers of the atlas' texture and a larger one, which it is blitted into. */
  private copyFrames: (WebGLFramebuffer | null)[] | null = null;
  /** The prototype's sprite records, the next free this render and those uploaded; its unit. */
  private sprites!: BufferImageSource;
  private spriteCursor = 0;
  private spritesUploaded = 0;
  private spritesUnit = 0;
  /**
   * The prototype's kept rows, chunks and sprite records (retain): each run's
   * stay from render to render until an item of it changes, its ranges
   * taken and given back as Ranges; the stretch of each written this
   * render, uploaded in one call; and the plans holding ranges.
   */
  private keptRows!: BufferImageSource;
  private keptChunks!: BufferImageSource;
  private keptSprites!: BufferImageSource;
  private readonly keptRowRanges = new Ranges();
  private readonly keptChunkRanges = new Ranges();
  private readonly keptSpriteRanges = new Ranges();
  /** Each kind's stretches written this render, start and end, merged and uploaded as drawn. */
  private readonly keptWrites: number[][] = [[], [], []];
  private readonly keptPlans = new Set<ProtoPlan>();
  /** The prototype's textured atlas (Atlas, textured), its texture, and whether it outgrew it. */
  private protoAtlas!: Atlas;
  private protoAtlasTexture: BufferImageSource | null = null;
  private protoAtlasFailed = false;
  /** The texture slot protoStepFor found. */
  private slot = 0;
  /** The prototype's shader by texture units, and the programs whose samplers were pointed. */
  private readonly protoShaders = new Map<number, Shader>();
  private protoPointed = new WeakSet<WebGLProgram>();

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
    this.pulledRows = tableSource(16);
    this.chunks = tableSource(16, ATLAS_WIDTH);
    this.sprites = tableSource(16, SPRITES_A_LINE * SPRITE_TEXELS);
    this.protoAtlas = new Atlas(
      Texture.WHITE.source.uid,
      {
        // Two texels an index.
        resize: (_vertices, indices, _keptVertices, keptIndices) =>
          this.resizeProtoAtlas(indices * 2, keptIndices * 2),
        writeVertices: () => {},
        writeIndices: (at, data, from, count) =>
          this.writeProtoAtlas(at * 2, data, from * 2, count * 2),
      },
      true,
      true,
    );
    this.keptRows = tableSource(16);
    this.keptChunks = tableSource(16, ATLAS_WIDTH);
    this.keptSprites = tableSource(16, SPRITES_A_LINE * SPRITE_TEXELS);
    this.pulled = new Atlas(
      Texture.WHITE.source.uid,
      {
        resize: (_vertices, indices, _keptVertices, keptIndices) =>
          this.resizeAtlasTexture(indices, keptIndices),
        writeVertices: () => {},
        writeIndices: (at, data, from, count) => this.writeAtlasTexture(at, data, from, count),
      },
      true,
    );
    this.empty = new Geometry({ attributes: {} });
    renderer.runners.contextChange.add(this);
    renderer.runners.prerender.add(this);
  }

  contextChange(): void {
    const gl = this.renderer.gl;
    const webGL2 = this.renderer.context.webGLVersion === 2;
    this.multi = webGL2 ? (gl.getExtension("WEBGL_multi_draw") as Multi | null) : null;
    const most = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.maxRows = most * ROWS_A_LINE;
    // The atlas' float texture is blitted into a larger one: from a framebuffer, as the extension
    // lets it be.
    this.pullable = webGL2 && gl.getExtension("EXT_color_buffer_float") !== null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.software = SOFTWARE.test(
      String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
    );
    this.atlasMostLines = Math.min(most, EXACT / ATLAS_WIDTH);
    this.pulled.mostIndices = this.atlasMostLines * ATLAS_WIDTH;
    const units = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
    this.rowsUnit = units - 1;
    this.atlasUnit = units - 2;
    this.chunksUnit = units - 3;
    this.spritesUnit = units - 4;
    this.pointed = null;
    this.protoPointed = new WeakSet();
    // Pixi binds the empty texture to units 0 to 15 alone as a context comes, and would hold what
    // was bound to these on a lost one bound still.
    for (const unit of [this.rowsUnit, this.atlasUnit, this.chunksUnit, this.spritesUnit]) {
      this.renderer.texture.bind(Texture.EMPTY, unit);
    }
    // A lost context took the atlas' buffers: every context is copied in again as it is drawn.
    this.vertexBytes = 0;
    this.indexBytes = 0;
    this.atlas.lost();
    this.pulled.lost();
    this.protoAtlas.lost();
    this.protoAtlasFailed = false;
    this.protoAtlas.mostIndices = (this.atlasMostLines * ATLAS_WIDTH) / 2;
    // An atlas that outgrew a lost context's texture starts again empty in the new one's.
    this.pullFailed = false;
    this.copyFrames = null;
  }

  prerender(): void {
    this.cursor = 0;
    this.atlas.compact();
    this.render++;
    this.rowCursor = 0;
    this.uploaded = 0;
    this.chunkCursor = 0;
    this.chunksUploaded = 0;
    this.spriteCursor = 0;
    this.spritesUploaded = 0;
    this.pulled.compact();
    this.protoAtlas.compact();
    // Kept ranges of runs not drawn for a while, as a group rebuilt leaves its old runs, given back.
    if (this.render % 60 === 0) {
      for (const plan of this.keptPlans) {
        if (this.render - plan.used > 120) {
          this.giveBack(plan);
        }
      }
    }
  }

  /** Whether the table draws for this renderer: switched on, and pulled draws or WebGL 2 with multi-draw. */
  get active(): boolean {
    return enabled && (this.pulling || this.multi !== null);
  }

  /** Whether runs are pulled draws: wanted, and possible. */
  private get pulling(): boolean {
    // The prototype draws only pulled draws, on software GL too.
    return (
      enabled && (pullWanted ?? (proto.on || !this.software)) && this.pullable && !this.pullFailed
    );
  }

  /** Whether a run too short for a multi-draw is drawn from the atlas, a call a draw. */
  private get loops(): boolean {
    return loopShort && minRun <= SHORT_RUN + 1;
  }

  add(graphics: Graphics, instructionSet: InstructionSet): void {
    addToRun(graphics, instructionSet);
  }

  /**
   * Plan the runs of a render group's instructions, its transforms
   * updated, before any is drawn (render/hooks.ts): their rows go up
   * together as the first run is drawn.
   */
  prepare(instructionSet: InstructionSet): void {
    if (!this.pulling) {
      return;
    }

    const instructions = instructionSet.instructions;
    for (let i = 0; i < instructionSet.instructionSize; i++) {
      const instruction = instructions[i] as TableInstruction;
      if (instruction.renderPipeId !== NAME) {
        continue;
      }

      if (instruction.protoItems) {
        if (!this.protoValid(instruction)) {
          this.planProto(instruction);
        }
      } else {
        this.plan(instruction);
      }
    }
  }

  execute(instruction: TableInstruction): void {
    if (instruction.protoItems) {
      this.executeProto(instruction);
      return;
    }

    if (this.pulling && this.executePulled(instruction)) {
      return;
    }

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

    writeRow(this.table.resource as Float32Array, this.cursor * ROW_TEXELS * 4, graphics);
    this.cursor++;
  }

  /**
   * Plan `run` for this render: its Graphics' rows written from the next
   * free, a pulled draw for each stretch of one blend mode, and a step of
   * Pixi's pipe for each the table cannot draw, as execute drew them.
   */
  private plan(run: TableInstruction): Plan {
    let plan = run.plan;
    if (plan?.pipe !== this) {
      plan = {
        pipe: this,
        render: 0,
        releases: 0,
        steps: 0,
        alone: [],
        first: [],
        chunks: [],
        rows: [],
        blends: [],
        contexts: [],
        places: [],
      };
      run.plan = plan;
    }

    plan.render = this.render;
    plan.releases = this.pulled.stats.released;
    plan.steps = 0;
    plan.contexts.length = 0;
    plan.places.length = 0;
    const renderer = this.renderer;
    const contexts = renderer.graphicsContext;
    const roundAll = renderer._roundPixels;
    let open = -1;
    for (const item of run.items) {
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
          : this.pulled.where(gpu);
      if (place === undefined) {
        place = this.pulled.place(gpu, contexts.getContextRenderDataOnCpu(context));
      }

      if (this.pullFailed) {
        return plan;
      }

      const batches = place ? place.counts.length : 0;
      let chunks = 0;
      for (let i = 0; i < batches; i++) {
        chunks += Math.ceil((place as Placed).counts[i] / CHUNK);
      }

      if (
        !place ||
        this.rowCursor + batches > this.maxRows ||
        this.chunkCursor + chunks > this.atlasMostLines * ATLAS_WIDTH
      ) {
        open = -1;
        this.step(plan, graphics, 0, "");
        continue;
      }

      const blend = graphics.groupBlendMode;
      if (open < 0 || plan.blends[open] !== blend) {
        open = this.step(plan, null, this.chunkCursor, blend);
      }

      for (let i = 0; i < batches; i++) {
        plan.chunks[open] += this.pulledRow(graphics, place.offsets[i] / 4, place.counts[i]);
        plan.rows[open]++;
      }

      plan.contexts.push(gpu);
      plan.places.push(place);
    }

    return plan;
  }

  /** A step added to `plan`: Pixi's pipe drawing `alone`, or a pulled draw from chunk `first`. */
  private step(plan: Plan, alone: Graphics | null, first: number, blend: string): number {
    const k = plan.steps++;
    plan.alone[k] = alone;
    plan.first[k] = first;
    plan.chunks[k] = 0;
    plan.rows[k] = 0;
    plan.blends[k] = blend;
    return k;
  }

  /**
   * `graphics`' row written next, and the chunks of its batch of `count`
   * indices from `index` in the atlas: how many.
   */
  private pulledRow(graphics: Graphics, index: number, count: number, w = 0): number {
    if (this.rowCursor >= this.pulledRows.height * ROWS_A_LINE) {
      this.pulledRows = this.grown(this.pulledRows, this.maxRows / ROWS_A_LINE);
      // Made anew, and uploaded whole as it is first bound.
      this.uploaded = this.rowCursor;
    }

    const row = this.rowCursor++;
    writeRow(this.pulledRows.resource as Float32Array, row * ROW_TEXELS * 4, graphics);
    const chunks = Math.ceil(count / CHUNK);
    while (this.chunkCursor + chunks > this.chunks.height * ATLAS_WIDTH) {
      this.chunks = this.grown(this.chunks, this.atlasMostLines);
      this.chunksUploaded = this.chunkCursor;
    }

    const out = this.chunks.resource as Float32Array;
    for (let k = 0, at = this.chunkCursor * 4; k < count; k += CHUNK, at += 4) {
      out[at] = row;
      out[at + 1] = index + k;
      out[at + 2] = Math.min(CHUNK, count - k);
      out[at + 3] = w;
    }

    this.chunkCursor += chunks;
    return chunks;
  }

  /** `table` twice as tall, at most `most` lines, what it holds brought along. */
  private grown(table: BufferImageSource, most: number): BufferImageSource {
    const next = tableSource(Math.min(table.height * 2, most), table.width);
    (next.resource as Float32Array).set(table.resource as Float32Array);
    table.destroy();
    return next;
  }

  /**
   * Draw `run` as planned for this render, planned again if it was not, or
   * a context it draws has left the atlas since; false if the expanded
   * atlas outgrew its texture as it was planned, for the multi-draws to
   * draw it.
   */
  private executePulled(run: TableInstruction): boolean {
    let plan = run.plan;
    if (plan?.pipe !== this || plan.render !== this.render || !this.stillPlaced(plan)) {
      plan = this.plan(run);
    }

    if (!this.pulling) {
      return false;
    }

    this.pulled.send();
    if (this.rowCursor > this.uploaded) {
      this.upload(this.uploaded, this.rowCursor, this.pulledRows, ROW_TEXELS, this.rowsUnit);
      this.uploaded = this.rowCursor;
    }

    if (this.chunkCursor > this.chunksUploaded) {
      this.upload(
        this.chunksUploaded,
        this.chunkCursor,
        this.chunks,
        1,
        this.chunksUnit,
        ATLAS_WIDTH,
      );
      this.chunksUploaded = this.chunkCursor;
    }

    const graphicsPipe = this.renderer.renderPipes.graphics;
    for (let k = 0; k < plan.steps; k++) {
      const alone = plan.alone[k];
      if (alone) {
        graphicsPipe.execute(alone);
      } else if (plan.chunks[k] > 0) {
        this.drawPulled(plan.first[k], plan.chunks[k], plan.rows[k], plan.blends[k]);
      }
    }

    return true;
  }

  /** Whether every context `plan` draws lies where it was planned: none released, or each still placed. */
  private stillPlaced(plan: Plan, atlas = this.pulled): boolean {
    if (plan.releases === atlas.stats.released) {
      return true;
    }

    for (let i = 0; i < plan.contexts.length; i++) {
      if (atlas.where(plan.contexts[i]) !== plan.places[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Plan proto run `run` for this render: each Graphics as plan does, a
   * batched copy it shows too, and each Sprite a
   * row, a record and a chunk of its own; a step for each stretch of one
   * blend mode whose textures fit the units.
   */
  private planProto(run: TableInstruction): ProtoPlan {
    const start = performance.now();
    let plan = run.protoPlan;
    if (plan?.pipe !== this) {
      plan = {
        pipe: this,
        render: 0,
        releases: 0,
        steps: 0,
        alone: [],
        first: [],
        chunks: [],
        rows: [],
        blends: [],
        contexts: [],
        places: [],
        texStart: [],
        texCount: [],
        textures: [],
        cleared: 0,
        units: 0,
        kept: false,
        rowStart: 0,
        rowCount: 0,
        chunkStart: 0,
        chunkCount: 0,
        spriteStart: 0,
        spriteCount: 0,
        used: 0,
      };
      run.protoPlan = plan;
    }

    run.protoDirty = false;
    plan.cleared = this.protoAtlas.stats.cleared;
    plan.units = proto.units;
    plan.used = this.render;
    protoDrawn.planned++;
    const rowFrom = this.rowCursor;
    const chunkFrom = this.chunkCursor;
    const spriteFrom = this.spriteCursor;
    plan.render = this.render;
    plan.releases = this.protoAtlas.stats.released;
    plan.steps = 0;
    plan.contexts.length = 0;
    plan.places.length = 0;
    plan.textures.length = 0;

    const contexts = this.renderer.graphicsContext;
    let open = -1;
    for (const item of run.protoItems as ProtoItem[]) {
      if (!item.isRenderable) {
        continue;
      }

      const blend = item.groupBlendMode;
      if (item instanceof Sprite) {
        const source = item.texture?.source;
        if (!source) {
          continue;
        }

        open = this.protoStepFor(plan, open, blend, source);
        plan.chunks[open] += this.spriteRow(item, this.slot);
        plan.rows[open]++;
        protoDrawn.sprites++;
        continue;
      }

      const graphics = item as unknown as Graphics;
      const context = graphics.context;
      const gpu = contexts.updateGpuContext(context);
      if (!gpu.batches.length) {
        continue;
      }

      let place = this.protoAtlas.where(gpu);
      if (place === undefined) {
        place = this.protoAtlas.place(gpu, contexts.getContextRenderDataOnCpu(context));
      }

      if (this.protoAtlasFailed) {
        return plan;
      }

      const batches = place ? place.counts.length : 0;
      let chunks = 0;
      for (let i = 0; i < batches; i++) {
        chunks += Math.ceil((place as Placed).counts[i] / CHUNK);
      }

      if (
        !place ||
        this.rowCursor + batches > this.maxRows ||
        this.chunkCursor + chunks > this.atlasMostLines * ATLAS_WIDTH
      ) {
        protoDrawn.missed++;
        continue;
      }

      for (let i = 0; i < batches; i++) {
        const texture = place.textures?.[i] ?? null;
        open = this.protoStepFor(plan, open, blend, texture);
        plan.chunks[open] += this.pulledRow(
          graphics,
          place.offsets[i] / 4,
          place.counts[i],
          texture ? -(this.slot + 1) : 0,
        );
        plan.rows[open]++;
      }

      plan.contexts.push(gpu);
      plan.places.push(place);
      protoDrawn.graphics++;
    }

    if (proto.retain) {
      this.keep(plan, rowFrom, chunkFrom, spriteFrom);
    } else if (plan.kept) {
      this.giveBack(plan);
    }

    protoDrawn.planMs += performance.now() - start;
    return plan;
  }

  /** Whether `run`'s plan may be drawn as it is: kept and unchanged, or made this render. */
  private protoValid(run: TableInstruction): boolean {
    const plan = run.protoPlan;
    return (
      plan !== undefined &&
      plan.pipe === this &&
      plan.units === proto.units &&
      plan.cleared === this.protoAtlas.stats.cleared &&
      (plan.kept ? proto.retain && !run.protoDirty : plan.render === this.render) &&
      this.stillPlaced(plan, this.protoAtlas)
    );
  }

  /**
   * Move what `plan` wrote this render, from `rowFrom`, `chunkFrom` and
   * `spriteFrom` on, into kept ranges, its chunks pointed at its rows and
   * records there, and free the render's again.
   */
  private keep(plan: ProtoPlan, rowFrom: number, chunkFrom: number, spriteFrom: number): void {
    const rows = this.rowCursor - rowFrom;
    const chunks = this.chunkCursor - chunkFrom;
    const sprites = this.spriteCursor - spriteFrom;
    if (
      plan.kept &&
      (plan.rowCount !== rows || plan.chunkCount !== chunks || plan.spriteCount !== sprites)
    ) {
      this.giveBack(plan);
    }

    if (!plan.kept) {
      plan.rowStart = this.takeKept(0, rows);
      plan.chunkStart = this.takeKept(1, chunks);
      plan.spriteStart = this.takeKept(2, sprites);
      plan.rowCount = rows;
      plan.chunkCount = chunks;
      plan.spriteCount = sprites;
      plan.kept = true;
      this.keptPlans.add(plan);
    }

    const rowFloats = ROW_TEXELS * 4;
    (this.keptRows.resource as Float32Array).set(
      (this.pulledRows.resource as Float32Array).subarray(
        rowFrom * rowFloats,
        (rowFrom + rows) * rowFloats,
      ),
      plan.rowStart * rowFloats,
    );
    const spriteFloats = SPRITE_TEXELS * 4;
    (this.keptSprites.resource as Float32Array).set(
      (this.sprites.resource as Float32Array).subarray(
        spriteFrom * spriteFloats,
        (spriteFrom + sprites) * spriteFloats,
      ),
      plan.spriteStart * spriteFloats,
    );
    const from = this.chunks.resource as Float32Array;
    const to = this.keptChunks.resource as Float32Array;
    for (let i = 0; i < chunks; i++) {
      const a = (chunkFrom + i) * 4;
      const b = (plan.chunkStart + i) * 4;
      const sprite = from[a + 3] > 0.5;
      to[b] = from[a] - rowFrom + plan.rowStart;
      to[b + 1] = sprite ? from[a + 1] - spriteFrom + plan.spriteStart : from[a + 1];
      to[b + 2] = from[a + 2];
      to[b + 3] = from[a + 3];
    }

    for (let k = 0; k < plan.steps; k++) {
      plan.first[k] += plan.chunkStart - chunkFrom;
    }

    this.written(0, plan.rowStart, rows);
    this.written(1, plan.chunkStart, chunks);
    this.written(2, plan.spriteStart, sprites);
    this.rowCursor = rowFrom;
    this.chunkCursor = chunkFrom;
    this.spriteCursor = spriteFrom;
  }

  /** Kept range of `size` of rows (0), chunks (1) or sprite records (2), the texture grown till it fits. */
  private takeKept(kind: number, size: number): number {
    if (size === 0) {
      return 0;
    }

    const ranges = [this.keptRowRanges, this.keptChunkRanges, this.keptSpriteRanges][kind];
    const perLine = [ROWS_A_LINE, ATLAS_WIDTH, SPRITES_A_LINE][kind];
    for (;;) {
      const texture = [this.keptRows, this.keptChunks, this.keptSprites][kind];
      const start = ranges.take(size, texture.height * perLine);
      if (start >= 0) {
        return start;
      }

      // Made anew, and uploaded whole as it is first bound.
      const most = kind === 0 ? this.maxRows / ROWS_A_LINE : this.atlasMostLines;
      const next = this.grown(texture, most);
      if (kind === 0) {
        this.keptRows = next;
      } else if (kind === 1) {
        this.keptChunks = next;
      } else {
        this.keptSprites = next;
      }
    }
  }

  private giveBack(plan: ProtoPlan): void {
    if (!plan.kept) {
      return;
    }

    this.keptRowRanges.give(plan.rowStart, plan.rowCount);
    this.keptChunkRanges.give(plan.chunkStart, plan.chunkCount);
    this.keptSpriteRanges.give(plan.spriteStart, plan.spriteCount);
    plan.kept = false;
    this.keptPlans.delete(plan);
  }

  /** Note `count` of kind `kind` written from `start`, for this render's upload of each kind. */
  private written(kind: number, start: number, count: number): void {
    if (count > 0) {
      this.keptWrites[kind].push(start, start + count);
    }
  }

  /**
   * Upload the stretches of kept kind `kind` written since the last: sorted,
   * and those within a line of each other merged, a call each.
   */
  private uploadKept(kind: number): void {
    const writes = this.keptWrites[kind];
    if (writes.length === 0) {
      return;
    }

    const texture = [this.keptRows, this.keptChunks, this.keptSprites][kind];
    const texels = [ROW_TEXELS, 1, SPRITE_TEXELS][kind];
    const unit = [this.rowsUnit, this.chunksUnit, this.spritesUnit][kind];
    const perLine = [ROWS_A_LINE, ATLAS_WIDTH, SPRITES_A_LINE][kind];
    const order: number[] = [];
    for (let i = 0; i < writes.length; i += 2) {
      order.push(i);
    }

    order.sort((a, b) => writes[a] - writes[b]);
    let from = writes[order[0]];
    let to = writes[order[0] + 1];
    for (let k = 1; k <= order.length; k++) {
      const start = k < order.length ? writes[order[k]] : Infinity;
      if (start <= to + perLine) {
        to = Math.max(to, writes[order[k] + 1]);
        continue;
      }

      this.upload(from, to, texture, texels, unit, perLine);
      if (k < order.length) {
        from = start;
        to = writes[order[k] + 1];
      }
    }

    writes.length = 0;
  }

  /**
   * The step of `plan` to draw under `blend` with `source` bound (null for
   * none): the open one if it is of that blend and has the texture or room
   * for it, else a new one; the texture's slot in it left in `slot`.
   */
  private protoStepFor(
    plan: ProtoPlan,
    open: number,
    blend: string,
    source: TextureSource | null,
  ): number {
    if (open >= 0 && plan.blends[open] === blend) {
      if (!source) {
        return open;
      }

      const found = plan.textures.indexOf(source, plan.texStart[open]);
      if (found >= 0) {
        this.slot = found - plan.texStart[open];
        return open;
      }

      if (plan.texCount[open] < proto.units) {
        this.slot = plan.texCount[open]++;
        plan.textures.push(source);
        return open;
      }
    }

    const step = this.protoStep(plan, blend);
    if (source) {
      this.slot = plan.texCount[step]++;
      plan.textures.push(source);
    }

    return step;
  }

  /** A pulled draw from the next chunk added to `plan`, under `blend`, binding no texture yet. */
  private protoStep(plan: ProtoPlan, blend: string): number {
    const k = this.step(plan, null, this.chunkCursor, blend);
    plan.texStart[k] = plan.textures.length;
    plan.texCount[k] = 0;
    return k;
  }

  /** `sprite`'s row, record and chunk written next, its texture in `slot`: one chunk. */
  private spriteRow(sprite: Sprite, slot: number): number {
    if (this.rowCursor >= this.pulledRows.height * ROWS_A_LINE) {
      this.pulledRows = this.grown(this.pulledRows, this.maxRows / ROWS_A_LINE);
      this.uploaded = this.rowCursor;
    }

    const row = this.rowCursor++;
    writeRow(this.pulledRows.resource as Float32Array, row * ROW_TEXELS * 4, sprite as never);
    if (this.spriteCursor >= this.sprites.height * SPRITES_A_LINE) {
      this.sprites = this.grown(this.sprites, this.atlasMostLines);
      this.spritesUploaded = this.spriteCursor;
    }

    const record = this.spriteCursor++;
    const out = this.sprites.resource as Float32Array;
    const at = record * SPRITE_TEXELS * 4;
    const bounds = sprite.visualBounds;
    const uvs = sprite.texture.uvs;
    out[at] = bounds.minX;
    out[at + 1] = bounds.minY;
    out[at + 2] = bounds.maxX;
    out[at + 3] = bounds.maxY;
    out[at + 4] = uvs.x0;
    out[at + 5] = uvs.y0;
    out[at + 6] = uvs.x1;
    out[at + 7] = uvs.y1;
    out[at + 8] = uvs.x2;
    out[at + 9] = uvs.y2;
    out[at + 10] = uvs.x3;
    out[at + 11] = uvs.y3;
    while (this.chunkCursor + 1 > this.chunks.height * ATLAS_WIDTH) {
      this.chunks = this.grown(this.chunks, this.atlasMostLines);
      this.chunksUploaded = this.chunkCursor;
    }

    const chunks = this.chunks.resource as Float32Array;
    const c = this.chunkCursor * 4;
    chunks[c] = row;
    chunks[c + 1] = record;
    chunks[c + 2] = 6;
    chunks[c + 3] = slot + 1;
    this.chunkCursor++;
    return 1;
  }

  /** Draw proto run `run` as planned for this render, planned again if not; nothing without pulled draws. */
  private executeProto(run: TableInstruction): void {
    if (!this.pulling) {
      return;
    }

    let plan = run.protoPlan as ProtoPlan;
    if (this.protoValid(run)) {
      if (plan.kept && plan.used !== this.render) {
        protoDrawn.kept++;
      }
    } else {
      plan = this.planProto(run);
    }

    plan.used = this.render;
    if (!this.pulling) {
      return;
    }

    this.protoAtlas.send();
    for (let kind = 0; kind < 3; kind++) {
      this.uploadKept(kind);
    }

    if (this.rowCursor > this.uploaded) {
      this.upload(this.uploaded, this.rowCursor, this.pulledRows, ROW_TEXELS, this.rowsUnit);
      this.uploaded = this.rowCursor;
    }

    if (this.chunkCursor > this.chunksUploaded) {
      this.upload(
        this.chunksUploaded,
        this.chunkCursor,
        this.chunks,
        1,
        this.chunksUnit,
        ATLAS_WIDTH,
      );
      this.chunksUploaded = this.chunkCursor;
    }

    if (this.spriteCursor > this.spritesUploaded) {
      this.upload(
        this.spritesUploaded,
        this.spriteCursor,
        this.sprites,
        SPRITE_TEXELS,
        this.spritesUnit,
        SPRITES_A_LINE,
      );
      this.spritesUploaded = this.spriteCursor;
    }

    for (let k = 0; k < plan.steps; k++) {
      if (plan.chunks[k] > 0) {
        this.drawProto(plan, k);
      }
    }

    protoDrawn.runs++;
    if (proto.reset) {
      (this.renderer as unknown as { resetState(): void }).resetState();
      protoDrawn.resets++;
    }
  }

  /** Step `k` of `plan`: one pulled draw, its textures bound from unit 0. */
  private drawProto(plan: ProtoPlan, k: number): void {
    const renderer = this.renderer;
    const units = proto.units;
    let shader = this.protoShaders.get(units);
    if (!shader) {
      shader = new Shader({
        glProgram: new GlProgram({
          name: `${NAME}-proto-${units}`,
          vertex: protoVertex,
          fragment: protoFragment(units),
        }),
        resources: { pulledUniforms: this.pulledUniforms },
      });
      this.protoShaders.set(units, shader);
    }

    shader.groups[0] = renderer.globalUniforms.bindGroup;
    this.pulledUniforms.uniforms.uFirst = plan.first[k];
    this.state.blendMode = plan.blends[k] as State["blendMode"];
    renderer.state.set(this.state);
    renderer.shader.bind(shader);
    const gl = renderer.gl;
    const program = renderer.shader._getProgramData(shader.glProgram).program;
    if (!this.protoPointed.has(program)) {
      this.protoPointed.add(program);
      gl.uniform1i(gl.getUniformLocation(program, "uTable"), this.rowsUnit);
      gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), this.atlasUnit);
      gl.uniform1i(gl.getUniformLocation(program, "uChunks"), this.chunksUnit);
      gl.uniform1i(gl.getUniformLocation(program, "uSprites"), this.spritesUnit);
      gl.uniform1iv(
        gl.getUniformLocation(program, "uTextures"),
        Int32Array.from({ length: units }, (_, i) => i),
      );
    }

    renderer.texture.bind(plan.kept ? this.keptRows : this.pulledRows, this.rowsUnit);
    renderer.texture.bind(this.protoAtlasTexture as BufferImageSource, this.atlasUnit);
    renderer.texture.bind(plan.kept ? this.keptChunks : this.chunks, this.chunksUnit);
    renderer.texture.bind(plan.kept ? this.keptSprites : this.sprites, this.spritesUnit);
    for (let i = 0; i < plan.texCount[k]; i++) {
      renderer.texture.bind(plan.textures[plan.texStart[k] + i], i);
    }

    renderer.geometry.bind(this.empty, shader.glProgram);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, CHUNK, plan.chunks[k]);
    protoDrawn.calls++;
    drawn.calls++;
    drawn.draws += plan.rows[k];
    protoDrawn.chunks += plan.chunks[k];
    protoDrawn.textures += plan.texCount[k];
  }

  /** One draw of `chunks` chunks from `first`, of `rows` rows. */
  private drawPulled(first: number, chunks: number, rows: number, blend: string): void {
    const renderer = this.renderer;
    // The textures are bound here, not as Pixi binds a shader's, to units from 0 up, which every
    // other draw takes too.
    this.pulledShader ??= new Shader({
      glProgram: new GlProgram({ name: `${NAME}-pulled`, vertex: pulledVertex, fragment }),
      resources: { pulledUniforms: this.pulledUniforms },
    });
    const shader = this.pulledShader;
    shader.groups[0] = renderer.globalUniforms.bindGroup;
    this.pulledUniforms.uniforms.uFirst = first;
    this.state.blendMode = blend as State["blendMode"];
    renderer.state.set(this.state);
    renderer.shader.bind(shader);
    const gl = renderer.gl;
    const program = renderer.shader._getProgramData(shader.glProgram).program;
    if (this.pointed !== program) {
      this.pointed = program;
      gl.uniform1i(gl.getUniformLocation(program, "uTable"), this.rowsUnit);
      gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), this.atlasUnit);
      gl.uniform1i(gl.getUniformLocation(program, "uChunks"), this.chunksUnit);
    }

    renderer.texture.bind(this.pulledRows, this.rowsUnit);
    renderer.texture.bind(this.atlasTexture as BufferImageSource, this.atlasUnit);
    renderer.texture.bind(this.chunks, this.chunksUnit);
    renderer.geometry.bind(this.empty, shader.glProgram);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, CHUNK, chunks);
    drawn.calls++;
    drawn.draws += rows;
  }

  /**
   * The expanded atlas' texture made `indices` texels, at least, its first
   * `kept` copied over on the GPU; past the most it may hold, pulled draws
   * are left till the context is lost or restored.
   */
  private resizeAtlasTexture(indices: number, kept: number): void {
    if (this.pullFailed) {
      return;
    }

    const lines = Math.max(1, Math.ceil(indices / ATLAS_WIDTH));
    if (lines > this.atlasMostLines) {
      this.pullFailed = true;
      this.atlasTexture?.destroy();
      this.atlasTexture = null;
      return;
    }

    const old = this.atlasTexture;
    if (old && old.pixelHeight === lines) {
      return;
    }

    const texture = atlasSource(lines);
    const renderer = this.renderer;
    if (old && kept > 0) {
      // Blitted, as a float texture may not be copied with copyTexSubImage2D, from a framebuffer
      // of each, the scissor test off as it would cut the blit, and GL's bindings put back.
      const gl = renderer.gl;
      this.copyFrames ??= [gl.createFramebuffer(), gl.createFramebuffer()];
      const [read, draw] = this.copyFrames;
      const readBefore = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const drawBefore = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      renderer.texture.bindForUpload(texture, this.atlasUnit);
      const color = gl.COLOR_ATTACHMENT0;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.framebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        color,
        gl.TEXTURE_2D,
        renderer.texture.getGlSource(old).texture,
        0,
      );
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        color,
        gl.TEXTURE_2D,
        renderer.texture.getGlSource(texture).texture,
        0,
      );
      if (scissor) {
        gl.disable(gl.SCISSOR_TEST);
      }

      const lines = Math.min(Math.ceil(kept / ATLAS_WIDTH), old.pixelHeight);
      gl.blitFramebuffer(
        0,
        0,
        ATLAS_WIDTH,
        lines,
        0,
        0,
        ATLAS_WIDTH,
        lines,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      if (scissor) {
        gl.enable(gl.SCISSOR_TEST);
      }

      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, color, gl.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, color, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBefore);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBefore);
    }

    old?.destroy();
    this.atlasTexture = texture;
  }

  /** `count` expanded indices of `data`, from index `from`, written into the texture from `at` on, a line at a time. */
  private writeAtlasTexture(at: number, data: Uint32Array, from: number, count: number): void {
    const texture = this.atlasTexture;
    if (this.pullFailed || !texture) {
      return;
    }

    const renderer = this.renderer;
    const gl = renderer.gl;
    renderer.texture.bindForUpload(texture, this.atlasUnit);
    const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
    let index = at;
    let source = from * EXPANDED_WORDS;
    const end = at + count;
    while (index < end) {
      const x = index % ATLAS_WIDTH;
      const y = (index - x) / ATLAS_WIDTH;
      // The rest of a line it starts inside, or the whole lines after, or what is left of the last.
      const whole = x === 0 ? Math.floor((end - index) / ATLAS_WIDTH) : 0;
      const width = whole > 0 ? ATLAS_WIDTH : Math.min(ATLAS_WIDTH - x, end - index);
      const height = Math.max(whole, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.FLOAT, floats, source);
      index += width * height;
      source += width * height * EXPANDED_WORDS;
    }
  }

  /**
   * The prototype's (copied from resizeAtlasTexture): the expanded atlas' texture made `indices` texels, at least, its first
   * `kept` copied over on the GPU; past the most it may hold, pulled draws
   * are left till the context is lost or restored.
   */
  private resizeProtoAtlas(indices: number, kept: number): void {
    if (this.protoAtlasFailed) {
      return;
    }

    const lines = Math.max(1, Math.ceil(indices / ATLAS_WIDTH));
    if (lines > this.atlasMostLines) {
      this.protoAtlasFailed = true;
      this.protoAtlasTexture?.destroy();
      this.protoAtlasTexture = null;
      return;
    }

    const old = this.protoAtlasTexture;
    if (old && old.pixelHeight === lines) {
      return;
    }

    const texture = atlasSource(lines);
    const renderer = this.renderer;
    if (old && kept > 0) {
      // Blitted, as a float texture may not be copied with copyTexSubImage2D, from a framebuffer
      // of each, the scissor test off as it would cut the blit, and GL's bindings put back.
      const gl = renderer.gl;
      this.copyFrames ??= [gl.createFramebuffer(), gl.createFramebuffer()];
      const [read, draw] = this.copyFrames;
      const readBefore = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const drawBefore = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const scissor = gl.isEnabled(gl.SCISSOR_TEST);
      renderer.texture.bindForUpload(texture, this.atlasUnit);
      const color = gl.COLOR_ATTACHMENT0;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.framebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        color,
        gl.TEXTURE_2D,
        renderer.texture.getGlSource(old).texture,
        0,
      );
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.framebufferTexture2D(
        gl.DRAW_FRAMEBUFFER,
        color,
        gl.TEXTURE_2D,
        renderer.texture.getGlSource(texture).texture,
        0,
      );
      if (scissor) {
        gl.disable(gl.SCISSOR_TEST);
      }

      const lines = Math.min(Math.ceil(kept / ATLAS_WIDTH), old.pixelHeight);
      gl.blitFramebuffer(
        0,
        0,
        ATLAS_WIDTH,
        lines,
        0,
        0,
        ATLAS_WIDTH,
        lines,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      if (scissor) {
        gl.enable(gl.SCISSOR_TEST);
      }

      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, color, gl.TEXTURE_2D, null, 0);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, color, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readBefore);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawBefore);
    }

    old?.destroy();
    this.protoAtlasTexture = texture;
  }

  /** `count` expanded indices of `data`, from index `from`, written into the texture from `at` on, a line at a time. */
  private writeProtoAtlas(at: number, data: Uint32Array, from: number, count: number): void {
    const texture = this.protoAtlasTexture;
    if (this.protoAtlasFailed || !texture) {
      return;
    }

    const renderer = this.renderer;
    const gl = renderer.gl;
    renderer.texture.bindForUpload(texture, this.atlasUnit);
    const floats = new Float32Array(data.buffer, data.byteOffset, data.length);
    let index = at;
    let source = from * EXPANDED_WORDS;
    const end = at + count;
    while (index < end) {
      const x = index % ATLAS_WIDTH;
      const y = (index - x) / ATLAS_WIDTH;
      // The rest of a line it starts inside, or the whole lines after, or what is left of the last.
      const whole = x === 0 ? Math.floor((end - index) / ATLAS_WIDTH) : 0;
      const width = whole > 0 ? ATLAS_WIDTH : Math.min(ATLAS_WIDTH - x, end - index);
      const height = Math.max(whole, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.FLOAT, floats, source);
      index += width * height;
      source += width * height * EXPANDED_WORDS;
    }
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

    drawn.calls += loop && rows ? draws : 1;
    drawn.draws += draws;
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
  private upload(
    from: number,
    to: number,
    table = this.table,
    texels = ROW_TEXELS,
    unit = 0,
    perLine = ROWS_A_LINE,
  ): void {
    const renderer = this.renderer;
    const gl = renderer.gl;
    // Bound as Pixi binds, a new table allocated and uploaded whole then, and to the active unit,
    // which a render pass may have moved to unbind a back texture: the upload must go to `unit`.
    renderer.texture.bindForUpload(table, unit);

    const first = Math.floor(from / perLine);
    const lines = Math.floor((to - 1) / perLine) - first + 1;
    const start = lines > 1 ? first * perLine : from;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      (start - first * perLine) * texels,
      first,
      lines > 1 ? perLine * texels : (to - from) * texels,
      lines,
      gl.RGBA,
      gl.FLOAT,
      table.resource as Float32Array,
      start * texels * 4,
    );
  }

  destroy(): void {
    if (this.renderer.type !== RendererType.WEBGL) {
      return;
    }

    this.shader?.destroy(true);
    this.shortShader?.destroy(true);
    this.pulledShader?.destroy(true);
    for (const shader of this.protoShaders.values()) {
      shader.destroy(true);
    }

    this.sprites.destroy();
    this.keptRows.destroy();
    this.keptChunks.destroy();
    this.keptSprites.destroy();
    this.geometry.destroy(true);
    this.empty.destroy();
    this.table.destroy();
    this.pulledRows.destroy();
    this.chunks.destroy();
    this.atlasTexture?.destroy();
    this.protoAtlasTexture?.destroy();
    this.protoAtlas.destroy();
    for (const frame of this.copyFrames ?? []) {
      this.renderer.gl.deleteFramebuffer(frame);
    }

    this.atlas.destroy();
    this.pulled.destroy();
  }
}

extensions.add(TablePipe);
