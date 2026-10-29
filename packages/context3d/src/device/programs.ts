/** Why a program could not be made: no objects to make it of, a stage that did not compile, or no link. */
export class ShaderError extends Error {
  constructor(
    readonly stage: "allocate" | "compile" | "link",
    readonly log: string,
  ) {
    super(log);
    this.name = "ShaderError";
  }
}

/**
 * A program linked from GLSL `vertex` and `fragment`, its shaders detached
 * and deleted once linked, and nothing left behind if it fails: a
 * ShaderError says where.
 */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram {
  const v = gl.createShader(gl.VERTEX_SHADER);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  const p = gl.createProgram();
  let linked = false;
  let attached = false;
  try {
    if (!v || !f || !p) {
      throw new ShaderError("allocate", "cannot allocate shader");
    }

    gl.shaderSource(v, vertex);
    gl.shaderSource(f, fragment);
    gl.compileShader(v);
    gl.compileShader(f);
    if (
      !gl.getShaderParameter(v, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(f, gl.COMPILE_STATUS)
    ) {
      throw new ShaderError("compile", `${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
    }

    gl.attachShader(p, v);
    gl.attachShader(p, f);
    attached = true;
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new ShaderError("link", `${gl.getProgramInfoLog(p)}`);
    }

    linked = true;
    return p;
  } finally {
    if (attached && p && v) {
      gl.detachShader(p, v);
    }
    if (attached && p && f) {
      gl.detachShader(p, f);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!linked) {
      gl.deleteProgram(p);
    }
  }
}
