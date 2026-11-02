import { GlState } from "../../../packages/context3d/dist/device/index.js";
import { Container } from "../../../packages/player/dist/display/container.js";
import { TRANSFORM } from "../../../packages/player/dist/display/displayobject.js";
import { Drawing } from "../../../packages/player/dist/display/drawing.js";
import { filterDefaults } from "../../../packages/player/dist/display/filters.js";
import { ShapeObject } from "../../../packages/player/dist/display/shapeobject.js";
import { RenderView } from "../../../packages/player/dist/scene/view.js";
import { TargetPool } from "../../../packages/render/dist/webgl/targets.js";
import type { Options, Result } from "./results.ts";

function result(gl: WebGL2RenderingContext, name: string, samples: number): Result {
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    name,
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    samples,
    cpu: [],
    walk: [],
    completed: [],
    pixels: [],
    allocations: 0,
    checks: 0,
  };
}

function check(gl: WebGL2RenderingContext): void {
  const error = gl.getError();
  if (error !== gl.NO_ERROR || gl.isContextLost()) {
    throw new Error(`WebGL failed: ${error}, lost=${gl.isContextLost()}`);
  }
}

function hash(gl: WebGL2RenderingContext, width: number, height: number): number {
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let h = 2166136261;
  for (let i = 0; i < pixels.length; i++) {
    h = Math.imul(h ^ pixels[i], 16777619);
  }

  return h >>> 0;
}

/** Shared geometry, many display objects: isolate traversal from tessellation. */
export function scene(name: string, options: Options): Result {
  const view = new RenderView({
    width: 512,
    height: 384,
    samples: options.samples,
    preserveDrawingBuffer: true,
  });
  const gl = view.gl;
  const out = result(gl, name, options.samples);
  const root = new Container();
  const branches: Container[] = [];
  const drawing = new Drawing();
  drawing.beginFill({ type: "solid", color: 0xff30a0e0 });
  drawing.drawRect(0, 0, 3, 3);
  drawing.endFill();
  for (let i = 0; i < options.branches; i++) {
    const branch = new Container();
    branch.matrix.tx = (i % 8) * 60;
    branch.matrix.ty = (Math.floor(i / 8) % 6) * 60;
    branch.visible = name !== "hidden" || i % 4 === 0;
    if (name === "filtered") {
      branch.filters = [{ ...filterDefaults("blur"), blurX: 4, blurY: 4, quality: 1 }];
    }

    for (let j = 0; j < 64; j++) {
      const shape = new ShapeObject(null);
      shape.drawing = drawing;
      shape.matrix.tx = (j % 8) * 6;
      shape.matrix.ty = Math.floor(j / 8) * 6;
      branch.addChildAt(shape, j);
    }

    root.addChildAt(branch, i);
    branches.push(branch);
  }

  // One probe per frame, outside the recursive walk: do not time every object.
  const internals = view as unknown as { walkFrom(o: Container): void };
  const walk = internals.walkFrom.bind(view);
  let walkMs = 0;
  internals.walkFrom = (o) => {
    const start = performance.now();
    walk(o);
    walkMs = performance.now() - start;
  };
  try {
    for (let f = -30; f < options.frames; f++) {
      if (name !== "visible") {
        for (let i = 0; i < branches.length; i++) {
          branches[i].matrix.tx = (i % 8) * 60 + ((f + 30) % 8);
          branches[i].invalidate(TRANSFORM);
        }
      }

      const start = performance.now();
      view.render(root);
      const cpu = performance.now() - start;
      gl.finish();
      const completed = performance.now() - start;
      if (f >= 0) {
        out.cpu.push(cpu);
        out.walk.push(walkMs);
        out.completed.push(completed);
      }

      if (f === 0 || f === options.frames - 1) {
        out.pixels.push(hash(gl, 512, 384));
      }
    }

    check(gl);
    return out;
  } finally {
    view.destroy();
  }
}

/** Varying filter rectangles under the normal pool budget, without scene traversal. */
export function targets(options: Options): Result {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) {
    throw new Error("WebGL2 unavailable");
  }

  const supported = gl.getInternalformatParameter(
    gl.RENDERBUFFER,
    gl.RGBA8,
    gl.SAMPLES,
  ) as Int32Array;
  const depthSamples = gl.getInternalformatParameter(
    gl.RENDERBUFFER,
    gl.DEPTH24_STENCIL8,
    gl.SAMPLES,
  ) as Int32Array;
  const samples = Array.from(supported).find(
    (n) => n <= options.samples && n > 1 && depthSamples.includes(n),
  );
  if (!samples) {
    throw new Error("No supported multisample count");
  }

  const out = result(gl, "targets", samples);
  const state = new GlState(gl);
  const pool = new TargetPool(gl, state);
  const allocate = pool.multisampled.bind(pool);
  pool.multisampled = (w, h, s) => {
    out.allocations++;
    return allocate(w, h, s);
  };
  const status = gl.checkFramebufferStatus.bind(gl);
  gl.checkFramebufferStatus = (target) => {
    out.checks++;
    return status(target);
  };
  try {
    for (let f = 0; f < options.frames; f++) {
      const start = performance.now();
      for (let i = 0; i < 18; i++) {
        const width = 128 * (1 + ((f + i * 3) % 8));
        const height = 128 * (2 + ((f * 3 + i) % 5));
        const layer = pool.takeLayer(width, height, true);
        const msaa = pool.layerMsaa(layer, samples);
        if (!msaa) {
          throw new Error("MSAA allocation failed");
        }

        state.bindFramebuffer(msaa.framebuffer);
        gl.clearColor(0.25, 0.5, 0.75, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        pool.resolve({ layer, msaa, x: 0, y: 0, width, height }, width, height);
        if (i === 17 && (f === 0 || f === options.frames - 1)) {
          state.bindFramebuffer(layer.framebuffer);
          out.pixels.push(hash(gl, width, height));
        }

        pool.giveLayer(layer);
      }

      pool.endFrame();
      const cpu = performance.now() - start;
      gl.finish();
      if (f > 0 && f < options.frames - 1) {
        out.cpu.push(cpu);
        out.completed.push(performance.now() - start);
      }
    }

    check(gl);
    return out;
  } finally {
    pool.destroy();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
