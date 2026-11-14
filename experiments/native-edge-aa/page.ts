import {
  Commands,
  Filters,
  Geometries,
  Keeps,
  plan,
  Rows,
  SceneList,
  Textures,
} from "@swf2es/render";
import { WebGLBackend } from "@swf2es/render/webgl";
import { GeometryBuilder } from "./geometry.ts";
import { CoveragePreview } from "./preview.ts";
import { enableCoverage } from "./shader.ts";
import { fixture, rectangle } from "./shapes.ts";
import { validateKernel } from "./validation.ts";

const binary = await (await fetch("./fringe.wasm")).arrayBuffer();
interface Mode {
  name: string;
  samples: number;
  coverage: boolean;
  shader: boolean;
}
const modes: Mode[] = [
  { name: "main-8", samples: 8, coverage: false, shader: false },
  { name: "main-4", samples: 4, coverage: false, shader: false },
  { name: "shader-only-8", samples: 8, coverage: false, shader: true },
  { name: "coverage-4", samples: 4, coverage: true, shader: true },
  { name: "coverage-1", samples: 1, coverage: true, shader: true },
];

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const stats = (a: number[]) => {
  a.sort((x, y) => x - y);
  return {
    median: a[Math.floor(a.length / 2)],
    p95: a[Math.floor(a.length * 0.95)],
    mean: a.reduce((x, y) => x + y, 0) / a.length,
  };
};

class Trial {
  readonly canvas = document.createElement("canvas");
  readonly gl: WebGL2RenderingContext;
  readonly backend: WebGLBackend;
  readonly geometries = new Geometries();
  readonly scene = new SceneList();
  readonly rows = new Rows();
  readonly textures = new Textures();
  readonly filters = new Filters();
  readonly keeps = new Keeps();
  readonly commands = new Commands();
  readonly builder: GeometryBuilder;
  readonly ids: number[] = [];
  readonly shapes: number[][];
  readonly target = { width: 1600, height: 1000, scale: 1, x: 0, y: 0, resolution: 1, pixel: 1 };
  readonly mode: Mode;
  readonly capture: boolean;
  readonly undoShader: () => void;

  constructor(
    mode: Mode,
    instance: WebAssembly.Instance | undefined,
    capture: boolean,
    count: number,
    diagonal = false,
  ) {
    this.mode = mode;
    this.capture = capture;
    if (capture) {
      this.target.width = 512;
      this.target.height = 320;
    }
    this.canvas.width = this.target.width;
    this.canvas.height = this.target.height;
    document.body.append(this.canvas);
    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      alpha: true,
      preserveDrawingBuffer: capture,
    });
    if (!gl) {
      throw new Error("WebGL2 unavailable");
    }
    this.gl = gl;
    this.undoShader = mode.shader ? enableCoverage(this.gl) : () => {};
    this.backend = new WebGLBackend(this.gl);
    this.backend.samples = mode.samples;
    this.builder = new GeometryBuilder(instance);
    this.shapes = capture
      ? fixture(diagonal)
      : Array.from({ length: count }, (_, i) => rectangle(32 + (i % 5), 2 + (i % 6)));
    for (const shape of this.shapes) {
      this.ids.push(
        this.geometries.add(
          this.builder.make(shape, mode.coverage, 1, capture ? 0xff000000 : 0xff202020),
        ).id,
      );
    }
  }

  draw(frame: number, scenario = "static"): void {
    this.scene.reset();
    this.rows.reset();
    const scale = scenario === "scale" ? 1 + 0.13 * Math.sin(frame * 0.071) : 1;
    const angle = scenario === "static" ? 0.031 : frame * 0.013;
    for (let i = 0; i < this.ids.length; i++) {
      // The baseline retains its geometry under transforms. The prototype
      // pays for keeping its precomputed band one framebuffer pixel wide.
      if (scenario === "scale" && this.mode.coverage) {
        const data = this.builder.make(this.shapes[i], this.mode.coverage, 1 / scale);
        this.geometries.remove(this.ids[i]);
        this.ids[i] = this.geometries.add(data).id;
      }
      const a = this.capture ? 0 : angle + (i % 7) * 0.035;
      const row = this.capture
        ? this.rows.add(1, 0, 0, 1, 0, 0, null)
        : this.rows.add(
            Math.cos(a) * scale,
            Math.sin(a) * scale,
            -Math.sin(a) * scale,
            Math.cos(a) * scale,
            26 + (i % 32) * 49,
            24 + Math.floor(i / 32) * 38,
            null,
          );
      this.scene.draw(this.ids[i], row, 0, -1, 0);
    }
    plan(this.scene, 0xffffffff, this.commands);
    this.backend.execute(
      this.commands,
      this.scene,
      this.rows,
      this.geometries,
      this.textures,
      this.filters,
      this.keeps,
      this.target,
    );
  }

  dispose(): void {
    this.backend.destroy();
    this.undoShader();
    this.builder.dispose();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}

const captureAa = async (diagonal = false) => {
  const captures = [];
  for (const mode of modes) {
    const instance = mode.coverage ? (await WebAssembly.instantiate(binary)).instance : undefined;
    const t = new Trial(mode, instance, true, 0, diagonal);
    for (let i = 0; i < 5; i++) {
      t.draw(i);
      await pause();
    }
    captures.push({
      mode: mode.name,
      png: t.canvas.toDataURL(),
      refused: t.builder.refused,
      error: t.gl.getError(),
    });
    t.dispose();
  }
  return captures;
};

const benchAa = async (name: string, scenario: string, frames = 90, count = 640) => {
  const mode = modes.find((m) => m.name === name);
  if (!mode) {
    throw new Error(`Unknown mode ${name}`);
  }
  const instance = mode.coverage ? (await WebAssembly.instantiate(binary)).instance : undefined;
  const start = performance.now();
  const t = new Trial(mode, instance, false, count);
  const setupMs = performance.now() - start;
  const gl = t.gl;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  for (let i = 0; i < 20; i++) {
    t.draw(i, scenario);
    gl.finish();
  }
  const cpu: number[] = [];
  const queries: WebGLQuery[] = [];
  const gpu: number[] = [];
  const ownedStart = t.builder.bytes;
  for (let i = 0; i < frames; i++) {
    const q = ext ? gl.createQuery() : null;
    if (q) {
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    }
    const now = performance.now();
    t.draw(i + 20, scenario);
    cpu.push(performance.now() - now);
    if (q) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    gl.finish();
  }
  await pause();
  for (const q of queries) {
    for (let k = 0; k < 100 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) {
      await pause();
    }
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    }
    gl.deleteQuery(q);
  }
  const result = {
    name,
    scenario,
    frames,
    count,
    setupMs,
    cpu: stats(cpu),
    gpu: gpu.length ? stats(gpu) : null,
    gpuDisjoint: ext ? gl.getParameter(ext.GPU_DISJOINT_EXT) : null,
    requestedSamples: mode.samples,
    actualSamples:
      (t.backend as unknown as { stage: { stageMsaa: { samples: number } | null } }).stage.stageMsaa
        ?.samples ?? 1,
    outputBytesPerFrame: (t.builder.bytes - ownedStart) / frames,
    retainedWasmBytes: t.builder.retainedWasmBytes,
    geometryBytes: t.shapes.reduce((n, _, i) => {
      const g = t.geometries.get(t.ids[i]);
      if (!g) {
        throw new Error("Missing geometry");
      }
      return (
        n +
        g.positions.byteLength +
        g.colors.byteLength +
        g.indices.byteLength +
        (g.texels?.byteLength ?? 0)
      );
    }, 0),
    refused: t.builder.refused,
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown",
    error: gl.getError(),
  };
  t.dispose();
  return result;
};

const validateAa = async () => validateKernel((await WebAssembly.instantiate(binary)).instance);

const validatePreviewAa = async () => {
  const mode = modes.find((m) => m.name === "shader-only-8");
  if (!mode) {
    throw new Error("Missing control mode");
  }
  const t = new Trial(mode, undefined, true, 0);
  const preview = new CoveragePreview(t.backend, (await WebAssembly.instantiate(binary)).instance);
  const pixels = () => {
    const p = new Uint8Array(t.canvas.width * t.canvas.height * 4);
    const previous = t.gl.getParameter(t.gl.READ_FRAMEBUFFER_BINDING);
    t.gl.bindFramebuffer(t.gl.READ_FRAMEBUFFER, null);
    t.gl.readPixels(0, 0, t.canvas.width, t.canvas.height, t.gl.RGBA, t.gl.UNSIGNED_BYTE, p);
    t.gl.bindFramebuffer(t.gl.READ_FRAMEBUFFER, previous);
    return p;
  };
  const assert = (ok: boolean, message: string) => {
    if (!ok) {
      throw new Error(message);
    }
  };
  try {
    t.draw(0);
    const before = pixels();
    preview.enabled = true;
    for (let i = 0; i < 5; i++) {
      t.draw(i);
    }
    assert(preview.counts.applied > 0, "No preview draws affected");
    const affected = preview.counts.applied;
    assert(
      t.ids.every((id, i) => t.scene.geometry[i] === id),
      "Scene IDs not restored",
    );
    const count = t.geometries.count;
    for (let i = 0; i < 120; i++) {
      t.draw(i);
    }
    assert(t.geometries.count === count, "Preview geometry grows on stable frames");
    const applied = pixels();
    assert(
      applied.some((v, i) => v !== before[i]),
      "Coverage did not affect any pixel",
    );
    preview.enabled = false;
    t.draw(0);
    const after = pixels();
    assert(
      after.every((v, i) => v === before[i]),
      "Off does not restore the original pixels",
    );
    assert(t.geometries.count === t.ids.length, "Off retains candidate geometries");
    preview.enabled = true;
    t.draw(0);
    const expected = pixels();
    const lose = t.gl.getExtension("WEBGL_lose_context");
    if (!lose) {
      throw new Error("Missing context-loss test extension");
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Context-loss event timed out")), 5000);
      t.canvas.addEventListener(
        "webglcontextlost",
        (event) => {
          event.preventDefault();
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      lose.loseContext();
    });
    // Restoration requested in the loss event's microtask can be refused.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Context-restoration event timed out")),
        5000,
      );
      t.canvas.addEventListener(
        "webglcontextrestored",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      lose.restoreContext();
    });
    t.backend.restore(t.geometries);
    t.draw(0);
    assert(
      pixels().every((v, i) => v === expected[i]),
      "Coverage lost after context restoration",
    );
    return {
      affected,
      stableFrames: 120,
      offRestoresPixels: true,
      sceneRestored: true,
      contextRestored: true,
      error: t.gl.getError(),
    };
  } finally {
    t.dispose();
  }
};

// Adjacent A/B frames reduce the effect of changing GPU clock rates. Both
// contexts remain alive and have their programs and atlases warm.
const pairedAa = async (candidate: string, scenario: string, round: number) => {
  const trials: Trial[] = [];
  for (const name of ["main-8", candidate]) {
    const mode = modes.find((m) => m.name === name);
    if (!mode) {
      throw new Error(`Unknown mode ${name}`);
    }
    const instance = mode.coverage ? (await WebAssembly.instantiate(binary)).instance : undefined;
    trials.push(new Trial(mode, instance, false, 640));
  }
  const states = trials.map((t) => ({
    t,
    ext: t.gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    cpu: [] as number[],
    gpu: [] as number[],
    queries: [] as WebGLQuery[],
    bytes: 0,
  }));
  try {
    for (let i = 0; i < 100; i++) {
      for (const t of trials) {
        t.draw(i, scenario);
        t.gl.finish();
      }
    }
    for (const state of states) {
      state.bytes = state.t.builder.bytes;
    }
    const frames = 120;
    for (let i = 0; i < frames; i++) {
      for (let j = 0; j < 2; j++) {
        const s = states[(i + round + j) % 2];
        const { gl } = s.t;
        const q = s.ext ? gl.createQuery() : null;
        if (q) {
          gl.beginQuery(s.ext.TIME_ELAPSED_EXT, q);
        }
        const start = performance.now();
        s.t.draw(i + 100, scenario);
        s.cpu.push(performance.now() - start);
        if (q) {
          gl.endQuery(s.ext.TIME_ELAPSED_EXT);
          s.queries.push(q);
        }
        gl.finish();
      }
    }
    await pause();
    const result = [];
    for (const s of states) {
      const { gl } = s.t;
      for (const q of s.queries) {
        for (let k = 0; k < 100 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) {
          await pause();
        }
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          throw new Error("GPU query timed out");
        }
        s.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
      }
      const error = gl.getError();
      const disjoint = s.ext ? gl.getParameter(s.ext.GPU_DISJOINT_EXT) : null;
      if (error || disjoint) {
        throw new Error(`Invalid timing: GL ${error}, disjoint ${disjoint}`);
      }
      result.push({
        name: s.t.mode.name,
        scenario,
        round,
        cpu: stats(s.cpu),
        gpu: s.gpu.length ? stats(s.gpu) : null,
        outputBytesPerFrame: (s.t.builder.bytes - s.bytes) / frames,
        retainedWasmBytes: s.t.builder.retainedWasmBytes,
        error,
        disjoint,
      });
    }
    return result;
  } finally {
    for (const t of trials) {
      t.dispose();
    }
  }
};
Object.assign(globalThis, { captureAa, benchAa, validateAa, pairedAa, validatePreviewAa });
