import { ROWS_A_LINE } from "../rows.js";
import {
  ADD,
  ALPHA,
  DARKEN,
  DIFFERENCE,
  ERASE,
  HARDLIGHT,
  INVERT,
  LAYER,
  LIGHTEN,
  MULTIPLY,
  NORMAL,
  OVERLAY,
  SCREEN,
  SUBTRACT,
} from "../scene.js";

/** Texels a row (ROW_FLOATS over four). */
export const ROW_TEXELS = 4;

/**
 * The vertex atlas' attributes, where both the fill and the mesh programs
 * read them: a mesh's depth is the four bytes of its colour, as a float.
 */
export const POSITION_AT = 0;
export const TEXEL_AT = 1;
export const COLOR_AT = 2;
export const DEPTH_AT = 3;

/**
 * Places a vertex by its row's transform, then on the target by uView
 * (scale and offset into clip space), and passes on its straight colour
 * and the row's colour transform.
 */
export const fillVertex = `#version 300 es
precision highp float;
layout(location = ${POSITION_AT}) in vec2 aPosition;
layout(location = ${TEXEL_AT}) in vec2 aTexel;
layout(location = ${COLOR_AT}) in vec4 aColor;
uniform highp sampler2D uRows;
uniform int uRow;
uniform vec4 uView;
out vec4 vColor;
out vec2 vTexel;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
  ivec2 at = ivec2((uRow & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, uRow >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uRows, at, 0);
  vec4 t = texelFetch(uRows, at + ivec2(1, 0), 0);
  vMul = texelFetch(uRows, at + ivec2(2, 0), 0);
  vAdd = texelFetch(uRows, at + ivec2(3, 0), 0);
  vec2 p = vec2(m.x * aPosition.x + m.z * aPosition.y + t.x, m.y * aPosition.x + m.w * aPosition.y + t.y);
  gl_Position = vec4(p * uView.xy + uView.zw, 0.0, 1.0);
  vColor = aColor;
  vTexel = aTexel;
}
`;

/**
 * Flash's colour transform on the straight colour, clamped, then
 * premultiplied for blending: the vertex' colour, or with a texture the
 * texel's (premultiplied in the texture) times it, as the colour batcher
 * did, a clear texel staying clear.
 */
export const fillFragment = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vTexel;
flat in vec4 vMul;
flat in vec4 vAdd;
uniform sampler2D uTexture;
uniform bool uTextured;
out vec4 finalColor;

void main(void) {
  vec4 straight = vColor;
  if (uTextured) {
    vec4 t = texture(uTexture, vTexel / vec2(textureSize(uTexture, 0)));
    if (t.a == 0.0) {
      finalColor = vec4(0.0);
      return;
    }

    straight = vec4(t.rgb / t.a * vColor.rgb, t.a * vColor.a);
  }

  vec4 c = clamp(straight * vMul + vAdd, 0.0, 1.0);
  finalColor = vec4(c.rgb * c.a, c.a);
}
`;

/**
 * drawTriangles' textured triangles (MESH), placed as fills are, their u
 * and v carried times their depth t, and t, which the GPU interpolates
 * straight across the screen for each pixel to divide.
 */
export const meshVertex = `#version 300 es
precision highp float;
layout(location = ${POSITION_AT}) in vec2 aPosition;
layout(location = ${TEXEL_AT}) in vec2 aTexel;
layout(location = ${DEPTH_AT}) in float aDepth;
uniform highp sampler2D uRows;
uniform int uRow;
uniform vec4 uView;
out vec3 vUVT;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
  ivec2 at = ivec2((uRow & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, uRow >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uRows, at, 0);
  vec4 t = texelFetch(uRows, at + ivec2(1, 0), 0);
  vMul = texelFetch(uRows, at + ivec2(2, 0), 0);
  vAdd = texelFetch(uRows, at + ivec2(3, 0), 0);
  vec2 p = vec2(m.x * aPosition.x + m.z * aPosition.y + t.x, m.y * aPosition.x + m.w * aPosition.y + t.y);
  gl_Position = vec4(p * uView.xy + uView.zw, 0.0, 1.0);
  vUVT = vec3(aTexel * aDepth, aDepth);
}
`;

/**
 * drawTriangles' bitmap as adl samples it, as the Pixi view's mesh shader
 * does (player's render/triangles.ts): u and v from 0 to 1 onto the first
 * texel's centre to the last's, wrapped into that or clamped to it, read
 * once a pixel of Flash's, at its top left corner; not smoothed, the nearer
 * texel, the lower of two as near; smoothed, the four around, weighed.
 * uFrag takes a fragment to the target's pixels from the stage's origin,
 * down (x + uFrag.x, uFrag.y + uFrag.z * y), and is a pixel of Flash's
 * that many of them (w). uMode: whether it repeats, whether it is smoothed.
 * The colour transform then as on a fill.
 */
export const meshFragment = `#version 300 es
precision highp float;
in vec3 vUVT;
flat in vec4 vMul;
flat in vec4 vAdd;
uniform sampler2D uTexture;
uniform vec4 uFrag;
uniform ivec2 uMode;
out vec4 finalColor;

vec4 texel(ivec2 at) {
  return texelFetch(uTexture, at, 0);
}

void main(void) {
  float pixel = uFrag.w;
  vec2 f = vec2(gl_FragCoord.x + uFrag.x, uFrag.y + uFrag.z * gl_FragCoord.y);
  vec2 corner = floor(f / pixel) * pixel;
  vec3 uvt = vUVT + dFdx(vUVT) * (corner.x - f.x) + dFdy(vUVT) * ((corner.y - f.y) * uFrag.z);
  vec2 uv = uvt.z != 0.0 ? uvt.xy / uvt.z : vec2(0.0);
  vec2 size = vec2(textureSize(uTexture, 0));
  // As adl draws one, a bitmap a texel high shows its first texel throughout.
  if (size.y == 1.0) {
    uv = vec2(0.0);
  }

  // A hair nearer 0, as adl's come out, stepped across the triangle in fixed point: 1 wraps to
  // the last texel, not the first, and a corner halfway between texels takes the one nearer 0.
  uv -= sign(uv) / 16384.0;
  uv = uMode.x != 0 ? fract(uv) : clamp(uv, 0.0, 1.0);
  vec2 p = uv * (size - 1.0);
  vec4 color;
  if (uMode.y != 0) {
    vec2 below = floor(p);
    vec2 w = p - below;
    ivec2 a = ivec2(below);
    ivec2 b = min(a + 1, ivec2(size) - 1);
    color = mix(
      mix(texel(a), texel(ivec2(b.x, a.y)), w.x),
      mix(texel(ivec2(a.x, b.y)), texel(b), w.x),
      w.y
    );
  } else {
    color = texel(ivec2(floor(p + 0.5)));
  }

  if (color.a == 0.0) {
    finalColor = vec4(0.0);
    return;
  }

  vec4 c = clamp(vec4(color.rgb / color.a, color.a) * vMul + vAdd, 0.0, 1.0);
  finalColor = vec4(c.rgb * c.a, c.a);
}
`;

/**
 * Two triangles over a layer's rectangle of the target, uRect its corners
 * in clip space: a rasteriser then steps over those pixels alone, as a
 * software one does not for a triangle over the whole target cut by the
 * scissor.
 */
export const compositeVertex = `#version 300 es
uniform vec4 uRect;
void main(void) {
  int k = gl_VertexID;
  vec2 p = vec2(k == 1 || k == 2 || k == 4 ? 1.0 : 0.0, k == 2 || k == 4 || k == 5 ? 1.0 : 0.0);
  gl_Position = vec4(mix(uRect.xy, uRect.zw, p), 0.0, 1.0);
}
`;

/**
 * A layer composited onto what is below over its rectangle, pixel for
 * pixel: its rows run down, as the filters read them, and the target's up
 * where it is the canvas (uFlip), from uOffset in its framebuffer; what is
 * below copied with the rectangle's corner uBackOffset short of where it
 * lies. Coloured by its
 * row's colour transform where it has one (uRow not -1), on its straight
 * colour where it covers anything; then blended by its mode. Normal, layer,
 * add and screen are left to GL's blending; the rest read what is below
 * (uBack, a copy of it) and give the whole result, as the Pixi view's
 * blend filters do (render/blend.ts): the separable modes blend straight
 * colours and composite source over, the others have formulas of their own.
 */
export const compositeFragment = `#version 300 es
precision highp float;
uniform sampler2D uLayer;
uniform sampler2D uBack;
uniform highp sampler2D uRows;
uniform int uRow;
uniform int uMode;
uniform ivec2 uOffset;
uniform bool uFlip;
uniform ivec2 uBackOffset;
out vec4 finalColor;

vec3 straight(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
vec3 hardlight(vec3 cb, vec3 cf) {
  vec3 multiply = 2.0 * cb * cf;
  vec3 screen = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cf);
  return mix(multiply, screen, step(0.5, cf));
}

void main(void) {
  ivec2 frag = ivec2(gl_FragCoord.xy);
  ivec2 at = ivec2(frag.x - uOffset.x, uFlip ? uOffset.y - frag.y : frag.y - uOffset.y);
  vec4 front = texelFetch(uLayer, at, 0);
  if (uRow >= 0 && front.a > 0.0) {
    ivec2 row = ivec2((uRow & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, uRow >> ${Math.log2(ROWS_A_LINE)});
    vec4 mul = texelFetch(uRows, row + ivec2(2, 0), 0);
    vec4 add = texelFetch(uRows, row + ivec2(3, 0), 0);
    vec4 c = clamp(vec4(front.rgb / front.a, front.a) * mul + add, 0.0, 1.0);
    front = vec4(c.rgb * c.a, c.a);
  }

  if (uMode == ${NORMAL} || uMode == ${LAYER} || uMode == ${SCREEN} || uMode == ${ADD}) {
    finalColor = front;
    return;
  }

  vec4 back = texelFetch(uBack, frag - uBackOffset, 0);
  vec3 cb = straight(back);
  vec3 cf = straight(front);
  vec3 b;
  switch (uMode) {
    case ${MULTIPLY}: b = cb * cf; break;
    case ${LIGHTEN}: b = max(cb, cf); break;
    case ${DARKEN}: b = min(cb, cf); break;
    case ${DIFFERENCE}: b = abs(cb - cf); break;
    case ${OVERLAY}: b = hardlight(cf, cb); break;
    case ${HARDLIGHT}: b = hardlight(cb, cf); break;
    case ${SUBTRACT}:
      finalColor = vec4(max(back.rgb - front.rgb, 0.0), front.a + back.a * (1.0 - front.a));
      return;
    case ${INVERT}:
      finalColor = vec4((back.a - back.rgb) * front.a + back.rgb * (1.0 - front.a), back.a);
      return;
    case ${ALPHA}:
      finalColor = front.a > 0.0 ? back * front.a : back;
      return;
    case ${ERASE}:
      finalColor = back * (1.0 - front.a);
      return;
    default:
      finalColor = front + back * (1.0 - front.a);
      return;
  }

  vec3 co = front.rgb * (1.0 - back.a) + back.rgb * (1.0 - front.a) + front.a * back.a * b;
  finalColor = vec4(co, front.a + back.a * (1.0 - front.a));
}
`;
