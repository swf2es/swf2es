// The fragment shaders of Flash's filters, as adl draws them (docs/architecture.md,
// "Filters"), which the renderer's passes (webgl/filters.ts) run, so that their
// exactness rules live in one place. GLSL ES 3 bodies, with no version or precision
// line; each reads vTextureCoord, its input's texture coordinate, and writes finalColor.

/** Truncated to 8 bits, as adl's each pass is: a hair over, so that an exact value stays. */
export const TRUNCATE = "floor(c * 255.0 + 0.001) / 255.0";

/**
 * One run of the box one way: `uWidth` texels wide, its end texels weighted
 * by their part; `uDirection` a texel's step in the input's pixels, which
 * uInputSize gives the coordinates in.
 */
export const BOX = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
// As the vertex shader has it, which is highp: a program's uniforms agree.
uniform highp vec4 uInputSize;
uniform vec2 uDirection;
uniform float uWidth;
void main(void) {
  float half_ = uWidth * 0.5;
  int reach = int(ceil(half_));
  vec4 sum = vec4(0.0);
  // As far as 255 pixels at 4 texels a pixel, each way.
  for (int i = 0; i <= 2040; i++) {
    if (i > 2 * reach) { break; }
    float f = float(i - reach);
    float weight = max(0.0, min(f + 0.5, half_) - max(f - 0.5, -half_));
    sum += texture(uTexture, vTextureCoord + uDirection * uInputSize.zw * f) * weight;
  }
  vec4 c = sum / uWidth;
  finalColor = ${TRUNCATE};
}`;

// The mean of the uFactor.x by uFactor.y texels of the input that a texel of the output covers,
// the output that many times narrower and lower (blurShrink). Two texels each way a read: a linear read midway between texel centres is their mean, so a
// block takes a quarter of the reads. An odd factor's last column or row is read alone, weighted
// by the texels each read stands for. A pool texture has no levels but its base.
export const SHRINK = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputPixel;
uniform vec2 uFactor;
void main(void) {
  vec4 sum = vec4(0.0);
  vec2 centre = (uFactor - 1.0) * 0.5;
  for (int j = 0; j < 16; j += 2) {
    float y = float(j);
    if (y >= uFactor.y) { break; }
    float ny = min(2.0, uFactor.y - y);
    for (int i = 0; i < 16; i += 2) {
      float x = float(i);
      if (x >= uFactor.x) { break; }
      float nx = min(2.0, uFactor.x - x);
      vec2 at = vec2(x, y) + (vec2(nx, ny) - 1.0) * 0.5 - centre;
      sum += texture(uTexture, vTextureCoord + at * uInputPixel.zw) * (nx * ny);
    }
  }
  finalColor = sum / (uFactor.x * uFactor.y);
}`;

/** A blur's runs, done coarser (blurred), drawn back between their texels over the input's frame. */
export const READ_BACK = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uBlurred;
uniform vec2 uBlurredScale;
void main(void) {
  finalColor = texture(uBlurred, vTextureCoord * uBlurredScale);
}`;

/**
 * A glow or a shadow: the input's blurred alpha (uBlurred), from `uOffset`
 * texels back for a shadow, times strength and alpha, in its colour; behind
 * the object, or inside it for an inner one; the object kept, or not.
 */
export const GLOW = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform highp vec4 uInputSize;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uStrength;
uniform vec2 uOffset;
uniform vec2 uBlurredScale;
uniform float uInner;
uniform float uKnockout;
uniform float uHide;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  float a = texture(uBlurred, (vTextureCoord - uOffset * uInputSize.zw) * uBlurredScale).a;
  vec4 c;
  if (uInner > 0.5) {
    float g = clamp((1.0 - a) * uStrength, 0.0, 1.0) * uAlpha * src.a;
    vec4 glow = vec4(uColor * g, g);
    c = uKnockout > 0.5 ? glow : glow + src * (1.0 - g);
  } else {
    float g = clamp(a * uStrength, 0.0, 1.0) * uAlpha;
    vec4 glow = vec4(uColor * g, g);
    c = uKnockout > 0.5 ? glow * (1.0 - src.a) : uHide > 0.5 ? glow : src + glow * (1.0 - src.a);
  }
  finalColor = ${TRUNCATE};
}`;

/**
 * A bevel: the input's blurred alpha (uBlurred) from uOffset texels on and
 * back; their difference times strength, clamped, times the colour's alpha,
 * the highlight where on is more and the shadow where it is less. Inner
 * (uType 0) atop the object, outer (1) behind it, full (2) over it;
 * knocked out, alone, masked to where the object is (inner) or is not
 * (outer).
 */
export const BEVEL = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform highp vec4 uInputSize;
uniform vec3 uHighlight;
uniform vec3 uShadow;
uniform float uHighlightAlpha;
uniform float uShadowAlpha;
uniform float uStrength;
uniform vec2 uOffset;
uniform float uType;
uniform float uKnockout;
void main(void) {
  // Keep source samples sharp; the bevel reads alpha at a stage pixel's centre.
  vec2 at = (floor(vTextureCoord * uInputSize.xy) + 0.5) * uInputSize.zw;
  vec4 src = texture(uTexture, vTextureCoord);
  vec2 step_ = uOffset * uInputSize.zw;
  // In 255ths, each read truncated, as adl's are.
  float on = floor(texture(uBlurred, at + step_).a * 255.0 + 0.001);
  float back = floor(texture(uBlurred, at - step_).a * 255.0 + 0.001);
  float d = on - back;
  bool lit = d > 0.0;
  float strong = min(255.0, floor(abs(d) * uStrength + 0.001));
  float la = floor(strong * (lit ? uHighlightAlpha : uShadowAlpha) + 0.5) / 255.0;
  float m = uType < 0.5 ? src.a : (uType < 1.5 && uKnockout > 0.5 ? 1.0 - src.a : 1.0);
  vec4 layer = vec4((lit ? uHighlight : uShadow) * la, la) * m;
  vec4 c;
  if (uKnockout > 0.5) {
    c = layer;
  } else if (uType > 0.5 && uType < 1.5) {
    c = src + layer * (1.0 - src.a);
  } else {
    c = layer + src * (1.0 - (uType < 0.5 ? la : layer.a));
  }
  finalColor = ${TRUNCATE};
}`;

/**
 * How a bevel or a gradient filter places its layer (premultiplied) on the
 * object's pixel, as bitmap/filters' placer does: masked to where the
 * object is (uType 0, inner) or, knocked out, is not (1, outer); inner
 * atop it, outer behind it, full (2) over it, knocked out alone.
 */
export const PLACE = `vec4 place(vec4 src, vec4 layer) {
  float m = uType < 0.5 ? src.a : (uType < 1.5 && uKnockout > 0.5 ? 1.0 - src.a : 1.0);
  vec4 masked = layer * m;
  if (uKnockout > 0.5) {
    return masked;
  }
  if (uType > 0.5 && uType < 1.5) {
    return src + masked * (1.0 - src.a);
  }
  return masked + src * (1.0 - (uType < 0.5 ? layer.a : masked.a));
}`;

/**
 * A gradient glow: the input's blurred alpha (uBlurred) from uOffset back,
 * as a shadow reads it, times strength, picking a texel of the gradient
 * (uGradient, 256 wide); a gradient bevel (uBevel 1): the difference of
 * that alpha on and back, the middle of the gradient where they agree.
 * Each pixel is evaluated once, at its centre, in 255ths truncated.
 */
export const GRADIENT = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uBlurred;
uniform sampler2D uGradient;
uniform highp vec4 uInputSize;
uniform float uStrength;
uniform vec2 uOffset;
uniform float uType;
uniform float uKnockout;
uniform float uBevel;
uniform vec4 uRegion;
${PLACE}
float alphaAt(vec2 at) {
  return floor(texture(uBlurred, at).a * 255.0 + 0.001);
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5;
  // Past the filter's rect it draws nothing, though its gradient may have colour at 0.
  if (any(lessThan(p, uRegion.xy)) || any(greaterThanEqual(p, uRegion.zw))) {
    finalColor = vec4(0.0);
    return;
  }
  vec2 at = p * uInputSize.zw;
  vec4 src = texture(uTexture, at);
  vec2 step_ = uOffset * uInputSize.zw;
  float index;
  if (uBevel > 0.5) {
    float d = clamp(floor((alphaAt(at + step_) - alphaAt(at - step_)) * uStrength), -255.0, 255.0);
    index = floor((d + 256.0) / 2.0);
  } else {
    index = min(255.0, floor(alphaAt(at - step_) * uStrength + 0.001));
  }
  vec4 layer = texture(uGradient, vec2((index + 0.5) / 256.0, 0.5));
  vec4 c = place(src, layer);
  finalColor = ${TRUNCATE};
}`;

/**
 * A displacement map, in the input's pixels from its frame's corner: each
 * pixel of the object's (uBox) where the map lies (uMapAt, uMapSize) takes
 * the input at itself moved by the map's channel (uComponents picks one
 * for x, one for y) less 128, times scale, in 256ths toward 0, between
 * pixels with weights in 256ths; past the object's pixels as uMode says:
 * 0 wrap, 1 clamp, 2 its own place, 3 uColor, which also fills uGrow pixels
 * round the object, as adl's drawing of it does. Each pixel once, at its
 * centre.
 */
export const DISPLACE = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uMap;
uniform highp vec4 uInputSize;
uniform vec4 uBox;
uniform vec4 uMapAt;
uniform vec4 uComponentX;
uniform vec4 uComponentY;
uniform vec2 uScale;
uniform float uMode;
uniform vec4 uColor;
uniform vec2 uGrow;
vec4 read(vec2 at, vec2 own) {
  vec2 size = uBox.zw - uBox.xy;
  vec2 i = at - uBox.xy;
  if (any(lessThan(i, vec2(0.0))) || any(greaterThanEqual(i, size))) {
    if (uMode < 0.5) {
      i = mod(i, size);
    } else if (uMode < 2.5) {
      i = clamp(i, vec2(0.0), size - 1.0);
    } else {
      return uColor;
    }
  }
  return texture(uTexture, (uBox.xy + i + 0.5) * uInputSize.zw);
}
void main(void) {
  vec2 p = floor(vTextureCoord * uInputSize.xy);
  vec4 own = texture(uTexture, (p + 0.5) * uInputSize.zw);
  vec2 m = p - uMapAt.xy;
  if (any(lessThan(p, uBox.xy)) || any(greaterThanEqual(p, uBox.zw))) {
    bool near = all(greaterThanEqual(p, uBox.xy - uGrow)) && all(lessThan(p, uBox.zw + uGrow));
    finalColor = uMode > 2.5 && near ? uColor : vec4(0.0);
    return;
  }
  if (any(lessThan(m, vec2(0.0))) || any(greaterThanEqual(m, uMapAt.zw))) {
    finalColor = own;
    return;
  }
  vec4 map = texture(uMap, (m + 0.5) / uMapAt.zw);
  vec4 straight = map.a > 0.0 ? vec4(map.rgb / map.a, map.a) : vec4(0.0);
  vec2 c = floor(vec2(dot(straight, uComponentX), dot(straight, uComponentY)) * 255.0 + 0.5);
  // None picked: no move.
  c = vec2(uComponentX == vec4(0.0) ? 128.0 : c.x, uComponentY == vec4(0.0) ? 128.0 : c.y);
  // Toward 0, without trunc, which GLSL ES 1 has not.
  vec2 moved = (c - 128.0) * uScale;
  vec2 q = p * 256.0 + sign(moved) * floor(abs(moved));
  vec2 whole = floor(q / 256.0);
  vec2 f = q - whole * 256.0;
  if (uMode > 1.5 && uMode < 2.5) {
    vec2 i = whole - uBox.xy;
    vec2 size = uBox.zw - uBox.xy;
    whole = vec2(i.x < 0.0 || i.x >= size.x ? p.x : whole.x, i.y < 0.0 || i.y >= size.y ? p.y : whole.y);
  }
  float w00 = floor((256.0 - f.x) * (256.0 - f.y) / 256.0);
  float w10 = floor(f.x * (256.0 - f.y) / 256.0);
  float w01 = floor((256.0 - f.x) * f.y / 256.0);
  float w11 = floor(f.x * f.y / 256.0);
  vec4 v = read(whole, p) * w00 + read(whole + vec2(1.0, 0.0), p) * w10 +
    read(whole + vec2(0.0, 1.0), p) * w01 + read(whole + vec2(1.0, 1.0), p) * w11;
  vec4 c8 = floor(v * 255.0 / 256.0 + 0.001) / 255.0;
  finalColor = c8;
}`;

/** A colour matrix of a pixel's straight colour, its offsets in 255ths, transparent pixels too. */
export const MATRIX = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform mat4 uMatrix;
uniform vec4 uOffset;
void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  vec4 straight = src.a > 0.0 ? vec4(src.rgb / src.a, src.a) : vec4(0.0);
  vec4 s = clamp(uMatrix * straight + uOffset, 0.0, 1.0);
  vec4 c = vec4(s.rgb * s.a, s.a);
  finalColor = ${TRUNCATE};
}`;

/**
 * A convolution, in 255ths: the taps' straight colour over uBox, the
 * object's pixels as adl filters them, in the input's pixels from its
 * frame's corner; past it the nearest edge's or uEdge; summed, divided,
 * biased, clamped and premultiplied as bitmap/filters' convolve does, the
 * fixed-point way too (uReciprocal not 0) where every tap lies in the box.
 */
export const CONVOLUTION = `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uMatrix[57];
uniform vec2 uSize;
uniform vec4 uBox;
uniform vec4 uEdge;
uniform float uDivisor;
uniform float uReciprocal;
uniform float uBias;
uniform float uClamp;
uniform float uPreserve;
vec4 straight(vec2 p) {
  if (any(lessThan(p, uBox.xy)) || any(greaterThanEqual(p, uBox.zw))) {
    if (uClamp < 0.5) { return uEdge; }
    p = clamp(p, floor(uBox.xy) + 0.5, floor(uBox.zw) - 0.5);
  }
  vec4 c = texture(uTexture, p * uInputSize.zw);
  return c.a > 0.0 ? floor(vec4(c.rgb / c.a, c.a) * 255.0 + 0.5) : vec4(0.0);
}
void main(void) {
  // The pixel's centre, which all its texels read alike, as adl's one pixel.
  vec2 p = floor(vTextureCoord * uInputSize.xy) + 0.5;
  vec2 reach = floor(uSize * 0.5);
  if (any(lessThan(p, uBox.xy - reach)) || any(greaterThanEqual(p, uBox.zw + reach))) {
    finalColor = vec4(0.0);
    return;
  }
  bool fixed_ = uReciprocal != 0.0 && all(greaterThanEqual(p - 1.0, uBox.xy)) &&
    all(lessThan(p + 1.0, uBox.zw));
  int cols = int(uSize.x);
  int count = cols * int(uSize.y);
  vec4 sum = vec4(0.0);
  // One loop, its index alone indexing the weights, as GLSL ES 1 allows.
  for (int k = 0; k < 225; k++) {
    if (k >= count) { break; }
    float w = dot(uMatrix[k / 4], vec4(equal(vec4(float(k - k / 4 * 4)), vec4(0.0, 1.0, 2.0, 3.0))));
    if (w != 0.0) {
      int j = k / cols;
      vec2 at = vec2(float(k - j * cols), float(j)) - reach;
      sum += straight(fixed_ && k == 8 ? p : p + at) * w;
    }
  }
  sum = fixed_ ? floor(sum * uReciprocal) : sum / uDivisor;
  vec4 v = floor(clamp(sum + uBias, 0.0, 255.0) + 0.0001);
  float a = uPreserve > 0.5 ? straight(p).a : v.a;
  vec3 c = fixed_ ? floor(v.rgb * a / 255.0) : floor((v.rgb * a + 127.0) / 255.0);
  finalColor = vec4(c, a) / 255.0;
}`;
