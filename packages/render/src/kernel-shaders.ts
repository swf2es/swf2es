// Pixel Bender kernels where Flash draws with them, as fragment shaders
// around a kernel's GLSL (the player's scene/pixel-bender-glsl.ts, which
// defines `vec4 pbKernel(vec2 outCoord)` and calls `pbNearest<t>` and
// `pbLinear<t>` for each texture `t` it samples). What is here is how
// each use reads its images and writes what the kernel gives, as adl
// does (docs/architecture/compositing.md, "Pixel Bender"): an image read
// as its premultiplied bytes times the float nearest 1/255, linearly in
// 256ths with each step's byte cut down, as the CPU interpreter reads it.
// GLSL ES 3 with no version or precision line.

/** A byte's float as adl samples one: times the float nearest 1/255, not divided. */
const BYTE = "0.003921568859368563";

/** An image a kernel samples: its texture number, and whether it is the filtered layer. */
export interface KernelImage {
  texture: number;
  layer: boolean;
}

/**
 * The sampling of image `t` from `fetch`, its bytes at a texel as floats
 * from 0 to 255, at the texel coordinates `at` gives for a kernel's.
 */
function sampling(t: number, at: string): string {
  return `vec4 pbNearest${t}(vec2 p) {
  vec2 x = ${at};
  return pbTexel${t}(pbFloor(x)) * ${BYTE};
}
vec4 pbLinear${t}(vec2 p) {
  vec2 f = ${at} - 0.5;
  vec2 below = floor(f);
  vec2 w = floor((f - below) * 256.0 + 0.5);
  w = mix(w, vec2(0.0), isnan(w));
  ivec2 a = pbFloor(below);
  vec4 row0 = floor((pbTexel${t}(a) * (256.0 - w.x) + pbTexel${t}(a + ivec2(1, 0)) * w.x) / 256.0);
  vec4 row1 = floor((pbTexel${t}(a + ivec2(0, 1)) * (256.0 - w.x) + pbTexel${t}(a + 1) * w.x) / 256.0);
  return floor((row0 * (256.0 - w.y) + row1 * w.y) / 256.0) * ${BYTE};
}
`;
}

/**
 * A texel coordinate as a texel's index, NaN as 0 and far past the edges
 * kept in int's range; and a texel's bytes from 0 to 255, read exactly
 * from the 8-bit texture.
 */
const PRELUDE = `ivec2 pbFloor(vec2 x) {
  x = mix(x, vec2(0.0), isnan(x));
  return ivec2(clamp(floor(x), -1.0e9, 1.0e9));
}
vec4 pbBytes(vec4 v) {
  return floor(v * 255.0 + 0.5);
}
`;

/**
 * A ShaderFilter's pass (filter-plan.ts, KERNEL_PASS), run as the
 * filters' other passes are (webgl/filters.ts): the kernel's output over
 * the input's frame, `outCoord` its pixel's centre in stage pixels from
 * the corner of the object's bitmap, `uKernelAt.x` texels in from the
 * frame's, which starts at `uOutputAt` in the target drawn into, at
 * `uKernelAt.y` texels a stage pixel. The layer's image is
 * the input (uTexture, within uTextureRect), transparent past its edges,
 * as adl reads a filter's source; the others, `pbImage<t>`, clamp to
 * theirs. The output is clamped, each colour at most its alpha, and left
 * transparent outside `uKernelRegion`, the object's bitmap grown by the
 * filter's extensions, in stage pixels.
 */
export function filterKernel(kernel: string, images: readonly KernelImage[]): string {
  // Made once a kernel and its images, which a frame asks for again on each of its filters.
  const key = images.map((i) => (i.layer ? `${i.texture}L` : i.texture)).join();
  let byImages = made.get(kernel);
  if (!byImages) {
    if (made.size >= MADE) {
      made.clear();
    }

    byImages = new Map();
    made.set(kernel, byImages);
  }

  let source = byImages.get(key);
  if (source === undefined) {
    source = filterSource(kernel, images);
    byImages.set(key, source);
  }

  return source;
}

/** The most kernels whose shaders filterKernel keeps, emptied when more come. */
const MADE = 64;
const made = new Map<string, Map<string, string>>();

function filterSource(kernel: string, images: readonly KernelImage[]): string {
  const parts = [
    `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputPixel;
uniform vec4 uTextureRect;
uniform vec2 uKernelAt;
uniform vec4 uKernelRegion;
uniform vec2 uOutputAt;
`,
    PRELUDE,
  ];
  for (const { texture: t, layer } of images) {
    if (layer) {
      parts.push(`vec4 pbTexel${t}(ivec2 at) {
  ivec2 size = ivec2(uTextureRect.zw);
  if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size))) {
    return vec4(0.0);
  }
  return pbBytes(texelFetch(uTexture, ivec2(uTextureRect.xy) + at, 0));
}
`);
      parts.push(sampling(t, "p * uKernelAt.y + uKernelAt.x"));
    } else {
      parts.push(`uniform sampler2D pbImage${t};
vec4 pbTexel${t}(ivec2 at) {
  ivec2 size = textureSize(pbImage${t}, 0);
  return pbBytes(texelFetch(pbImage${t}, clamp(at, ivec2(0), size - 1), 0));
}
`);
      parts.push(sampling(t, "p"));
    }
  }

  parts.push(kernel);
  parts.push(`void main(void) {
  // From the fragment's centre, exact, where an interpolated coordinate is a hair off a half.
  vec2 outCoord = (gl_FragCoord.xy - uOutputAt - uKernelAt.x) / uKernelAt.y;
  if (any(lessThan(outCoord, uKernelRegion.xy)) || any(greaterThanEqual(outCoord, uKernelRegion.zw))) {
    finalColor = vec4(0.0);
    return;
  }
  vec4 c = pbKernel(outCoord);
  // Clamped, NaN as 0, rounded to a byte a half to the even, each colour at most the alpha.
  c = mix(vec4(0.0), min(c, 1.0), greaterThan(c, vec4(0.0)));
  c = roundEven(c * 255.0) / 255.0;
  finalColor = vec4(min(c.rgb, c.a), c.a);
}
`);
  return parts.join("\n");
}

/**
 * A kernel's output, run a texel a stage pixel, drawn back over a frame
 * `uCoord` times as large each way: each texel its pixel's, as Flash
 * draws a filter's bitmap a pixel at a time.
 */
export const PIXELS_BACK = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputPixel;
uniform vec4 uTextureRect;
void main(void) {
  ivec2 at = ivec2(floor(vTextureCoord * uInputPixel.xy));
  at = clamp(at, ivec2(0), ivec2(uTextureRect.zw) - 1);
  finalColor = texelFetch(uTexture, ivec2(uTextureRect.xy) + at, 0);
}
`;
