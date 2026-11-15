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

/** A program whose shaders were compiled and which was linked, its status not asked yet (endProgram). */
export interface PendingProgram {
  program: WebGLProgram;
  vertex: WebGLShader;
  fragment: WebGLShader;
}

/**
 * A program of GLSL `vertex` and `fragment` compiled and linked, nothing
 * asked of it yet: a driver may do the work on threads of its own
 * (KHR_parallel_shader_compile) while the page goes on, until endProgram
 * asks how it went, which waits for it.
 */
export function beginProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): PendingProgram {
  const v = gl.createShader(gl.VERTEX_SHADER);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  const p = gl.createProgram();
  if (!v || !f || !p) {
    gl.deleteShader(v);
    gl.deleteShader(f);
    gl.deleteProgram(p);
    throw new ShaderError("allocate", "cannot allocate shader");
  }

  gl.shaderSource(v, vertex);
  gl.shaderSource(f, fragment);
  gl.compileShader(v);
  gl.compileShader(f);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  return { program: p, vertex: v, fragment: f };
}

/**
 * The program beginProgram made, once it is linked, its shaders detached
 * and deleted; nothing left behind if it failed, which a ShaderError says
 * where.
 */
export function endProgram(gl: WebGL2RenderingContext, pending: PendingProgram): WebGLProgram {
  const { program: p, vertex: v, fragment: f } = pending;
  let linked = false;
  try {
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (
        !gl.getShaderParameter(v, gl.COMPILE_STATUS) ||
        !gl.getShaderParameter(f, gl.COMPILE_STATUS)
      ) {
        throw new ShaderError("compile", `${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
      }

      throw new ShaderError("link", `${gl.getProgramInfoLog(p)}`);
    }

    linked = true;
    return p;
  } finally {
    gl.detachShader(p, v);
    gl.detachShader(p, f);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!linked) {
      gl.deleteProgram(p);
    }
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
  return endProgram(gl, beginProgram(gl, vertex, fragment));
}
