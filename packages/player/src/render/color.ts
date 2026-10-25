// Colour transforms that Pixi's tint cannot draw: offsets, and multipliers
// beyond 0 to 1 (docs/architecture.md, "Colour transforms"). What is drawn
// under one goes to a batcher of its own, whose vertices carry the whole
// transform, and whose shader applies it to the straight colour: a fill's
// colour and alpha as the vertex has them, a texture's unpremultiplied.
// Pixi names a batchable's batcher "default" itself; here it is the
// renderable's `flashColor` that decides (batcherNameFor).
import type { ColorTransform } from "@swf2es/format";
import {
  type BatchableElement,
  BatchableGraphics,
  BatchableSprite,
  Batcher,
  type BatcherOptions,
  Buffer,
  BufferUsage,
  type Container,
  compileHighShaderGlProgram,
  compileHighShaderGpuProgram,
  type DefaultBatchableMeshElement,
  type DefaultBatchableQuadElement,
  ExtensionType,
  extensions,
  Geometry,
  Graphics,
  type GraphicsContext,
  type GraphicsPath,
  generateTextureBatchBit,
  generateTextureBatchBitGl,
  getBatchSamplersUniformGroup,
  localUniformBitGl,
  Matrix,
  type Renderer,
  RendererType,
  roundPixelsBit,
  roundPixelsBitGl,
  Shader,
  UniformGroup,
} from "pixi.js";
import { copyContext } from "./tessellate.js";

const NAME = "flash-color";

/** Position 2, UV 2, colour 1, texture and rounding 1, multipliers 4, offsets 4. */
const VERTEX_SIZE = 14;

/** A renderable with the transform it draws under, where Pixi's tint cannot draw it. */
type Colored = Container & { flashColor?: ColorTransform | null };

/** What a batchable has beside Pixi's types: its renderable, and a fill's own colour and alpha. */
interface Extra {
  renderable?: Colored | null;
  baseColor?: number;
  alpha?: number;
}

const colorBitGl = {
  name: "flash-color-bit",
  vertex: {
    header: `
      in vec4 aColor;
      in vec4 aMul;
      in vec4 aAdd;
      out vec4 vMul;
      out vec4 vAdd;
    `,
    main: `
      vMul = aMul;
      vAdd = aAdd;
    `,
    // flashColor already includes the group's ancestors; Pixi's global colour would apply them twice.
    end: `vColor = aColor;`,
  },
  fragment: {
    header: `
      in vec4 vMul;
      in vec4 vAdd;
    `,
    end: `
      if (outColor.a == 0.0) {
        finalColor = vec4(0.0);
      } else {
        vec4 straight = vec4(outColor.rgb / outColor.a * vColor.rgb, outColor.a * vColor.a);
        vec4 c = clamp(straight * vMul + vAdd, 0.0, 1.0);
        finalColor = vec4(c.rgb * c.a, c.a);
      }
    `,
  },
};

/**
 * The colour batcher's colour for Pixi's graphics shader, which draws a
 * Graphics alone under its transform: the straight colour as the batcher
 * packs it (straight), the fill's from the vertex times the Graphics' own
 * tint, rounded to a byte, and its alpha truncated to one; the transform in
 * uniforms.
 */
const aloneBitGl = {
  name: "flash-color-alone-bit",
  vertex: {
    header: `
      in vec4 aColor;
      uniform vec4 uOwn;
    `,
    // After Pixi's tint and world colour, which it replaces: the transform includes every ancestor's.
    end: `
      vColor = vec4(
        floor(aColor.rgb * uOwn.rgb * 255.0 + 0.5),
        floor(aColor.a * uOwn.a * 255.0 + 0.001)
      ) / 255.0;
    `,
  },
  fragment: {
    header: `
      uniform vec4 uMul;
      uniform vec4 uAdd;
    `,
    end: `
      if (outColor.a == 0.0) {
        finalColor = vec4(0.0);
      } else {
        vec4 straight = vec4(outColor.rgb / outColor.a * vColor.rgb, outColor.a * vColor.a);
        vec4 c = clamp(straight * uMul + uAdd, 0.0, 1.0);
        finalColor = vec4(c.rgb * c.a, c.a);
      }
    `,
  },
};

const colorBit = {
  name: "flash-color-bit",
  vertex: {
    header: `
      @in aColor: vec4<f32>;
      @in aMul: vec4<f32>;
      @in aAdd: vec4<f32>;
      @out vMul: vec4<f32>;
      @out vAdd: vec4<f32>;
    `,
    main: `
      vMul = aMul;
      vAdd = aAdd;
    `,
    end: `vColor = aColor;`,
  },
  fragment: {
    header: `
      @in vMul: vec4<f32>;
      @in vAdd: vec4<f32>;
    `,
    end: `
      if (outColor.a == 0.0) {
        finalColor = vec4<f32>(0.0);
      } else {
        let straight = vec4<f32>(outColor.rgb / outColor.a * vColor.rgb, outColor.a * vColor.a);
        let c = clamp(straight * vMul + vAdd, vec4<f32>(0.0), vec4<f32>(1.0));
        finalColor = vec4<f32>(c.rgb * c.a, c.a);
      }
    `,
  },
};

class ColorShader extends Shader {
  readonly maxTextures: number;

  constructor(maxTextures: number) {
    super({
      glProgram: compileHighShaderGlProgram({
        name: NAME,
        bits: [colorBitGl, generateTextureBatchBitGl(maxTextures), roundPixelsBitGl],
      }),
      gpuProgram: compileHighShaderGpuProgram({
        name: NAME,
        bits: [colorBit, generateTextureBatchBit(maxTextures), roundPixelsBit],
      }),
      resources: { batchSamplers: getBatchSamplersUniformGroup(maxTextures) },
    });
    this.maxTextures = maxTextures;
  }
}

class ColorGeometry extends Geometry {
  constructor() {
    const buffer = new Buffer({
      data: new Float32Array(1),
      label: "flash-color-attributes",
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    const stride = VERTEX_SIZE * 4;
    super({
      attributes: {
        aPosition: { buffer, format: "float32x2", stride, offset: 0 },
        aUV: { buffer, format: "float32x2", stride, offset: 8 },
        aColor: { buffer, format: "unorm8x4", stride, offset: 16 },
        aTextureIdAndRound: { buffer, format: "uint16x2", stride, offset: 20 },
        aMul: { buffer, format: "float32x4", stride, offset: 24 },
        aAdd: { buffer, format: "float32x4", stride, offset: 40 },
      },
      indexBuffer: new Buffer({
        data: new Uint32Array(1),
        label: "flash-color-indices",
        usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
        shrinkToFit: false,
      }),
    });
  }
}

/** Shaders by texture count: every batcher of one count shares one. */
const shaders = new Map<number, ColorShader>();

/**
 * The straight colour, ABGR as the colour attribute reads it: a fill's own,
 * else white, times the renderable's own tint and alpha, a glyph's colour
 * as text draws it. Not its group's: what its ancestors' colour transforms
 * make is in its flashColor, and their tint stays white under one.
 */
function straight(element: Extra): number {
  const own = element.renderable as
    | (Container & { tint: number; alpha: number })
    | null
    | undefined;
  const fill = element.baseColor ?? 0xffffff;
  const tint = own?.tint ?? 0xffffff;
  const alpha = (element.alpha ?? 1) * (own?.alpha ?? 1);
  return (
    (((alpha * 255) << 24) |
      (channel(fill, tint, 0) << 16) |
      (channel(fill, tint, 8) << 8) |
      channel(fill, tint, 16)) >>>
    0
  );
}

/** A channel of a fill's colour times the tint's; apart, not a closure made for each element packed. */
function channel(fill: number, tint: number, shift: number): number {
  return Math.round((((fill >> shift) & 0xff) * ((tint >> shift) & 0xff)) / 255);
}

const NONE: ColorTransform = {
  rMul: 1,
  gMul: 1,
  bMul: 1,
  aMul: 1,
  rAdd: 0,
  gAdd: 0,
  bAdd: 0,
  aAdd: 0,
};

export class ColorBatcher extends Batcher {
  static extension = { type: [ExtensionType.Batcher], name: NAME };

  name = NAME;
  vertexSize = VERTEX_SIZE;
  geometry = new ColorGeometry();
  shader: ColorShader;

  constructor(options: BatcherOptions) {
    super(options);
    const max = options.maxTextures ?? 16;
    let shader = shaders.get(max);
    if (!shader) {
      shader = new ColorShader(max);
      shaders.set(max, shader);
    }

    this.shader = shader;
  }

  /** The vertex's colour, texture and transform after its position and UV, which `at` holds. */
  private tail(
    f32: Float32Array,
    u32: Uint32Array,
    at: number,
    color: number,
    texture: number,
    ct: ColorTransform,
  ): void {
    u32[at] = color;
    u32[at + 1] = texture;
    f32[at + 2] = ct.rMul;
    f32[at + 3] = ct.gMul;
    f32[at + 4] = ct.bMul;
    f32[at + 5] = ct.aMul;
    f32[at + 6] = ct.rAdd / 255;
    f32[at + 7] = ct.gAdd / 255;
    f32[at + 8] = ct.bAdd / 255;
    f32[at + 9] = ct.aAdd / 255;
  }

  packAttributes(
    element: DefaultBatchableMeshElement,
    f32: Float32Array,
    u32: Uint32Array,
    index: number,
    textureId: number,
  ): void {
    const extra = element as unknown as Extra;
    const texture = (textureId << 16) | (element.roundPixels & 0xffff);
    const { a, b, c, d, tx, ty } = element.transform;
    const { positions, uvs } = element;
    const color = straight(extra);
    const ct = extra.renderable?.flashColor ?? NONE;
    const end = element.attributeOffset + element.attributeSize;
    for (let i = element.attributeOffset; i < end; i++) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      f32[index] = a * x + c * y + tx;
      f32[index + 1] = d * y + b * x + ty;
      f32[index + 2] = uvs[i * 2];
      f32[index + 3] = uvs[i * 2 + 1];
      this.tail(f32, u32, index + 4, color, texture, ct);
      index += VERTEX_SIZE;
    }
  }

  packQuadAttributes(
    element: DefaultBatchableQuadElement,
    f32: Float32Array,
    u32: Uint32Array,
    index: number,
    textureId: number,
  ): void {
    const extra = element as unknown as Extra;
    const texture = (textureId << 16) | (element.roundPixels & 0xffff);
    const m = element.transform;
    const { minX, minY, maxX, maxY } = element.bounds;
    const uv = element.texture.uvs;
    const color = straight(extra);
    const ct = extra.renderable?.flashColor ?? NONE;
    const corner = (at: number, x: number, y: number, u: number, v: number) => {
      f32[at] = m.a * x + m.c * y + m.tx;
      f32[at + 1] = m.d * y + m.b * x + m.ty;
      f32[at + 2] = u;
      f32[at + 3] = v;
      this.tail(f32, u32, at + 4, color, texture, ct);
    };
    corner(index, minX, minY, uv.x0, uv.y0);
    corner(index + VERTEX_SIZE, maxX, minY, uv.x1, uv.y1);
    corner(index + VERTEX_SIZE * 2, maxX, maxY, uv.x2, uv.y2);
    corner(index + VERTEX_SIZE * 3, minX, maxY, uv.x3, uv.y3);
  }
}

extensions.add(ColorBatcher);

/**
 * The batcher an element goes to (render/hooks.ts): a Graphics' or a
 * sprite's under a colour transform to this batcher, any other to the one
 * it names, Pixi's "default" or another a host gives.
 */
export function batcherNameFor(element: BatchableElement): string {
  if (element instanceof BatchableGraphics || element instanceof BatchableSprite) {
    if ((element.renderable as Colored | null)?.flashColor) {
      return NAME;
    }
  }

  return element.batcherName;
}

/** Each unbatched context's batched copy, made when a Graphics drawing it is first colour-transformed. */
const batchedCopies = new WeakMap<GraphicsContext, GraphicsContext>();

/**
 * `context`, batched: a shared one, which shapes, glyphs and lines make
 * "no-batch" (render/tessellate.ts, shapeContext), as a copy; a Graphics' own, as itself.
 */
function batched(context: GraphicsContext): GraphicsContext {
  if (context.batchMode === "batch") {
    return context;
  }

  if (context.batchMode !== "no-batch") {
    context.batchMode = "batch";
    return context;
  }

  let copy = batchedCopies.get(context);
  if (!copy) {
    copy = copyContext(context);
    copy.batchMode = "batch";
    // Its triangles are the original's, built already where it was drawn alone: earcut, at
    // the most a frame of a crowded room took building shapes, runs once for both.
    copy.tessellationOf = context;
    batchedCopies.set(context, copy);
  }

  return copy;
}

/** A context destroyed: its batched copy, if it has one, taken for it to destroy too. */
export function takeBatchedCopy(context: GraphicsContext): GraphicsContext | undefined {
  const copy = batchedCopies.get(context);
  batchedCopies.delete(context);
  return copy;
}

/**
 * A Graphics that may show another context than the one it stands for: the
 * shared one it was given (`shared`), and `show` to draw another, as a
 * shape's lines swap theirs (render/shared.ts, SharedGraphics).
 */
export type SharingGraphics = Graphics & {
  shared?: GraphicsContext;
  show?: (context: GraphicsContext) => void;
  /** Whether it is in a render group settled long enough to batch it (render/settle.ts, settle). */
  settled?: boolean;
};

/**
 * Vertices of a context from which, under a colour transform, it is drawn
 * alone rather than as a batched copy: Pixi's own line between the
 * Graphics it batches and those it draws alone.
 */
const ALONE_VERTICES = 200;
/** Each shared context's vertices as weighed: it never changes. */
const weights = new WeakMap<GraphicsContext, number>();

/** The points of `path`'s shapes, which Pixi builds once and keeps for the context's build. */
function pointsOf(path: GraphicsPath | undefined): number {
  let points = 0;
  for (const { shape } of path?.shapePath.shapePrimitives ?? []) {
    const polygon = (shape as { points?: number[] }).points;
    points += polygon ? polygon.length / 2 : 4;
  }

  return points;
}

/**
 * Vertices a line has a point, as Pixi strokes it: a pixel line's one, a
 * line with round joins some 11 to 15 for a creature's parts (10 taken, so
 * that a short one stays batched), others two.
 */
function lineVertices(style: { join?: string; pixelLine?: boolean }): number {
  return style.pixelLine ? 1 : style.join === "round" ? 10 : 2;
}

/**
 * Whether `context` has ALONE_VERTICES or more, weighed from its paths
 * before it is built, as a part may show under a transform it then keeps,
 * and lines are swapped for new contexts as they turn: a fill a vertex a
 * point, a line as lineVertices says, a texture four. Weighed once built
 * too, as a view's contexts let go of their paths then (render/tessellate.ts).
 */
export function weigh(context: GraphicsContext): boolean {
  let vertices = weights.get(context);
  if (vertices === undefined) {
    vertices = 0;
    for (const instruction of context.instructions) {
      if (instruction.action === "texture") {
        vertices += 4;
        continue;
      }

      if (instruction.action === "geometry") {
        vertices += instruction.data.geometry.vertices.length / 2;
        continue;
      }

      const data = instruction.data as {
        path?: GraphicsPath;
        hole?: GraphicsPath;
        style: { join?: string; pixelLine?: boolean };
      };
      vertices +=
        pointsOf(data.path) * (instruction.action === "stroke" ? lineVertices(data.style) : 1);
      vertices += pointsOf(data.hole);
    }

    weights.set(context, vertices);
  }

  return vertices >= ALONE_VERTICES;
}

/** The renderers made, and those of them not WebGL, where Pixi's shader takes no colour transform. */
const renderers = new Set<object>();
const notWebGL = new Set<object>();
/** Graphics drawn alone under a colour transform, to be shown as batched copies if a renderer cannot. */
const shownAlone = new Set<SharingGraphics>();

/**
 * Notes each renderer as it is made, of any kind, as a renderer that is
 * not WebGL may come after Graphics were shown alone for one that is.
 */
export class ColorAloneSystem {
  static extension = {
    type: [ExtensionType.WebGLSystem, ExtensionType.WebGPUSystem, ExtensionType.CanvasSystem],
    name: "flashColorAlone",
  } as const;

  constructor(renderer: { type: number }) {
    renderers.add(this);
    if (renderer.type !== RendererType.WEBGL) {
      notWebGL.add(this);
      for (const g of [...shownAlone]) {
        showFor(g, (g as Colored).flashColor ?? null);
      }
    }
  }

  destroy(): void {
    renderers.delete(this);
    notWebGL.delete(this);
  }
}

extensions.add(ColorAloneSystem);

/** A Graphics destroyed: no longer one to show otherwise. */
export function forgetShown(g: SharingGraphics): void {
  shownAlone.delete(g);
}

/**
 * The context a Graphics should draw under `ct`. An unbatched one, as a
 * shape's are (render/tessellate.ts), Pixi draws with its own shader, which
 * has no colour transform, so under one it draws a batched copy; but a
 * large one, as a creature's parts are, is drawn alone still, by the
 * transform table (render/table.ts), whose rows carry a colour transform,
 * or by Pixi's pipe with the colour shader (colorShaderFor),
 * where every renderer is WebGL; a SharedGraphics alone, which forgets it
 * as it goes (render/shared.ts). The
 * context it stands for is shared by every instance of a character, and
 * every text in a font, and is never changed: switched to batched, the
 * Graphics of the others, made unbatched, drew nothing.
 *
 * In a settled group, batched copies are packed once and drawn in a few
 * calls. In one rebuilt often, as an animated character's is, a batched
 * copy's vertices were packed again with every rebuild, and a tween of the
 * transform repacked them each frame: a creature fading out packed and
 * uploaded every vertex of its every part, frame after frame. Drawn alone,
 * a draw writes a row or a few uniforms instead. Small ones stay batched:
 * a draw apiece costs more than packing their few vertices
 * (`bench.ts --branches 64`).
 */
export function showFor(g: SharingGraphics, ct: ColorTransform | null): void {
  const shared = g.shared ?? g.context;
  const alone =
    !!ct &&
    !g.settled &&
    !!g.show &&
    shared.batchMode === "no-batch" &&
    renderers.size > 0 &&
    notWebGL.size === 0 &&
    weigh(shared);
  const want = alone || !(ct || g.settled) ? shared : batched(shared);
  if (alone) {
    shownAlone.add(g);
  } else {
    shownAlone.delete(g);
  }

  if (g.context !== want) {
    if (g.show) {
      g.show(want);
    } else {
      g.context = want;
    }
  }

  g.shared = shared;
}

/** Pixi's graphics shader with the colour batcher's colour, by texture count. */
const aloneShaders = new Map<number, Shader>();

function aloneShader(maxTextures: number): Shader {
  let shader = aloneShaders.get(maxTextures);
  if (!shader) {
    shader = new Shader({
      glProgram: compileHighShaderGlProgram({
        name: `${NAME}-alone`,
        bits: [
          aloneBitGl,
          generateTextureBatchBitGl(maxTextures),
          localUniformBitGl,
          roundPixelsBitGl,
        ],
      }),
      resources: {
        localUniforms: new UniformGroup({
          uColor: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
          uTransformMatrix: { value: new Matrix(), type: "mat3x3<f32>" },
          uRound: { value: 0, type: "f32" },
        }),
        flashUniforms: new UniformGroup({
          uOwn: { value: new Float32Array(4), type: "vec4<f32>" },
          uMul: { value: new Float32Array(4), type: "vec4<f32>" },
          uAdd: { value: new Float32Array(4), type: "vec4<f32>" },
        }),
        batchSamplers: getBatchSamplersUniformGroup(maxTextures),
      },
    });
    aloneShaders.set(maxTextures, shader);
  }

  return shader;
}

/**
 * The shader a Graphics drawn alone is drawn with (render/hooks.ts): under
 * a colour transform, as in a render group that has not settled, the
 * colour shader, the transform and the Graphics' own tint and alpha in its
 * uniforms, which Pixi's pipe then fills its local uniforms of; otherwise
 * Pixi's, from null. Its context, shared, is never packed: a gradient's or
 * a bitmap's, which the table cannot draw. It leans on the order of the
 * shader's sections, Pixi's local uniforms' colour applied in the vertex's
 * main before aloneBitGl's end replaces it.
 */
export function colorShaderFor(graphics: Graphics, renderer: Renderer): Shader | null {
  const ct = (graphics as Colored).flashColor;
  if (!ct || renderer.type !== RendererType.WEBGL) {
    return null;
  }

  const shader = aloneShader(renderer.limits.maxBatchableTextures);
  const uniforms = (shader.resources.flashUniforms as UniformGroup).uniforms;
  const own = uniforms.uOwn as Float32Array;
  const bgr = graphics.localColor;
  own[0] = (bgr & 0xff) / 255;
  own[1] = ((bgr >> 8) & 0xff) / 255;
  own[2] = ((bgr >> 16) & 0xff) / 255;
  own[3] = graphics.localAlpha;
  const mul = uniforms.uMul as Float32Array;
  mul[0] = ct.rMul;
  mul[1] = ct.gMul;
  mul[2] = ct.bMul;
  mul[3] = ct.aMul;
  const add = uniforms.uAdd as Float32Array;
  add[0] = ct.rAdd / 255;
  add[1] = ct.gAdd / 255;
  add[2] = ct.bAdd / 255;
  add[3] = ct.aAdd / 255;
  return shader;
}

/**
 * Draw `leaf` and what is in it under `ct`, or under Pixi's tint again for
 * null. Moving between batchers rebuilds the render group's instructions;
 * another transform in the same batcher packs the vertices again. A
 * Graphics the table draws, before and after, reads its transform as its
 * row is written, and needs neither.
 */
export function setFlashColor(leaf: Container, ct: ColorTransform | null): void {
  const colored = leaf as Colored;
  const was = colored.flashColor ?? null;
  if (was === ct) {
    return;
  }

  colored.flashColor = ct;
  let drawnAlone = false;
  if (leaf instanceof Graphics) {
    const before = leaf.context;
    showFor(leaf, ct);
    drawnAlone = leaf.context === before && before.batchMode === "no-batch";
  }

  const view = leaf as Container & { onViewUpdate?: () => void };
  if (!drawnAlone && (was === null) !== (ct === null)) {
    const group = (leaf.renderGroup ?? leaf.parentRenderGroup) as { structureDidChange: boolean };
    if (group) {
      group.structureDidChange = true;
    }
  } else if (!drawnAlone) {
    view.onViewUpdate?.();
  }

  for (const child of leaf.children) {
    setFlashColor(child, ct);
  }
}
