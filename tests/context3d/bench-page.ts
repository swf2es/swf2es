import { WebGLContext3D } from "../../packages/context3d/dist/webgl/index.js";

import type { Options, Result } from "./bench-results.ts";

type Source = [type: number, index: number];

/** AGAL operands use full xyzw masks and swizzles throughout this fixture. */
function shaders(
  indirect: boolean,
  textured: boolean,
  cube: boolean,
  slot: number,
): [Uint8Array, Uint8Array] {
  const make = (fragment: boolean) => {
    const ops: number[][] = [];
    const op = (code: number, dest: Source, a: Source, b?: Source) => {
      ops.push([
        code,
        (dest[0] << 24) | (15 << 16) | dest[1],
        0xe4000000 | a[1],
        a[0],
        b ? 0xe4000000 | b[1] : 0,
        b?.[0] ?? 0,
      ]);
    };
    if (textured && fragment) {
      op(0x28, [3, 0], [1, 0], [5, slot]);
    } else if (indirect) {
      if (fragment) {
        op(0, [3, 0], [4, 0]);
      } else {
        op(0, [3, 0], [0, 0]);
        op(0, [4, 0], [1, 0]);
      }
    } else if (fragment) {
      op(0, [2, 0], [1, 0]);
      for (let i = 1; i < 8; i++) {
        op(1, [2, 0], [2, 0], [1, i]);
      }

      op(0, [3, 0], [2, 0]);
    } else {
      op(0x18, [3, 0], [0, 0], [1, 0]);
    }

    const bytes = new Uint8Array(7 + ops.length * 24);
    const view = new DataView(bytes.buffer);
    bytes[0] = 0xa0;
    view.setUint32(1, 1, true);
    bytes[5] = 0xa1;
    bytes[6] = fragment ? 1 : 0;
    for (let i = 0; i < ops.length; i++) {
      for (let j = 0; j < 6; j++) {
        view.setUint32(7 + i * 24 + j * 4, ops[i][j], true);
      }
    }

    if (indirect && !fragment) {
      // The second mov reads vc[va0.w]; each vertex's w is 1.
      view.setUint32(43, 0x80030001, true);
    }

    if (textured && fragment) {
      view.setUint32(23, slot, true);
      view.setUint32(27, cube ? 0x1005 : 5, true);
    }

    return bytes;
  };

  return [make(false), make(true)];
}

export function bench(name: string, options: Options): Result {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) {
    throw new Error("WebGL2 unavailable");
  }

  const context = new WebGLContext3D(gl);
  context.configure(512, 384, false, options.samples);
  context.setDepth(false, "always");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const out: Result = {
    name,
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    cpu: [],
    completed: [],
    pixels: [],
    calls: {},
  };
  const vertex = new Float32Array(options.draws * 12);
  const index = new Uint16Array(options.draws * 3);
  const rows = Math.ceil(options.draws / 64);
  for (let i = 0; i < options.draws; i++) {
    const x = -0.98 + (i % 64) * (1.96 / 64);
    const y = -0.98 + Math.floor(i / 64) * (1.96 / rows);
    vertex.set([x, y, 0.5, 1, x + 0.018, y, 0.5, 1, x, y + 0.018, 0.5, 1], i * 12);
    index.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  }

  const vertices = context.createBuffer(index.length, 4);
  vertices.upload(vertex, 0, index.length);
  const indices = context.createBuffer(index.length, 0);
  indices.upload(index, 0, index.length);
  context.setVertex(0, vertices, 0, "float4");
  const indirect = name.startsWith("indirect");
  const textured = name.startsWith("textures");
  const cube = name.includes("-cube");
  const slot = name.endsWith("-zero") ? 0 : 3;
  const source = shaders(indirect, textured, cube, slot);
  const textures = textured
    ? [context.createTexture(4, 4, cube), context.createTexture(4, 4, cube)]
    : [];
  const uploadedPixels = new Uint32Array(16).fill(0xff00ff00);
  for (let i = 0; i < textures.length; i++) {
    for (let face = 0; face < (cube ? 6 : 1); face++) {
      for (let level = 0; level < (cube ? textures[i].levels : 1); level++) {
        textures[i].upload(
          new Uint32Array((4 >> level) ** 2).fill(i === 0 ? 0xff00ff00 : 0xffff0000),
          level,
          face,
        );
      }
    }
  }
  if (textured) {
    context.setTexture(slot, textures[0]);
  }
  const programs = Array.from(
    { length: name === "programs" ? 8 : name === "attributes" ? 2 : 1 },
    (_, i) => {
      const program = context.createProgram();
      const vertex = source[0].slice();
      if (name === "attributes" && i === 1) {
        new DataView(vertex.buffer).setUint32(15, 0xe4000001, true);
      }
      program.upload(vertex, source[1]);
      return program;
    },
  );
  if (name === "attributes") {
    context.setVertex(1, vertices, 0, "float4");
  }
  const alternate = name === "bindings" ? context.createBuffer(index.length, 8) : null;
  if (alternate) {
    const data = new Float32Array(vertex.length * 2);
    for (let i = 0; i < index.length; i++) {
      data.set(vertex.subarray(i * 4, i * 4 + 4), i * 8 + 4);
    }
    alternate.upload(data, 0, index.length);
  }
  context.setProgram(programs[0]);
  const target = name === "targets" ? context.createTexture(512, 512) : null;
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const material = new Float32Array(32);
  for (let i = 0; i < 8; i++) {
    material.set([0.025, 0.05, 0.1, 0.125], i * 4);
  }

  context.setConstants("vertex", 0, matrix, 4);
  context.setConstants("fragment", 0, material, 8);
  if (indirect) {
    context.setConstants("vertex", 1, material, 1);
  }

  const render = (frame: number) => {
    if (target) {
      context.setRenderTarget(target, false, 0, options.samples);
      context.clear(0, 0, 0, 1);
      context.setRenderTarget(null);
    }

    context.clear(0, 0, 0, 1);
    for (let i = 0; i < options.draws; i++) {
      if (name === "transform" || name === "material" || name === "all-changing") {
        matrix[3] = ((frame + i) % 16) / 1024;
        if (name === "all-changing") {
          for (let j = 0; j < 4; j++) {
            matrix[j * 5] = 1 + ((frame + i) % 16) / 1024;
          }
        }

        context.setConstants("vertex", 0, matrix, 4);
      }

      if (name === "material" || name === "all-changing") {
        for (let j = 0; j < material.length; j++) {
          material[j] = 0.01 + ((frame + i + j) % 64) / 1024;
        }

        context.setConstants("fragment", 0, material, 8);
      }

      if (name === "indirect-changing") {
        material[0] = 0.01 + ((frame + i) % 64) / 1024;
        context.setConstants("vertex", 1, material, 1);
      }

      if (name === "programs" || name === "attributes") {
        context.setProgram(programs[i % programs.length]);
      }
      if (alternate) {
        context.setVertex(0, i % 2 === 0 ? vertices : alternate, i % 2 === 0 ? 0 : 4, "float4");
      }

      if (name === "textures-changing" || name === "textures-cube-changing") {
        context.setTexture(slot, textures[i % textures.length]);
      }

      if (name.startsWith("textures-uploading")) {
        uploadedPixels.fill(i % 2 === 0 ? 0xff00ff00 : 0xffff0000);
        textures[0].upload(uploadedPixels);
      }

      if (target && i % 64 === 0) {
        context.setRenderTarget(i % 128 === 0 ? target : null, false, 0, options.samples);
      }

      context.draw(indices, i * 3, 1);
    }

    context.present();
  };
  const pixel = new Uint8Array(4);
  const finish = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const check = () => {
    const error = gl.getError();
    if (error || gl.isContextLost()) {
      throw new Error(`GL error ${error}, context lost ${gl.isContextLost()}`);
    }
  };
  try {
    for (let frame = -20; frame < options.frames; frame++) {
      const start = performance.now();
      render(frame + 20);
      const drawn = performance.now();
      finish();
      const completed = performance.now();
      check();
      if (frame >= 0) {
        out.cpu.push(drawn - start);
        out.completed.push(completed - start);
      }

      if (frame === 0 || frame === options.frames - 1) {
        const pixels = context.read();
        let hash = 2166136261;
        for (const byte of pixels) {
          hash = Math.imul(hash ^ byte, 16777619);
        }

        out.pixels.push(hash >>> 0);
      }
    }

    // Count a separate warm frame so wrappers do not distort the timed loop.
    const methods = [
      "uniform4fv",
      "uniform1i",
      "uniform1f",
      "useProgram",
      "activeTexture",
      "bindTexture",
      "bindSampler",
      "bindBuffer",
      "bindVertexArray",
      "vertexAttribPointer",
      "enableVertexAttribArray",
      "disableVertexAttribArray",
      "bindFramebuffer",
      "viewport",
      "drawElements",
    ] as const;
    const raw = gl as unknown as Record<string, (...args: never[]) => unknown>;
    const saved = methods.map((name) => raw[name]);
    try {
      for (const name of methods) {
        const original = raw[name];
        raw[name] = (...args) => {
          out.calls[name] = (out.calls[name] ?? 0) + 1;
          return original.apply(gl, args);
        };
      }

      render(options.frames + 20);
      finish();
      check();
    } finally {
      methods.forEach((name, i) => {
        raw[name] = saved[i];
      });
    }

    return out;
  } finally {
    context.dispose();
    if (!gl.isContextLost()) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}
