import { type SamplerSource, translate } from "../agal.js";
import { Context3DError } from "../errors.js";

export interface ProgramState {
  handle: WebGLProgram | null;
  targetY: WebGLUniformLocation | null;
  attributes: number[];
  vertex: (WebGLUniformLocation | null)[];
  vertexBank: WebGLUniformLocation | null;
  fragment: (WebGLUniformLocation | null)[];
  samplers: { source: SamplerSource; location: WebGLUniformLocation | null }[];
  samplerMask: number;
}

export interface CopyProgram {
  handle: WebGLProgram;
  size: WebGLUniformLocation | null;
  face: WebGLUniformLocation | null;
}

export function uploadProgram(
  gl: WebGL2RenderingContext,
  state: ProgramState,
  vertex: Uint8Array,
  fragment: Uint8Array,
): void {
  // Translate both before allocating anything on the GPU.
  const vs = translate(vertex, "vertex");
  const fs = translate(fragment, "fragment");
  for (let i = 0; i < 8; i++) {
    if (fs.varyings[i] & ~vs.varyings[i]) {
      throw new Context3DError(
        "agalVaryingMissing",
        "Fragment program reads an unwritten varying component",
      );
    }
  }
  for (let i = 0; i < 8; i++) {
    if (vs.varyings[i] && vs.varyings[i] !== 15) {
      throw new Context3DError(
        "agalVaryingPartial",
        "Vertex program only partially writes a varying",
      );
    }
  }

  const handle = linkProgram(gl, vs.source, fs.source);
  if (state.handle && gl.getParameter(gl.CURRENT_PROGRAM) === state.handle) {
    gl.useProgram(null);
  }

  gl.deleteProgram(state.handle);
  state.handle = handle;
  state.targetY = gl.getUniformLocation(handle, "targetY");
  state.attributes = vs.attributes;
  state.vertex = [];
  state.vertexBank = vs.indirect ? gl.getUniformLocation(handle, "vc[0]") : null;
  state.fragment = [];
  state.samplers = [];
  state.samplerMask = 0;
  for (let i = 0; i < vs.constants.length; i++) {
    const index = vs.constants[i];
    state.vertex[index] = gl.getUniformLocation(handle, `vc${index}`);
  }

  for (let i = 0; i < fs.constants.length; i++) {
    const index = fs.constants[i];
    state.fragment[index] = gl.getUniformLocation(handle, `fc${index}`);
  }

  for (let i = 0; i < fs.samplers.length; i++) {
    const source = fs.samplers[i];
    state.samplerMask |= 1 << source.index;
    state.samplers.push({
      source,
      location: gl.getUniformLocation(handle, `fs${source.index}`),
    });
  }
}

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
      throw new Context3DError("operation", "Context3D experiment: cannot allocate shader");
    }

    gl.shaderSource(v, vertex);
    gl.shaderSource(f, fragment);
    gl.compileShader(v);
    gl.compileShader(f);
    if (
      !gl.getShaderParameter(v, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(f, gl.COMPILE_STATUS)
    ) {
      throw new Context3DError(
        "nativeShader",
        `Context3D shader: ${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`,
      );
    }

    gl.attachShader(p, v);
    gl.attachShader(p, f);
    attached = true;
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Context3DError("nativeShader", `Context3D link: ${gl.getProgramInfoLog(p)}`);
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

export function createCopyProgram(gl: WebGL2RenderingContext, cube: boolean): CopyProgram {
  const vertex = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const fragment = cube
    ? `#version 300 es
precision highp float;
uniform samplerCube uSource;
uniform vec2 uSize;
uniform int uFace;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy * 2.0 / uSize - 1.0;
  vec3 direction;
  switch (uFace) {
    case 0: direction = vec3(1.0, -p.y, -p.x); break;
    case 1: direction = vec3(-1.0, -p.y, p.x); break;
    case 2: direction = vec3(p.x, 1.0, p.y); break;
    case 3: direction = vec3(p.x, -1.0, -p.y); break;
    case 4: direction = vec3(p.x, -p.y, 1.0); break;
    default: direction = vec3(-p.x, -p.y, -1.0); break;
  }
  color = textureLod(uSource, direction, 0.0);
}`
    : `#version 300 es
precision highp float;
uniform sampler2D uSource;
out vec4 color;
void main() {
  color = texelFetch(uSource, ivec2(gl_FragCoord.xy), 0);
}`;
  const handle = linkProgram(gl, vertex, fragment);
  const program = {
    handle,
    size: gl.getUniformLocation(handle, "uSize"),
    face: gl.getUniformLocation(handle, "uFace"),
  };
  gl.useProgram(handle);
  gl.uniform1i(gl.getUniformLocation(handle, "uSource"), 0);

  return program;
}
