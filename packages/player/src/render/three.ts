// A 3D display object drawn as Flash Player and adl draw one: what it and
// its children draw, in its own space, a pixel of it a texel, is drawn
// into a bitmap of its own, and the bitmap is drawn smoothed through the
// object's plane in perspective (display/perspective.ts). So a card that
// turns about y narrows toward its far edge, and one scaled up in 3D is
// as blurred as Flash's, a texel magnified. The bitmap is anti-aliased as
// the stage is, drawn at SAMPLES a side and averaged down to a texel a
// pixel in one pass, and has a texel of nothing around it, which the
// smoothing fades its edges into as Flash's are (docs/architecture.md, "3D
// display objects"). A large object is drawn at fewer samples, so that
// what it is drawn at fits the GPU's largest texture and a budget.
//
// The quad is a mesh of its four corners, each with the w its plane gives
// it: the GPU then interpolates the bitmap's coordinates in perspective
// across it, as two affine triangles would not.
import type { Matrix as Affine } from "@swf2es/format";
import {
  type Filter,
  GlProgram,
  Graphics,
  Matrix,
  Mesh,
  MeshGeometry,
  Container as PixiContainer,
  type Renderer,
  RenderTexture,
  Shader,
  Sprite,
  Texture,
  TextureSource,
  UniformGroup,
} from "pixi.js";
import { bitmapScale, type PlaneQuad, placeQuad, SAMPLES } from "../display/plane.js";
import { drawTarget, releaseDrawTarget } from "./pools.js";

export { SAMPLES } from "../display/plane.js";

/** Each renderer's largest texture a side. */
const largestTextures = new WeakMap<Renderer, number>();

function largestTexture(renderer: Renderer): number {
  let largest = largestTextures.get(renderer);
  if (largest === undefined) {
    const gl = (renderer as { gl?: WebGLRenderingContext }).gl;
    largest = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096;
    largestTextures.set(renderer, largest);
  }

  return largest;
}

const vertex = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
in float aW;
out vec2 vUV;
out vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 p = mvp * vec3(aPosition * aW, aW);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUV = aUV;
  vColor = uColor * uWorldColorAlpha;
}
`;

// Its colour is in its bitmap, all above it drawn into it (view.ts): Pixi's is not taken.
// Sampled where the pixel it is in has its centre: Flash smooths the bitmap
// once a pixel, and the target's samples (uPixel a side of a pixel, for
// the page that draws finer to average down) all take that pixel's value.
const fragment = `#version 300 es
in vec2 vUV;
in vec4 vColor;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uPixel;

void main(void) {
  vec2 d = (floor(gl_FragCoord.xy / uPixel) + 0.5) * uPixel - gl_FragCoord.xy;
  vec2 uv = vUV + dFdx(vUV) * d.x + dFdy(vUV) * d.y;
  finalColor = texture(uTexture, uv);
}
`;

// A bitmap drawn at n samples a side averaged down to a texel a pixel in one pass: four smoothed
// reads, each the mean of a square of four samples, at the corners of the middle of its n by n.
const average = `#version 300 es
in vec2 vUV;
in vec4 vColor;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec2 uReach;

void main(void) {
  finalColor = 0.25 * (texture(uTexture, vUV + vec2(-uReach.x, -uReach.y))
    + texture(uTexture, vUV + vec2(uReach.x, -uReach.y))
    + texture(uTexture, vUV + vec2(-uReach.x, uReach.y))
    + texture(uTexture, vUV + uReach));
}
`;

let program: GlProgram | null = null;
let averageProgram: GlProgram | null = null;

/** A quad over a target, drawing a texture averaged down to it (`average`); one a renderer, kept. */
class Averager {
  private readonly unbound = new TextureSource();
  private readonly positions = new Float32Array(8);
  private readonly uvs = new Float32Array(8);
  private readonly geometry = new MeshGeometry({
    positions: this.positions,
    uvs: this.uvs,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  private readonly shader: Shader;
  readonly mesh: Mesh<MeshGeometry, Shader>;

  constructor() {
    averageProgram ??= new GlProgram({
      vertex: vertex.replace("in float aW;\n", "").replace("aPosition * aW, aW", "aPosition, 1.0"),
      fragment: average,
      name: "flash-plane-average",
    });
    this.shader = new Shader({
      glProgram: averageProgram,
      resources: {
        uTexture: this.unbound,
        averageUniforms: new UniformGroup({
          uReach: { value: new Float32Array(2), type: "vec2<f32>" },
        }),
      },
    });
    this.mesh = new Mesh<MeshGeometry, Shader>({ geometry: this.geometry, shader: this.shader });
  }

  /**
   * The top left w by h texels of `target` averaged from `source`, `samples` texels a side a
   * texel of it: the textures are kept in sizes of whole steps, larger than what they hold.
   */
  draw(
    renderer: Renderer,
    source: RenderTexture,
    target: RenderTexture,
    w: number,
    h: number,
    samples: number,
  ): void {
    if (this.positions[2] !== w || this.positions[5] !== h) {
      this.positions.set([0, 0, w, 0, w, h, 0, h]);
      this.geometry.getBuffer("aPosition").update();
    }

    const u = (w * samples) / source.width;
    const v = (h * samples) / source.height;
    if (this.uvs[2] !== u || this.uvs[5] !== v) {
      this.uvs.set([0, 0, u, 0, u, v, 0, v]);
      this.geometry.getBuffer("aUV").update();
    }

    source.source.scaleMode = "linear";
    this.shader.resources.uTexture = source.source;
    this.mesh.texture = source;
    // A texel of the target is samples by samples of the source: reads a sample off its middle
    // each way take four samples each, at 2 a side one read at the middle takes them all.
    const reach = this.shader.resources.averageUniforms.uniforms.uReach as Float32Array;
    reach[0] = (samples - 2) / 2 / source.width;
    reach[1] = (samples - 2) / 2 / source.height;
    try {
      renderer.render({ container: this.mesh, target, clear: true });
    } finally {
      // A sampled target can be evicted as soon as it returns to the pool.
      this.shader.resources.uTexture = this.unbound;
      this.mesh.texture = Texture.EMPTY;
    }
  }
}

const averagers = new WeakMap<Renderer, Averager>();

/** A texture's side in whole steps, so that one kept or pooled serves a range of sizes, within `largest`. */
function stepped(side: number, largest: number): number {
  return Math.min(largest, Math.ceil(side / 32) * 32);
}

/** Each renderer's count of contexts it was given, lost ones' bitmaps empty in the new. */
const contexts = new WeakMap<Renderer, { count: number }>();

function contextOf(renderer: Renderer): number {
  let context = contexts.get(renderer);
  if (!context) {
    const counted = { count: 0 };
    renderer.runners.contextChange.add({ contextChange: () => counted.count++ });
    contexts.set(renderer, counted);
    context = counted;
  }

  return context.count;
}

/** What drawing a child of a mask's container depends on, put on `out` in the order `mirror` copies it. */
function traits(child: PixiContainer, out: unknown[]): void {
  child.updateLocalTransform();
  const { a, b, c, d, tx, ty } = child.localTransform;
  const drawn =
    child instanceof Graphics ? child.context : child instanceof Sprite ? child.texture : null;
  const anchor = child instanceof Sprite ? child.anchor : null;
  out.push(child, drawn, a, b, c, d, tx, ty, child.visible, anchor?.x, anchor?.y);
}

/** A child's traits as they are now, kept between calls so that a comparison allocates nothing. */
const now: unknown[] = [];

/**
 * Whether `source` would be copied as `from` (`mirror`) recorded it from
 * `at` on: the index past its record, or -1 where anything differs.
 */
function copiedAs(source: PixiContainer, from: unknown[], at: number): number {
  let i = at;
  for (const child of source.children) {
    if (!child.includeInBuild) {
      continue;
    }

    now.length = 0;
    traits(child, now);
    for (const value of now) {
      if (i >= from.length || from[i++] !== value) {
        return -1;
      }
    }

    i = copiedAs(child, from, i);
    if (i < 0) {
      return -1;
    }
  }

  // A child it had and has no longer leaves its record to be read as the next one's, whose
  // child is another: the comparison fails there, or the whole falls short of the record.
  return i;
}

/**
 * A copy of what a mask's container draws, its transform left out: its
 * Graphics' contexts and its sprites' textures shared, its other containers
 * and their transforms copied. Masks hold such and nothing else to draw.
 * What each copy was made from goes on `from`, for `copiedAs`.
 */
function mirror(source: PixiContainer, into: PixiContainer, from: unknown[]): void {
  for (const child of source.children) {
    // A mask's own masks, which are not drawn, are left out.
    if (!child.includeInBuild) {
      continue;
    }

    const copy =
      child instanceof Graphics
        ? new Graphics({ context: child.context, observeContext: false })
        : child instanceof Sprite
          ? new Sprite(child.texture)
          : child.constructor === PixiContainer
            ? new PixiContainer()
            : null;
    if (!copy) {
      continue;
    }

    if (copy instanceof Sprite && child instanceof Sprite) {
      copy.anchor.copyFrom(child.anchor);
    }

    traits(child, from);
    copy.setFromMatrix(child.localTransform);
    copy.visible = child.visible;
    into.addChild(copy);
    mirror(child, copy, from);
  }
}

/** What the view keeps for a 3D object: the container its content is drawn from, the quad, and its bitmap. */
export class Plane {
  /** The root the object's container is drawn into its bitmap under, on no list. */
  readonly holder = new PixiContainer();
  readonly quad: Mesh<MeshGeometry, Shader>;
  private readonly positions = new Float32Array(8);
  private readonly ws = new Float32Array(4);
  /** Where place() works out the quad. */
  private readonly placing: PlaneQuad = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    positions: new Float64Array(8),
    ws: new Float64Array(4),
  };
  private readonly uvs = new Float32Array(8);
  private readonly geometry: MeshGeometry;
  private readonly shader: Shader;
  private texture: RenderTexture | null = null;
  /** The rectangle the bitmap holds, in the object's space. */
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  /** Whether what it draws may have changed since its bitmap was drawn. */
  stale = true;
  /** The renderer's context the bitmap was drawn in (contextOf). */
  private drawnIn = -1;
  /** The renderer's units a pixel of the object's space its content was last drawn at, and its texels a pixel. */
  units = SAMPLES;
  texels = 1;
  /** What its content draws, filters' reach included, as last measured (planes.ts); undefined before. */
  drawnRect: { x: number; y: number; width: number; height: number } | null | undefined = undefined;
  /** The units its content was last synced for (view.ts). */
  syncedUnits = SAMPLES;
  private readonly at = new Matrix();
  /** Whether the quad was placed elsewhere, or its bitmap drawn again, since the last frame. */
  changed = true;
  /** The blend's filters on the quad (planes.ts), null for none. */
  blending: Filter[] | null = null;
  /**
   * A 2D mask from outside the object: its container, kept from being drawn on the stage by
   * `keeper`, and the copy of it in the holder that clips the object's content in its bitmap.
   */
  outsideMask: PixiContainer | null = null;
  private readonly keeper = new PixiContainer();
  readonly maskCopy = new PixiContainer();
  /** What the mask's copy was made from (`mirror`), its map first: the same again needs no new copy. */
  private readonly copied: unknown[] = [];

  constructor() {
    program ??= new GlProgram({ vertex, fragment, name: "flash-plane" });
    this.geometry = new MeshGeometry({
      positions: this.positions,
      uvs: this.uvs,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.geometry.addAttribute("aW", { buffer: this.ws, format: "float32" });
    this.shader = new Shader({
      glProgram: program,
      resources: {
        uTexture: Texture.EMPTY.source,
        planeUniforms: new UniformGroup({ uPixel: { value: 1, type: "f32" } }),
      },
    });
    this.quad = new Mesh<MeshGeometry, Shader>({ geometry: this.geometry, shader: this.shader });
    this.quad.visible = false;
  }

  /**
   * Place the quad by the object's plane in its parent's space, `m`, over
   * the rectangle, in the object's space, `pixel` of its target's pixels a side of one
   * of Flash's. False, and nothing drawn, where a corner is behind the
   * eye, as Flash draws none of it.
   */
  place(m: Affine, xMin: number, yMin: number, xMax: number, yMax: number, pixel: number): boolean {
    const uniforms = this.shader.resources.planeUniforms.uniforms;
    if (uniforms.uPixel !== pixel) {
      uniforms.uPixel = pixel;
    }

    const quad = this.placing;
    if (!placeQuad(m, xMin, yMin, xMax, yMax, quad)) {
      return false;
    }

    for (let i = 0; i < 8; i++) {
      if (quad.positions[i] !== this.positions[i]) {
        this.changed = true;
      }

      this.positions[i] = quad.positions[i];
    }

    for (let i = 0; i < 4; i++) {
      if (quad.ws[i] !== this.ws[i]) {
        this.changed = true;
      }

      this.ws[i] = quad.ws[i];
    }

    const { x: x0, y: y0, width, height } = quad;
    this.geometry.getBuffer("aPosition").update();
    this.geometry.getBuffer("aW").update();
    if (x0 !== this.x || y0 !== this.y || width !== this.width || height !== this.height) {
      this.x = x0;
      this.y = y0;
      this.width = width;
      this.height = height;
      this.stale = true;
    }

    return true;
  }

  /**
   * Clip `content`, the object's container, by `mask`, a mask's container from outside it, or
   * by none: as its own mask it would clip the quad on the stage. Pixi takes a mask out of the
   * build while it masks, and puts it back as it is let go of, by any that held it: the keeper
   * holds it, and it is taken out again where it is still another's.
   */
  maskWith(content: PixiContainer, mask: PixiContainer | null): void {
    const previous = this.outsideMask;
    if (mask && content.mask === mask) {
      content.mask = null;
    }

    if (mask !== previous) {
      this.outsideMask = mask;
      this.keeper.mask = mask;
      this.clearMaskCopy();
      this.stale = true;
    }

    if (mask) {
      mask.includeInBuild = false;
      if (this.maskCopy.parent !== this.holder) {
        this.holder.addChildAt(this.maskCopy, 0);
      }

      content.mask = this.maskCopy;
      return;
    }

    if (previous && content.mask === previous) {
      previous.includeInBuild = false;
    }

    if (content.mask === this.maskCopy) {
      content.mask = null;
    }

    this.maskCopy.removeFromParent();
  }

  /**
   * The outside mask copied again, `m` the map from its container's space to the object's,
   * and the bitmap marked to be drawn again with it; nothing where neither the map nor what the
   * mask draws changed, as a still object under a still mask keeps its bitmap.
   */
  placeMask(m: Affine): void {
    const mask = this.outsideMask;
    if (!mask) {
      return;
    }

    const copied = this.copied;
    const same = copied.length >= 6 && copiedAs(mask, copied, 6) === copied.length;
    if (
      same &&
      copied[0] === m.a &&
      copied[1] === m.b &&
      copied[2] === m.c &&
      copied[3] === m.d &&
      copied[4] === m.tx &&
      copied[5] === m.ty
    ) {
      return;
    }

    // Moved alone, as under a turning object: the copy is kept and placed again.
    if (!same) {
      this.clearMaskCopy();
      copied.push(0, 0, 0, 0, 0, 0);
      mirror(mask, this.maskCopy, copied);
    }

    copied[0] = m.a;
    copied[1] = m.b;
    copied[2] = m.c;
    copied[3] = m.d;
    copied[4] = m.tx;
    copied[5] = m.ty;
    this.maskCopy.setFromMatrix(this.at.set(m.a, m.b, m.c, m.d, m.tx, m.ty));
    this.stale = true;
  }

  private clearMaskCopy(): void {
    this.copied.length = 0;
    for (const child of this.maskCopy.removeChildren()) {
      child.destroy({ children: true });
    }
  }

  /** Draw the object's container into its bitmap, if it may have changed or its context was lost. */
  draw(renderer: Renderer): void {
    const context = contextOf(renderer);
    if (!this.stale && this.drawnIn === context) {
      return;
    }

    this.stale = false;
    this.drawnIn = context;
    this.changed = true;
    const largest = largestTexture(renderer);
    const { samples, texels } = bitmapScale(this.width, this.height, largest);
    this.units = samples * texels;
    this.texels = texels;
    const width = Math.max(1, Math.ceil(this.width * texels));
    const height = Math.max(1, Math.ceil(this.height * texels));
    // Kept while what it holds fits, and is not much smaller: an object whose children move
    // changes its size on most frames.
    const texture = this.texture;
    const keptW = stepped(width, largest);
    const keptH = stepped(height, largest);
    if (
      !texture ||
      texture.width < width ||
      texture.height < height ||
      texture.width * texture.height > 4 * keptW * keptH
    ) {
      this.texture = RenderTexture.create({ width: keptW, height: keptH, scaleMode: "linear" });
      this.shader.resources.uTexture = this.texture.source;
      this.quad.texture = this.texture;
      texture?.destroy(true);
    }

    const bitmap = this.texture as RenderTexture;
    const u = width / bitmap.width;
    const v = height / bitmap.height;
    if (this.uvs[2] !== u || this.uvs[5] !== v) {
      this.uvs.set([0, 0, u, 0, u, v, 0, v]);
      this.geometry.getBuffer("aUV").update();
    }

    // At its samples a side, then averaged down to the bitmap in one pass.
    const scale = this.units;
    const target =
      samples > 1
        ? drawTarget(stepped(width * samples, largest), stepped(height * samples, largest))
        : bitmap;
    renderer.render({
      container: this.holder,
      target,
      clear: true,
      transform: this.at.set(scale, 0, 0, scale, -this.x * scale, -this.y * scale),
    });
    if (samples > 1) {
      let averager = averagers.get(renderer);
      if (!averager) {
        averager = new Averager();
        averagers.set(renderer, averager);
      }

      averager.draw(renderer, target, bitmap, width, height, samples);
      releaseDrawTarget(target);
    }
  }

  /** Let go of all it holds; `content`, the object's container, keeps a mask it has of its own. */
  destroy(content: PixiContainer): void {
    this.maskWith(content, null);
    this.quad.destroy();
    this.geometry.destroy();
    this.shader.destroy();
    this.texture?.destroy(true);
    this.texture = null;
    this.maskCopy.destroy();
    this.holder.removeChildren();
    this.holder.destroy();
  }
}
