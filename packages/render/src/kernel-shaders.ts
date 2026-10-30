// Pixel Bender kernels where Flash draws with them, as fragment shaders
// around a kernel's GLSL (the player's scene/pixel-bender-glsl.ts, which
// defines `vec4 pbKernel(vec2 outCoord)` and calls `pbNearest<t>` and
// `pbLinear<t>` for each texture `t` it samples). What is here is how
// each use reads its images and writes what the kernel gives, as adl
// does (docs/architecture/bitmaps.md, "Pixel Bender"): an image read as
// its premultiplied bytes times the float nearest 1/255, linearly in
// 256ths with each step's byte cut down; floats as they are, linearly in
// the same 256ths; as the CPU interpreter reads them. GLSL ES 3 with no
// version line.

/** A byte's float as adl samples one: times the float nearest 1/255, not divided. */
const BYTE = "0.003921568859368563";

/** The most images a kernel's program binds besides its layer's: one with more is not drawn. */
export const KERNEL_IMAGES = 8;

/**
 * An image a kernel samples: its texture number; whether it is the
 * filtered layer, else a texture of its own; and whether its texels are
 * floats (RGBA32F), else bytes. For a blend, a layer's image is what is
 * below where `back`, else the layer blended.
 */
export interface KernelImage {
  texture: number;
  layer: boolean;
  float: boolean;
  back?: boolean;
}

/** Whether `images` bind no more textures of their own than a program takes (KERNEL_IMAGES). */
export function kernelImagesFit(images: readonly KernelImage[]): boolean {
  let own = 0;
  for (let k = 0; k < images.length; k++) {
    if (!images[k].layer) {
      own++;
    }
  }

  return own <= KERNEL_IMAGES;
}

/**
 * Precision, as ints default to mediump in a fragment shader; a texel
 * coordinate as a texel's index, NaN as 0 and far past the edges kept in
 * int's range; a texel's bytes from 0 to 255, read exactly from the 8-bit
 * texture; and a kernel's output as adl writes it into a bitmap: clamped,
 * NaN as 0, rounded to a byte a half to the even, each colour at most its
 * alpha.
 */
const PRELUDE = `precision highp int;
precision highp sampler2D;
ivec2 pbFloor(vec2 x) {
  x = mix(x, vec2(0.0), isnan(x));
  return ivec2(clamp(floor(x), -1.0e9, 1.0e9));
}
vec4 pbBytes(vec4 v) {
  return floor(v * 255.0 + 0.5);
}
vec4 pbOutput(vec4 c) {
  c = mix(vec4(0.0), min(c, 1.0), greaterThan(c, vec4(0.0)));
  c = roundEven(c * 255.0) / 255.0;
  return vec4(min(c.rgb, c.a), c.a);
}
`;

/**
 * Image `t`'s sampling from `pbTexel<t>`, its texel at an index (bytes from
 * 0 to 255, or floats), at the texel coordinates `at` gives for a kernel's.
 */
function sampling(t: number, at: string, float: boolean): string {
  if (float) {
    // The interpreter's floats: their texels as they are, linearly in 256ths, nothing cut.
    return `vec4 pbNearest${t}(vec2 p) {
  return pbTexel${t}(pbFloor(${at}));
}
vec4 pbLinear${t}(vec2 p) {
  vec2 f = ${at} - 0.5;
  vec2 below = floor(f);
  vec2 w = floor((f - below) * 256.0 + 0.5) / 256.0;
  w = mix(w, vec2(0.0), isnan(w));
  ivec2 a = pbFloor(below);
  vec4 row0 = pbTexel${t}(a) * (1.0 - w.x) + pbTexel${t}(a + ivec2(1, 0)) * w.x;
  vec4 row1 = pbTexel${t}(a + ivec2(0, 1)) * (1.0 - w.x) + pbTexel${t}(a + 1) * w.x;
  return row0 * (1.0 - w.y) + row1 * w.y;
}
`;
  }

  return `vec4 pbNearest${t}(vec2 p) {
  return pbTexel${t}(pbFloor(${at})) * ${BYTE};
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
 * Image `t`, a texture of its own (`pbImage<t>`), clamped to its edges as
 * adl clamps a kernel's input: its sampler, its texels and its sampling, in
 * its own pixels.
 */
function ownImage(t: number, float: boolean): string {
  const texel = `texelFetch(pbImage${t}, clamp(at, ivec2(0), size - 1), 0)`;
  return `uniform sampler2D pbImage${t};
vec4 pbTexel${t}(ivec2 at) {
  ivec2 size = textureSize(pbImage${t}, 0);
  return ${float ? texel : `pbBytes(${texel})`};
}
${sampling(t, "p", float)}`;
}

/**
 * The kernel's GLSL with what every use puts round it: PRELUDE, then each
 * image, by `layerTexel` for the layer's, its texel at an index, and
 * ownImage for the others; `layerAt` takes a kernel's coordinate to the
 * layer's texels.
 */
export function withImages(
  kernel: string,
  images: readonly KernelImage[],
  layerTexel: (t: number, back: boolean) => string,
  layerAt: string,
): string {
  const parts = [PRELUDE];
  for (const { texture: t, layer, float, back } of images) {
    parts.push(
      layer
        ? `${layerTexel(t, back ?? false)}\n${sampling(t, layerAt, false)}`
        : ownImage(t, float),
    );
  }

  parts.push(kernel);
  return parts.join("\n");
}

/** The most kernels whose shaders a use keeps made (madeOnce), emptied when more come. */
const MADE = 64;

/** A kernel's shader for its images, made once: a frame asks for it again on each of its uses. */
export function madeOnce(
  made: Map<string, Map<string, string>>,
  kernel: string,
  images: readonly KernelImage[],
  make: () => string,
): string {
  let key = "";
  for (let k = 0; k < images.length; k++) {
    const i = images[k];
    key += `${i.texture}${i.layer ? (i.back ? "B" : "L") : ""}${i.float ? "F" : ""},`;
  }

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

const madeFilters = new Map<string, Map<string, string>>();

/**
 * A ShaderFilter's pass (filter-plan.ts, KERNEL_PASS), run as the
 * filters' other passes are (webgl/filters.ts): the kernel's output over
 * the input's frame, `outCoord` its pixel's centre in stage pixels from
 * the corner of the bitmap the filter reads, `uKernelAt.xy` texels in from
 * the frame's, which starts at `uOutputAt` in the target drawn into, at
 * `uKernelAt.z` texels a stage pixel. The layer's image is the input
 * (uTexture, within uTextureRect), transparent past the frame,
 * `uKernelFrame` texels, as adl reads a filter's source; the others clamp
 * to their edges. The output is as adl writes it (pbOutput), and
 * transparent outside `uKernelRegion`, that bitmap grown by the filter's
 * extensions, in stage pixels.
 */
export function filterKernel(kernel: string, images: readonly KernelImage[]): string {
  return madeOnce(madeFilters, kernel, images, () => filterSource(kernel, images));
}

function filterSource(kernel: string, images: readonly KernelImage[]): string {
  const layer = (t: number) => `vec4 pbTexel${t}(ivec2 at) {
  if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, ivec2(uKernelFrame)))) {
    return vec4(0.0);
  }
  return pbBytes(texelFetch(uTexture, ivec2(uTextureRect.xy) + at, 0));
}`;
  return `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputPixel;
uniform vec4 uTextureRect;
uniform vec3 uKernelAt;
uniform vec2 uKernelFrame;
uniform vec4 uKernelRegion;
uniform vec2 uOutputAt;
${withImages(kernel, images, layer, "p * uKernelAt.z + uKernelAt.xy")}
void main(void) {
  // From the fragment's centre, exact, where an interpolated coordinate is a hair off a half.
  vec2 outCoord = (gl_FragCoord.xy - uOutputAt - uKernelAt.xy) / uKernelAt.z;
  if (any(lessThan(outCoord, uKernelRegion.xy)) || any(greaterThanEqual(outCoord, uKernelRegion.zw))) {
    finalColor = vec4(0.0);
    return;
  }
  finalColor = pbOutput(pbKernel(outCoord));
}
`;
}

const madeBlends = new Map<string, Map<string, string>>();

/**
 * A blend shader's composite (webgl/composite.ts), drawn as the composite
 * program is (programs.ts, compositeFragment), its uniforms the same: as
 * adl runs one, a pixel at a time, each where the layer covers anything
 * and nothing where it does not, or over its whole rectangle (uWhole),
 * the kernel's coordinate (0.5, 0.5) and its first two inputs that pixel
 * of what is below and of the layer, coloured, whatever coordinate it
 * samples them at; its result in place of what was below, as adl writes
 * it (pbOutput). `rows` is the colour transform's reading of uRows
 * (programs.ts, LAYER_COLOR).
 */
export function blendKernel(kernel: string, images: readonly KernelImage[], rows: string): string {
  return madeOnce(madeBlends, kernel, images, () => blendSource(kernel, images, rows));
}

function blendSource(kernel: string, images: readonly KernelImage[], rows: string): string {
  const pixel = (t: number, back: boolean) => `vec4 pbTexel${t}(ivec2 at) {
  return pbBytes(${back ? "pbBack" : "pbFront"});
}`;
  return `#version 300 es
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
${withImages(kernel, images, pixel, "p")}
void main(void) {
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
  finalColor = pbOutput(pbKernel(vec2(0.5)));
}
`;
}

/**
 * The layer shrunk to a texel a stage pixel for a kernel run once a pixel
 * (filter-plan.ts): each output texel the mean of the `uDown.x` by
 * `uDown.x` texels of the pixel it stands for, the grid from `uDown.yz`
 * texels past the input's corner, which may be less than 0; the texels of
 * a pixel past the frame, `uKernelFrame`, left out of the mean.
 */
export const PIXELS_DOWN = `precision highp int;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uTextureRect;
uniform vec3 uDown;
uniform vec2 uKernelFrame;
uniform vec2 uOutputAt;
void main(void) {
  int n = int(uDown.x);
  ivec2 from = ivec2(gl_FragCoord.xy - uOutputAt) * n + ivec2(uDown.yz);
  ivec2 frame = ivec2(uKernelFrame);
  vec4 sum = vec4(0.0);
  float count = 0.0;
  for (int j = 0; j < 16; j++) {
    if (j >= n) { break; }
    for (int i = 0; i < 16; i++) {
      if (i >= n) { break; }
      ivec2 at = from + ivec2(i, j);
      if (all(greaterThanEqual(at, ivec2(0))) && all(lessThan(at, frame))) {
        sum += texelFetch(uTexture, ivec2(uTextureRect.xy) + at, 0);
        count += 1.0;
      }
    }
  }
  finalColor = count > 0.0 ? sum / count : vec4(0.0);
}
`;

/**
 * A kernel's output, run a texel a stage pixel, drawn back over the
 * layer's frame: each texel its pixel's, the grid as PIXELS_DOWN had it.
 */
export const PIXELS_BACK = `precision highp int;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uTextureRect;
uniform vec3 uDown;
uniform vec2 uOutputAt;
void main(void) {
  ivec2 at = (ivec2(gl_FragCoord.xy - uOutputAt) - ivec2(uDown.yz)) / int(uDown.x);
  at = clamp(at, ivec2(0), ivec2(uTextureRect.zw) - 1);
  finalColor = texelFetch(uTexture, ivec2(uTextureRect.xy) + at, 0);
}
`;
