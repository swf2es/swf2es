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
/** Advanced text's glyph quads' attributes past their position (GeometryData.glyphs), in theirs. */
export const ORIGIN_AT = 4;
export const GLYPH_AT = 5;
export const RUN_AT = 6;
export const TINT_AT = 7;

/** The most cutoff table entries a text's draw takes, as the player's text/saffron.ts builds them. */
export const TABLE_ENTRIES = 48;
/** Segments a row of the outlines' texture, as the player's text/saffron.ts stores them. */
export const OUTLINE_ROW = 1024;

/** The most draws a multi-draw of the fill program makes, their rows in its uniforms. */
export const RUN_MOST = 256;

/**
 * Places a vertex by its row's transform, on a quarter of a pixel of
 * Flash's (uUnit of them a stage pixel, from the stage's origin) where
 * uSnap (SNAP), then on the target by uView (scale and offset into clip
 * space), and passes on its straight colour and the row's colour transform.
 * With `multi` (WEBGL_multi_draw), a multi-draw's draws past its first
 * read their rows from uRuns by gl_DrawID, which is 0 in a draw of its own.
 */
export const fillVertex = (multi: boolean) => `#version 300 es
${multi ? "#extension GL_ANGLE_multi_draw : require" : ""}
precision highp float;
layout(location = ${POSITION_AT}) in vec2 aPosition;
layout(location = ${TEXEL_AT}) in vec2 aTexel;
layout(location = ${COLOR_AT}) in vec4 aColor;
uniform highp sampler2D uRows;
uniform int uRow;
${multi ? `uniform ivec4 uRuns[${RUN_MOST / 4}];` : ""}
uniform vec4 uView;
uniform bool uSnap;
uniform float uUnit;
out vec4 vColor;
out vec2 vTexel;
flat out vec4 vMul;
flat out vec4 vAdd;

void main(void) {
  int row = ${multi ? "gl_DrawID == 0 ? uRow : uRuns[gl_DrawID >> 2][gl_DrawID & 3]" : "uRow"};
  ivec2 at = ivec2((row & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, row >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uRows, at, 0);
  vec4 t = texelFetch(uRows, at + ivec2(1, 0), 0);
  vMul = texelFetch(uRows, at + ivec2(2, 0), 0);
  vAdd = texelFetch(uRows, at + ivec2(3, 0), 0);
  vec2 p = vec2(m.x * aPosition.x + m.z * aPosition.y + t.x, m.y * aPosition.x + m.w * aPosition.y + t.y);
  if (uSnap) {
    p = roundEven(p * uUnit * 4.0) / (uUnit * 4.0);
  }

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
 * that many of them (w). uMode: whether it repeats, whether it is smoothed,
 * and whether it is a 3D object's quad (PLANE), which reads its bitmap
 * otherwise. The colour transform then as on a fill.
 */
export const meshFragment = `#version 300 es
precision highp float;
in vec3 vUVT;
flat in vec4 vMul;
flat in vec4 vAdd;
uniform sampler2D uTexture;
uniform vec4 uFrag;
uniform ivec3 uMode;
out vec4 finalColor;

vec4 texel(ivec2 at) {
  return texelFetch(uTexture, at, 0);
}

void main(void) {
  float pixel = uFrag.w;
  vec2 f = vec2(gl_FragCoord.x + uFrag.x, uFrag.y + uFrag.z * gl_FragCoord.y);
  vec2 size = vec2(textureSize(uTexture, 0));
  if (uMode.z != 0) {
    // A 3D object's quad (PLANE): its bitmap read smoothed at the pixel's centre, in its texels.
    vec2 centre = (floor(f / pixel) + 0.5) * pixel;
    vec3 at = vUVT + dFdx(vUVT) * (centre.x - f.x) + dFdy(vUVT) * ((centre.y - f.y) * uFrag.z);
    vec4 shown = texture(uTexture, (at.z != 0.0 ? at.xy / at.z : vec2(0.0)) / size);
    if (shown.a == 0.0) {
      finalColor = vec4(0.0);
      return;
    }

    vec4 s = clamp(vec4(shown.rgb / shown.a, shown.a) * vMul + vAdd, 0.0, 1.0);
    finalColor = vec4(s.rgb * s.a, s.a);
    return;
  }

  vec2 corner = floor(f / pixel) * pixel;
  vec3 uvt = vUVT + dFdx(vUVT) * (corner.x - f.x) + dFdy(vUVT) * ((corner.y - f.y) * uFrag.z);
  vec2 uv = uvt.z != 0.0 ? uvt.xy / uvt.z : vec2(0.0);
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
 * Advanced text's glyph quads, as the Pixi view's Saffron shader places
 * them (player's render/saffron.ts), its transform the row's: the text's
 * pixels to Flash's, uUnit of them a stage pixel, on their grid from the
 * stage's origin, a BitmapData's in a draw. A glyph's pen stands where its
 * text's origin, at a whole pixel, puts it, snapped as its grid fits it
 * (uMode: gridFitType 0 none, 1 pixel, 2 subpixel, thickness, sharpness),
 * and its quad reaches out past its outline by the furthest cutoff. Its
 * colour is drawn under the row's colour transform, light or dark as adl
 * chooses its table. aOrigin: the pen, and its light and dark tables, each
 * its first entry plus 64 times its entries; aGlyph: a corner of its
 * outline's bounds and the way out from it; aRun: its segments, first and
 * count, the pixels of a unit of its outline, and its size.
 */
export const glyphsVertex = `#version 300 es
precision highp float;
layout(location = ${POSITION_AT}) in vec2 aPosition;
layout(location = ${ORIGIN_AT}) in vec4 aOrigin;
layout(location = ${GLYPH_AT}) in vec4 aGlyph;
layout(location = ${RUN_AT}) in vec4 aRun;
layout(location = ${TINT_AT}) in vec4 aColor;
uniform highp sampler2D uRows;
uniform int uRow;
uniform vec4 uView;
uniform float uUnit;
uniform vec4 uMode;
uniform vec4 uTable[${TABLE_ENTRIES}];
out vec2 vPixel;
flat out vec2 vPen;
flat out vec4 vToGlyph;
flat out vec4 vToPixel;
flat out vec4 vCut;
flat out vec4 vShown;

// The cutoffs at ppem by the table of entries start to start + count, as text/csm.ts' cutoffs.
vec2 cutoffs(int start, int count, float ppem) {
  vec4 first = uTable[start];
  vec4 last = uTable[start + count - 1];
  vec2 c = first.yz;
  if (ppem >= last.x) {
    c = last.yz;
  } else if (ppem > first.x) {
    for (int i = 1; i < ${TABLE_ENTRIES}; i++) {
      if (i >= count) {
        break;
      }

      vec4 b = uTable[start + i];
      if (ppem <= b.x) {
        vec4 a = uTable[start + i - 1];
        c = mix(a.yz, b.yz, (ppem - a.x) / (b.x - a.x));
        break;
      }
    }
  }

  float unit = 0.0001 * ppem;
  float t = clamp(uMode.y, -200.0, 200.0);
  float s = clamp(uMode.z, -400.0, 400.0);
  c -= unit * vec2(t + s * 0.5, t - s * 0.5);
  if (c.x < c.y) {
    c = vec2((c.x + c.y) * 0.5);
  }

  return c;
}

void main(void) {
  ivec2 at = ivec2((uRow & ${ROWS_A_LINE - 1}) * ${ROW_TEXELS}, uRow >> ${Math.log2(ROWS_A_LINE)});
  vec4 m = texelFetch(uRows, at, 0);
  vec4 t = texelFetch(uRows, at + ivec2(1, 0), 0);
  vec4 mul = texelFetch(uRows, at + ivec2(2, 0), 0);
  vec4 add = texelFetch(uRows, at + ivec2(3, 0), 0);
  // The text's pixels to Flash's.
  mat2 linear = mat2(m.xy, m.zw) * uUnit;
  vec2 origin = t.xy * uUnit;
  vec2 pen = linear * aOrigin.xy + roundEven(origin);
  float across = max(abs(linear[0][1]), abs(linear[1][0]));
  if (across > max(abs(linear[0][0]), abs(linear[1][1])) / 65536.0) {
    // Turned or skewed: no grid.
  } else if (uMode.x == 1.0) {
    pen = vec2(roundEven(pen.x * 8.0) / 8.0 + 0.5, roundEven(pen.y));
  } else if (uMode.x == 2.0) {
    pen = vec2(roundEven(pen.x * 4.0) / 4.0 + 0.5, roundEven(pen.y));
  } else {
    pen = roundEven(pen * 4.0) / 4.0 + vec2(0.5, 0.0);
  }

  float ppem = aRun.w * sqrt(abs(determinant(linear)));
  // The colour as drawn, straight: light or dark by it, as adl chooses.
  vec4 shown = clamp(aColor * mul + add, 0.0, 1.0);
  bool light = dot(floor(shown.rgb * 255.0 + 0.5), vec3(30.0, 59.0, 11.0)) > 20000.0;
  int table = int(light ? aOrigin.z : aOrigin.w);
  vec2 cut = cutoffs(table & 63, table >> 6, ppem);
  mat2 toPixel = linear * aRun.z;
  float margin = max(abs(cut.x), abs(cut.y)) + 1.0;
  float det = determinant(toPixel);
  mat2 inverse = det != 0.0
    ? mat2(toPixel[1][1], -toPixel[0][1], -toPixel[1][0], toPixel[0][0]) / det
    : mat2(0.0);
  // Out in the glyph's space, so that the margin stays outside under reflections and turns: each
  // row of the inverse gives the glyph's units a pixel across that edge takes.
  vec2 reach = vec2(length(vec2(inverse[0][0], inverse[1][0])),
                    length(vec2(inverse[0][1], inverse[1][1]))) * margin;
  vec2 p = pen + toPixel * (aGlyph.xy + aGlyph.zw * reach);
  vPixel = p;
  vPen = pen;
  vToGlyph = vec4(inverse[0], inverse[1]);
  vToPixel = vec4(toPixel[0], toPixel[1]);
  vCut = vec4(cut, aRun.xy);
  vShown = shown;
  gl_Position = vec4((p / uUnit) * uView.xy + uView.zw, 0.0, 1.0);
}
`;

/**
 * Each pixel of Flash's a glyph's quad covers, by its signed distance to
 * the glyph's outline (the segments of its run in uSegments, the nearest
 * and, by parity, whether it is inside), between the cutoffs, as the Pixi
 * view's Saffron shader covers it. Nothing outside: in a mask, which
 * writes the stencil wherever it draws, a glyph is its shape.
 */
export const glyphsFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vPixel;
flat in vec2 vPen;
flat in vec4 vToGlyph;
flat in vec4 vToPixel;
flat in vec4 vCut;
flat in vec4 vShown;
out vec4 finalColor;
uniform highp sampler2D uSegments;

void main(void) {
  vec2 centre = floor(vPixel) + 0.5;
  mat2 toGlyph = mat2(vToGlyph.xy, vToGlyph.zw);
  mat2 toPixel = mat2(vToPixel.xy, vToPixel.zw);
  vec2 g = toGlyph * (centre - vPen);
  int start = int(vCut.z);
  int count = int(vCut.w);
  float nearest = 3.4e38;
  vec2 along = vec2(1.0, 0.0);
  bool inside = false;
  for (int i = 0; i < count; i++) {
    int k = start + i;
    vec4 s = texelFetch(uSegments, ivec2(k & ${OUTLINE_ROW - 1}, k >> ${Math.log2(OUTLINE_ROW)}), 0);
    vec2 a = s.xy;
    vec2 e = s.zw - a;
    vec2 w = g - a;
    float t = clamp(dot(w, e) / max(dot(e, e), 1e-20), 0.0, 1.0);
    vec2 off = w - e * t;
    float d = dot(off, off);
    if (d < nearest) {
      nearest = d;
      along = e;
    }

    if ((a.y > g.y) != (s.w > g.y) && a.x + (g.y - a.y) * e.x / e.y > g.x) {
      inside = !inside;
    }
  }

  // In Flash's pixels, across the nearest edge as the transform stretches it.
  float stretch = length(toPixel * along);
  float d = stretch > 0.0
    ? sqrt(nearest) * abs(determinant(toPixel)) * length(along) / stretch
    : 0.0;
  d = inside ? d : -d;
  float coverage = vCut.x > vCut.y
    ? clamp((d - vCut.y) / (vCut.x - vCut.y), 0.0, 1.0)
    : step(vCut.x, d);
  if (coverage <= 0.0) {
    discard;
  }

  finalColor = vec4(vShown.rgb * vShown.a, vShown.a) * coverage;
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
