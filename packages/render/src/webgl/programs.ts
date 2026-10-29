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
 * Places a vertex by its row's transform, then on the target by uView
 * (scale and offset into clip space), and passes on its straight colour
 * and the row's colour transform.
 */
export const fillVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aTexel;
in vec4 aColor;
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
