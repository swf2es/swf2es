/**
 * Why a program could not be made: no objects to make it of, a stage that
 * did not compile, or no link. `lost` where the context was lost meanwhile,
 * which is no fault of the shaders: made again once it is restored.
 */
export class ShaderError extends Error {
  constructor(
    readonly stage: "allocate" | "compile" | "link",
    readonly log: string,
    readonly lost = false,
  ) {
    super(log || `${stage} failed${lost ? ", the context lost" : ""}`);
    this.name = "ShaderError";
  }
}

/** Whether `e` is a program not made because the context was lost (ShaderError.lost). */
export function lostShader(e: unknown): e is ShaderError {
  return e instanceof ShaderError && e.lost;
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
    // WebGL makes no objects on a lost context alone.
    throw new ShaderError("allocate", "cannot allocate shader", gl.isContextLost());
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
      const compiled =
        gl.getShaderParameter(v, gl.COMPILE_STATUS) && gl.getShaderParameter(f, gl.COMPILE_STATUS);
      const log = compiled
        ? (gl.getProgramInfoLog(p) ?? "")
        : `${gl.getShaderInfoLog(v) ?? ""} ${gl.getShaderInfoLog(f) ?? ""}`.trim();
      // A GPU process that died answers every status false and every log empty, and Chrome
      // flags the context lost only a task later: a failure that says nothing is taken for a
      // loss, as a shader that did not compile or link says why.
      throw new ShaderError(compiled ? "link" : "compile", log, gl.isContextLost() || log === "");
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
