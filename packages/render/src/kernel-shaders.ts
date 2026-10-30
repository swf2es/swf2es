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

/** The most images a kernel's program binds besides its layer's: one with more is not drawn. */
export const KERNEL_IMAGES = 8;

/**
 * An image a kernel samples: its texture number, and whether it is the
 * filtered layer; or, for a blend, what is below or the layer blended.
 */
export interface KernelImage {
  texture: number;
  layer: boolean;
  back?: boolean;
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
  return madeOnce(madeFilters, kernel, images, () => filterSource(kernel, images));
}

/** The most kernels whose shaders madeOnce keeps for a use, emptied when more come. */
const MADE = 64;
const madeFilters = new Map<string, Map<string, string>>();
const madeBlends = new Map<string, Map<string, string>>();

/** A kernel's shader for its images, made once: a frame asks for it again on each of its uses. */
function madeOnce(
  made: Map<string, Map<string, string>>,
  kernel: string,
  images: readonly KernelImage[],
  make: () => string,
): string {
  const key = images.map((i) => `${i.texture}${i.layer ? (i.back ? "B" : "L") : ""}`).join();
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
    source = make();
    byImages.set(key, source);
  }

  return source;
}

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

/**
 * A blend shader's composite (webgl/composite.ts), drawn as the composite
 * program is (programs.ts, compositeFragment), its uniforms the same: as
 * adl runs one, a pixel at a time, each where the layer covers anything
 * and nothing where it does not, or over its whole rectangle (uWhole), the kernel's coordinate (0.5, 0.5) and
 * its first two inputs that pixel of what is below and of the layer,
 * coloured, whatever coordinate it samples them at; its result in place of
 * what was below, clamped, each colour at most its alpha. `rows` is the
 * colour transform's reading of uRows (programs.ts).
 */
export function blendKernel(kernel: string, images: readonly KernelImage[], rows: string): string {
  return madeOnce(madeBlends, kernel, images, () => blendSource(kernel, images, rows));
}

function blendSource(kernel: string, images: readonly KernelImage[], rows: string): string {
  const parts = [
    `#version 300 es
precision highp float;
uniform sampler2D uLayer;
uniform sampler2D uBack;
uniform highp sampler2D uRows;
uniform int uRow;
uniform ivec2 uOffset;
uniform bool uFlip;
uniform ivec2 uBackOffset;
uniform bool uWhole;
out vec4 finalColor;
vec4 pbFront;
vec4 pbBack;
`,
    PRELUDE,
  ];
  for (const { texture: t, layer, back } of images) {
    if (layer) {
      parts.push(`vec4 pbTexel${t}(ivec2 at) {
  return pbBytes(${back ? "pbBack" : "pbFront"});
}
`);
    } else {
      parts.push(`uniform sampler2D pbImage${t};
vec4 pbTexel${t}(ivec2 at) {
  ivec2 size = textureSize(pbImage${t}, 0);
  return pbBytes(texelFetch(pbImage${t}, clamp(at, ivec2(0), size - 1), 0));
}
`);
    }

    parts.push(sampling(t, "p"));
  }

  parts.push(kernel);
  parts.push(`void main(void) {
  ivec2 frag = ivec2(gl_FragCoord.xy);
  ivec2 at = ivec2(frag.x - uOffset.x, uFlip ? uOffset.y - frag.y : frag.y - uOffset.y);
  vec4 front = texelFetch(uLayer, at, 0);
${rows}
  pbBack = texelFetch(uBack, frag - uBackOffset, 0);
  if (!uWhole && pbBytes(front).a == 0.0) {
    finalColor = pbBack;
    return;
  }
  pbFront = front;
  vec4 c = pbKernel(vec2(0.5));
  c = mix(vec4(0.0), min(c, 1.0), greaterThan(c, vec4(0.0)));
  c = roundEven(c * 255.0) / 255.0;
  finalColor = vec4(min(c.rgb, c.a), c.a);
}
`);
  return parts.join("\n");
}

/**
 * A shader fill's program, after the mesh's vertex shader (programs.ts,
 * meshVertex), which carries the kernel's coordinates in vUVT with a depth
 * of 1: the kernel run once a pixel of Flash's, at its centre (uFrag as the
 * mesh's has it), its images clamped to their edges; its colours left
 * past its alpha, as adl composites them, but under a colour transform,
 * which takes them straight.
 */
export function fillKernel(kernel: string, images: readonly KernelImage[]): string {
  return madeOnce(madeFills, kernel, images, () => fillSource(kernel, images));
}

const madeFills = new Map<string, Map<string, string>>();

function fillSource(kernel: string, images: readonly KernelImage[]): string {
  const parts = [
    `#version 300 es
precision highp float;
in vec3 vUVT;
flat in vec4 vMul;
flat in vec4 vAdd;
uniform vec4 uFrag;
out vec4 finalColor;
`,
    PRELUDE,
  ];
  for (const { texture: t } of images) {
    parts.push(`uniform sampler2D pbImage${t};
vec4 pbTexel${t}(ivec2 at) {
  ivec2 size = textureSize(pbImage${t}, 0);
  return pbBytes(texelFetch(pbImage${t}, clamp(at, ivec2(0), size - 1), 0));
}
`);
    parts.push(sampling(t, "p"));
  }

  parts.push(kernel);
  parts.push(`void main(void) {
  float pixel = uFrag.w;
  vec2 f = vec2(gl_FragCoord.x + uFrag.x, uFrag.y + uFrag.z * gl_FragCoord.y);
  vec2 centre = (floor(f / pixel) + 0.5) * pixel;
  vec3 at = vUVT + dFdx(vUVT) * (centre.x - f.x) + dFdy(vUVT) * ((centre.y - f.y) * uFrag.z);
  vec4 c = pbKernel(at.xy / at.z);
  c = mix(vec4(0.0), min(c, 1.0), greaterThan(c, vec4(0.0)));
  if (vMul == vec4(1.0) && vAdd == vec4(0.0)) {
    finalColor = c;
    return;
  }
  if (c.a == 0.0) {
    finalColor = vec4(0.0);
    return;
  }
  vec4 s = clamp(vec4(c.rgb / c.a, c.a) * vMul + vAdd, 0.0, 1.0);
  finalColor = vec4(s.rgb * s.a, s.a);
}
`);
  return parts.join("\n");
}
