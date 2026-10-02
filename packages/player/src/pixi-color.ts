// Colour transforms that Pixi's tint cannot draw: offsets, and multipliers
// beyond 0 to 1 (docs/architecture.md, "Colour transforms"). What is drawn
// under one goes to a batcher of its own, whose vertices carry the whole
// transform, and whose shader applies it to the straight colour: a fill's
// colour and alpha as the vertex has them, a texture's unpremultiplied.
// Pixi names a batchable's batcher "default" itself; here it is the
// renderable's `flashColor` that decides.
import type { ColorTransform } from "@swf2es/format";
import {
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
  generateTextureBatchBit,
  generateTextureBatchBitGl,
  getBatchSamplersUniformGroup,
  roundPixelsBit,
  roundPixelsBitGl,
  Shader,
} from "pixi.js";

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
      vColor *= aColor;
      vMul = aMul;
      vAdd = aAdd;
    `,
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
      vColor *= aColor;
      vMul = aMul;
      vAdd = aAdd;
    `,
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

/** The straight colour, ABGR as the colour attribute reads it: a fill's own, else white. */
function straight(element: Extra): number {
  const rgb = element.baseColor ?? 0xffffff;
  const alpha = element.alpha ?? 1;
  return (
    (((alpha * 255) << 24) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0
  );
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

class ColorBatcher extends Batcher {
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
// The name set, Pixi's "default" or another a host gives, is kept; a
// renderable under a colour transform goes to this batcher over it.
for (const proto of [BatchableGraphics.prototype, BatchableSprite.prototype]) {
  Object.defineProperty(proto, "batcherName", {
    configurable: true,
    get(this: { renderable?: Colored | null; $batcherName?: string }) {
      return this.renderable?.flashColor ? NAME : (this.$batcherName ?? "default");
    },
    set(this: { $batcherName?: string }, name: string) {
      this.$batcherName = name;
    },
  });
}

/**
 * Draw `leaf` and what is in it under `ct`, or under Pixi's tint again for
 * null. Moving between batchers rebuilds the render group's instructions;
 * another transform in the same batcher packs the vertices again.
 */
export function setFlashColor(leaf: Container, ct: ColorTransform | null): void {
  const colored = leaf as Colored;
  const was = colored.flashColor ?? null;
  if (was === ct) {
    return;
  }

  colored.flashColor = ct;
  // Pixi draws a large Graphics unbatched, with its own shader, which has no
  // transform: under one it is batched whatever its size, from then on.
  if (ct && leaf instanceof Graphics && leaf.context.batchMode !== "batch") {
    leaf.context.batchMode = "batch";
    leaf.context.dirty = true;
  }

  const view = leaf as Container & { onViewUpdate?: () => void };
  if ((was === null) !== (ct === null)) {
    const group = (leaf.renderGroup ?? leaf.parentRenderGroup) as { structureDidChange: boolean };
    if (group) {
      group.structureDidChange = true;
    }
  } else {
    view.onViewUpdate?.();
  }

  for (const child of leaf.children) {
    setFlashColor(child, ct);
  }
}
