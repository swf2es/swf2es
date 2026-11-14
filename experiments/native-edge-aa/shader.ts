/** Experimental fill coverage, after the colour transform and premultiplication. */
export function enableCoverage(gl: WebGL2RenderingContext): () => void {
  const original = gl.shaderSource;
  gl.shaderSource = function (shader, source) {
    if (source.includes("flat in int vSlot;") && source.includes("vec4 straight = vColor;")) {
      const anchor = "finalColor = vec4(c.rgb * c.a, c.a);";
      if (!source.includes(anchor)) {
        throw new Error("The experimental fill shader needs updating");
      }
      source = source.replace(
        anchor,
        "finalColor = vec4(c.rgb * c.a, c.a) * (vSlot == 0 && vTexel.y < 0.0 ? clamp(vTexel.x, 0.0, 1.0) : 1.0);",
      );
    }
    original.call(this, shader, source);
  };
  return () => {
    gl.shaderSource = original;
  };
}
