// drawTriangles' textured triangles (display/drawing.ts' meshes), drawn as
// adl draws them (docs/architecture.md, "Drawing with Graphics"). Each
// vertex's u and v are interpolated in perspective by its t: the vertices
// carry u·t, v·t and t, which the GPU interpolates straight across the
// screen, and each pixel divides. Flash maps u and v from 0 to 1 onto the
// bitmap's first texel's centre to its last's, wrapped into that or
// clamped to it, and samples once a pixel, at the pixel's top left corner:
// not smoothed, the nearer texel, the lower of two as near; smoothed, the
// four around, weighed. So the shader reads texels itself, whatever the
// texture's sampling, and every sample of a pixel the page draws finer to
// average down takes the pixel's value.
import type { ColorTransform } from "@swf2es/format";
import { GlProgram, Mesh, MeshGeometry, Shader, type Texture, UniformGroup } from "pixi.js";
import type { TriangleMesh } from "../display/shapes.js";

const vertex = `#version 300 es
in vec2 aPosition;
in vec3 aUVT;
out vec3 vUVT;
out vec4 vColor;
flat out float vDown;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

void main(void) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUVT = vec3(aUVT.xy * aUVT.z, aUVT.z);
  vColor = uColor * uWorldColorAlpha;
  // A texture's rows go down the stage as the window's y goes up; the screen's, as it goes down.
  vDown = uProjectionMatrix[1][1] > 0.0 ? 1.0 : 0.0;
}
`;

// uMode: whether the fill repeats, whether it is smoothed, the target's pixels a side of one of
// Flash's, and whether a Flash colour transform (uMul, uAdd) replaces Pixi's colour.
const fragment = `#version 300 es
precision highp float;
in vec3 vUVT;
in vec4 vColor;
flat in float vDown;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec2 uSize;
uniform vec4 uMode;
uniform vec4 uMul;
uniform vec4 uAdd;

vec4 texel(ivec2 at) {
  return texelFetch(uTexture, at, 0);
}

void main(void) {
  float pixel = uMode.z;
  vec2 f = gl_FragCoord.xy;
  vec2 corner = vec2(floor(f.x / pixel), vDown > 0.5 ? floor(f.y / pixel) : ceil(f.y / pixel)) * pixel;
  vec3 uvt = vUVT + dFdx(vUVT) * (corner.x - f.x) + dFdy(vUVT) * (corner.y - f.y);
  vec2 uv = uvt.z != 0.0 ? uvt.xy / uvt.z : vec2(0.0);
  // As adl draws one, a bitmap a texel high shows its first texel throughout.
  if (uSize.y == 1.0) {
    uv = vec2(0.0);
  }

  // A hair nearer 0, as adl's come out, stepped across the triangle in fixed point: 1 wraps to
  // the last texel, not the first, and a corner halfway between texels takes the one nearer 0.
  uv -= sign(uv) / 16384.0;
  uv = uMode.x > 0.5 ? fract(uv) : clamp(uv, 0.0, 1.0);
  vec2 p = uv * (uSize - 1.0);
  vec4 color;
  if (uMode.y > 0.5) {
    vec2 below = floor(p);
    vec2 t = p - below;
    ivec2 a = ivec2(below);
    ivec2 b = min(a + 1, ivec2(uSize) - 1);
    color = mix(
      mix(texel(a), texel(ivec2(b.x, a.y)), t.x),
      mix(texel(ivec2(a.x, b.y)), texel(b), t.x),
      t.y
    );
  } else {
    color = texel(ivec2(floor(p + 0.5)));
  }

  if (uMode.w < 0.5) {
    finalColor = color * vColor;
  } else if (color.a == 0.0) {
    finalColor = vec4(0.0);
  } else {
    // As render/color.ts' batcher: the transform on the straight colour, premultiplied after.
    vec4 c = clamp(vec4(color.rgb / color.a, color.a) * uMul + uAdd, 0.0, 1.0);
    finalColor = vec4(c.rgb * c.a, c.a);
  }
}
`;

let program: GlProgram | null = null;

/**
 * A drawing's textured triangles: a mesh of their vertices under its own
 * shader, one draw. It destroys its geometry and shader with itself, and
 * leaves the texture, its store's.
 */
export class TriangleView extends Mesh<MeshGeometry, Shader> {
  /** What it draws, the drawing's. */
  readonly source: TriangleMesh;
  private readonly uniforms: UniformGroup;
  /** The views it is listed in while it lives. */
  private readonly owner: Set<TriangleView>;
  private flash: ColorTransform | null;

  constructor(source: TriangleMesh, texture: Texture, pixel: number, owner: Set<TriangleView>) {
    const count = source.positions.length / 2;
    const indices = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      indices[i] = i;
    }

    const geometry = new MeshGeometry({
      positions: new Float32Array(source.positions),
      indices: indices as Uint32Array,
    });
    geometry.addAttribute("aUVT", { buffer: new Float32Array(source.uvt), format: "float32x3" });
    program ??= new GlProgram({ vertex, fragment, name: "flash-triangles" });
    const uniforms = new UniformGroup({
      uSize: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
      uMode: {
        value: new Float32Array([source.repeat ? 1 : 0, source.smooth ? 1 : 0, pixel, 0]),
        type: "vec4<f32>",
      },
      uMul: { value: new Float32Array([1, 1, 1, 1]), type: "vec4<f32>" },
      uAdd: { value: new Float32Array(4), type: "vec4<f32>" },
    });
    const shader = new Shader({
      glProgram: program,
      resources: { uTexture: texture.source, triangleUniforms: uniforms },
    });
    super({ geometry, shader });
    this.source = source;
    this.uniforms = uniforms;
    this.owner = owner;
    this.flash = null;
    this.show(texture);
    owner.add(this);
  }

  /** The store's texture as it now is. */
  show(texture: Texture): void {
    const size = this.uniforms.uniforms.uSize as Float32Array;
    size[0] = texture.source.pixelWidth;
    size[1] = texture.source.pixelHeight;
    this.uniforms.update();
    (this.shader as Shader).resources.uTexture = texture.source;
    // For Pixi's blend, which follows the texture's alpha.
    this.texture = texture;
  }

  /** The target's pixels a side of one of Flash's, which the texture is sampled once in. */
  set pixel(pixel: number) {
    const mode = this.uniforms.uniforms.uMode as Float32Array;
    if (mode[2] !== pixel) {
      mode[2] = pixel;
      this.uniforms.update();
    }
  }

  /** The Flash colour transform it draws under, in place of Pixi's colour (render/color.ts). */
  get flashColor(): ColorTransform | null {
    return this.flash;
  }

  set flashColor(ct: ColorTransform | null) {
    this.flash = ct;
    const { uMode, uMul, uAdd } = this.uniforms.uniforms as Record<string, Float32Array>;
    uMode[3] = ct ? 1 : 0;
    if (ct) {
      uMul.set([ct.rMul, ct.gMul, ct.bMul, ct.aMul]);
      uAdd.set([ct.rAdd / 255, ct.gAdd / 255, ct.bAdd / 255, ct.aAdd / 255]);
    }

    this.uniforms.update();
  }

  override destroy(): void {
    const geometry = this.geometry;
    const shader = this.shader as Shader;
    this.owner.delete(this);
    super.destroy();
    geometry.destroy();
    shader.destroy();
  }
}
