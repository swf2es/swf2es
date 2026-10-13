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
  GlProgram,
  Matrix,
  Mesh,
  MeshGeometry,
  Container as PixiContainer,
  type Renderer,
  RenderTexture,
  Shader,
  Texture,
  UniformGroup,
} from "pixi.js";
import { isProjective } from "../display/geometry.js";
import { drawTarget, releaseDrawTarget } from "./pools.js";

/** The samples a side the bitmap is drawn at before it is averaged to a texel a pixel, as Flash's high quality covers edges. */
export const SAMPLES = 4;

/** The most texels a side of a bitmap: larger, the object is drawn into it at less than a texel a pixel. */
const LARGEST = 2048;

/** The most texels the samples a bitmap is drawn at may take (16 MiB): past it, fewer samples. */
const SAMPLED_TEXELS = 4 * 1024 * 1024;

/** The samples a side, and texels a pixel of the object's space, a bitmap of a w by h rectangle is drawn at. */
export function bitmapScale(
  width: number,
  height: number,
  largest: number,
): { samples: number; texels: number } {
  const texels = Math.min(1, Math.min(LARGEST, largest) / Math.max(width, height));
  const w = Math.max(1, Math.ceil(width * texels));
  const h = Math.max(1, Math.ceil(height * texels));
  let samples = SAMPLES;
  while (
    samples > 1 &&
    (w * samples > largest || h * samples > largest || w * h * samples * samples > SAMPLED_TEXELS)
  ) {
    samples /= 2;
  }

  return { samples, texels };
}

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
        uTexture: Texture.EMPTY.source,
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
    renderer.render({ container: this.mesh, target, clear: true });
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

/** What the view keeps for a 3D object: the container its content is drawn from, the quad, and its bitmap. */
export class Plane {
  /** The root the object's container is drawn into its bitmap under, on no list. */
  readonly holder = new PixiContainer();
  readonly quad: Mesh<MeshGeometry, Shader>;
  private readonly positions = new Float32Array(8);
  private readonly ws = new Float32Array(4);
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
  /** What its content draws, filters' reach included, as last measured (view.ts); undefined before. */
  drawnRect: { x: number; y: number; width: number; height: number } | null | undefined = undefined;
  /** The units its content was last synced for (view.ts). */
  syncedUnits = SAMPLES;
  private readonly at = new Matrix();
  /** Whether the quad was placed elsewhere, or its bitmap drawn again, since the last frame. */
  changed = true;

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

    // The bitmap from the object's left and top out to whole pixels, a texel a pixel, and a texel
    // of nothing around. Flash draws it a texel wider and taller than it is, about its centre,
    // and half a pixel of the stage right and down: so unturned at a texel a pixel its left and
    // top edges stay where they are, and magnified it grows as much each way.
    const xFrom = Math.floor(xMin);
    const yFrom = Math.floor(yMin);
    const across = Math.ceil(xMax) - xFrom;
    const down = Math.ceil(yMax) - yFrom;
    if (!(across >= 1 && down >= 1 && across < 1e6 && down < 1e6)) {
      return false;
    }

    const x0 = xFrom - 1;
    const y0 = yFrom - 1;
    const width = across + 2;
    const height = down + 2;
    const [u, v, w] = isProjective(m) ? [m.u, m.v, m.w] : [0, 0, 1];
    const cx = xFrom + across / 2;
    const cy = yFrom + down / 2;
    const at = (x: number, y: number): [number, number] => {
      const q = u * x + v * y + w;
      return [(m.a * x + m.c * y + m.tx) / q, (m.b * x + m.d * y + m.ty) / q];
    };
    // Half a pixel of the stage right and down, in the object's space: through the inverse of
    // how its plane moves a point at the centre.
    const [ax, ay] = at(cx - 0.5, cy);
    const [bx, by] = at(cx + 0.5, cy);
    const [dx, dy] = at(cx, cy - 0.5);
    const [ex, ey] = at(cx, cy + 0.5);
    const jxx = bx - ax;
    const jyx = by - ay;
    const jxy = ex - dx;
    const jyy = ey - dy;
    const det = jxx * jyy - jxy * jyx;
    const shiftX = det ? (0.5 * jyy - 0.5 * jxy) / det : 0;
    const shiftY = det ? (0.5 * jxx - 0.5 * jyx) / det : 0;
    const sx = (across + 1) / across;
    const sy = (down + 1) / down;
    const left = cx + shiftX - (across / 2 + 1) * sx;
    const right = cx + shiftX + (across / 2 + 1) * sx;
    const top = cy + shiftY - (down / 2 + 1) * sy;
    const bottom = cy + shiftY + (down / 2 + 1) * sy;
    for (let i = 0; i < 4; i++) {
      // Corners in the uvs' order: top left, top right, bottom right, bottom left.
      const x = i === 1 || i === 2 ? right : left;
      const y = i >= 2 ? bottom : top;
      const q = u * x + v * y + w;
      if (!(q > 0)) {
        return false;
      }

      const px = (m.a * x + m.c * y + m.tx) / q;
      const py = (m.b * x + m.d * y + m.ty) / q;
      if (px !== this.positions[i * 2] || py !== this.positions[i * 2 + 1] || q !== this.ws[i]) {
        this.changed = true;
      }

      this.positions[i * 2] = px;
      this.positions[i * 2 + 1] = py;
      this.ws[i] = q;
    }

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
      texture?.destroy(true);
      this.texture = RenderTexture.create({ width: keptW, height: keptH, scaleMode: "linear" });
      this.shader.resources.uTexture = this.texture.source;
      this.quad.texture = this.texture;
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

  destroy(): void {
    this.quad.destroy();
    this.geometry.destroy();
    this.shader.destroy();
    this.texture?.destroy(true);
    this.texture = null;
    this.holder.removeChildren();
    this.holder.destroy();
  }
}
