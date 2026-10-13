// A 3D display object drawn as Flash Player and adl draw one: what it and
// its children draw, in its own space, a pixel of it a texel, is drawn
// into a bitmap of its own, and the bitmap is drawn smoothed through the
// object's plane in perspective (display/perspective.ts). So a card that
// turns about y narrows toward its far edge, and one scaled up in 3D is
// as blurred as Flash's, a texel magnified. The bitmap is anti-aliased as
// the stage is, drawn at SAMPLES a side and halved down to a texel a
// pixel, and has a texel of nothing around it, which the smoothing fades
// its edges into as Flash's are (docs/architecture.md, "3D display
// objects").
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
  Sprite,
  Texture,
  UniformGroup,
} from "pixi.js";
import { isProjective } from "../display/geometry.js";
import { drawTarget, releaseDrawTarget } from "./pools.js";

/** The samples a side the bitmap is drawn at before it is halved to a texel a pixel, as Flash's high quality covers edges. */
export const SAMPLES = 4;

/** The most texels a side of a bitmap: larger, the object is drawn into it at less than a texel a pixel. */
const LARGEST = 2048;

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

let program: GlProgram | null = null;

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
  /** Whether the quad was placed elsewhere, or its bitmap drawn again, since the last frame. */
  changed = true;

  constructor() {
    program ??= new GlProgram({ vertex, fragment, name: "flash-plane" });
    this.geometry = new MeshGeometry({
      positions: this.positions,
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
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
    const texels = Math.min(1, LARGEST / Math.max(this.width, this.height));
    const width = Math.max(1, Math.ceil(this.width * texels));
    const height = Math.max(1, Math.ceil(this.height * texels));
    if (!this.texture || this.texture.width !== width || this.texture.height !== height) {
      this.texture?.destroy(true);
      this.texture = RenderTexture.create({ width, height, scaleMode: "linear" });
      this.shader.resources.uTexture = this.texture.source;
      this.quad.texture = this.texture;
    }

    // At SAMPLES a side, then halved down to the bitmap, as BitmapData.draw's (view.ts, sampled).
    let n = SAMPLES;
    const scale = texels * n;
    let target = n > 1 ? drawTarget(width * n, height * n) : this.texture;
    renderer.render({
      container: this.holder,
      target,
      clear: true,
      transform: new Matrix(scale, 0, 0, scale, -this.x * scale, -this.y * scale),
    });
    for (; n > 1; n /= 2) {
      const half = n > 2 ? drawTarget((width * n) / 2, (height * n) / 2) : this.texture;
      target.source.scaleMode = "linear";
      const sprite = new Sprite(target);
      sprite.scale.set(0.5);
      renderer.render({ container: sprite, target: half, clear: true });
      sprite.destroy();
      releaseDrawTarget(target);
      target = half;
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
