import { ROWS_A_LINE } from "../rows.js";

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
