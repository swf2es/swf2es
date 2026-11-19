// How @swf2es/render's ProgramQueue makes programs ahead of their first use (webgl/precompile.ts):
// after the first frame, all at once where the driver compiles in parallel, asked after only once
// complete; one a frame without; each drawn with once, a frame apart; and at once where a frame
// needs one first. And which failed links, the queue's and the kernels', are a lost context's
// (webgl/losses.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GlState,
  linkProgram,
  lostShader,
  ShaderError,
} from "../../../packages/context3d/dist/device/index.js";
import { KernelPrograms } from "../../../packages/render/dist/webgl/kernels.js";
import { LinkLosses, LOSS_GRACE_MS } from "../../../packages/render/dist/webgl/losses.js";
import { ProgramQueue } from "../../../packages/render/dist/webgl/precompile.js";

/** The context the queue takes, whose DOM type the unit tests do not load. */
type Gl = ConstructorParameters<typeof ProgramQueue>[0];

const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * A WebGL 2 context of what the queue calls, logging the calls that matter: programs linked,
 * their status asked (and whether it had to wait for the link), and draws. A program's link
 * completes `delay` asks of its completion after it was linked; a fragment shader of "bad" fails.
 * A `dead` one answers as a GPU process that died before the context is flagged lost: every
 * status false, every log empty.
 */
function fakeGl(parallel: boolean, delay = 1) {
  const log: string[] = [];
  let next = 0;
  const programs = new Map<object, { name: string; asks: number; shaders: string[] }>();
  const shaders = new Map<object, string>();
  const context = { lost: false, dead: false, refuse: -1 };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    LINK_STATUS: 3,
    COMPILE_STATUS: 4,
    TEXTURE_2D: 5,
    FRAMEBUFFER: 6,
    COLOR_ATTACHMENT0: 7,
    TRIANGLES: 8,
    RGBA8: 9,
    TEXTURE_MIN_FILTER: 10,
    TEXTURE_MAG_FILTER: 11,
    NEAREST: 12,
    TEXTURE0: 100,
    getExtension: (name: string) =>
      parallel && name === "KHR_parallel_shader_compile" ? { COMPLETION_STATUS_KHR } : null,
    isContextLost: () => context.lost,
    // A lost context, or the `refuse`th shader asked for, gets none.
    createShader: () => (context.lost || context.refuse-- === 0 ? null : { shader: next++ }),
    createProgram: () => ({ program: next++ }),
    shaderSource: (shader: object, source: string) => shaders.set(shader, source),
    compileShader: () => {},
    attachShader: (program: object, shader: object) => {
      const known = programs.get(program) ?? { name: "", asks: 0, shaders: [] };
      known.shaders.push(shaders.get(shader) as string);
      known.name = known.shaders.at(-1) as string;
      programs.set(program, known);
    },
    linkProgram: (program: object) => log.push(`link ${programs.get(program)?.name}`),
    getProgramParameter: (program: object, what: number) => {
      const known = programs.get(program);
      if (!known) {
        return false;
      }

      if (what === COMPLETION_STATUS_KHR) {
        return ++known.asks > delay;
      }

      log.push(`status ${known.name}${known.asks > delay || !parallel ? "" : " (waits)"}`);
      return !context.dead && known.name !== "bad";
    },
    getShaderParameter: (shader: object) => !context.dead && shaders.get(shader) !== "bad",
    getShaderInfoLog: () => (context.dead ? "" : "refused"),
    getProgramInfoLog: () => "",
    detachShader: () => {},
    deleteShader: () => {},
    deleteProgram: (program: object | null) => {
      if (program) {
        log.push(`delete ${programs.get(program)?.name}`);
      }
    },
    useProgram: () => {},
    createTexture: () => ({ texture: next++ }),
    createFramebuffer: () => ({ framebuffer: next++ }),
    framebufferTexture2D: () => {},
    texStorage2D: () => {},
    texParameteri: () => {},
    activeTexture: () => {},
    bindTexture: () => {},
    bindSampler: () => {},
    bindFramebuffer: () => {},
    bindVertexArray: () => {},
    viewport: () => {},
    colorMask: () => {},
    disable: () => {},
    deleteTexture: () => {},
    deleteFramebuffer: () => {},
    drawArrays: () => log.push("draw"),
  };
  return { gl: gl as unknown as Gl, log, context };
}

/** A queue of programs "a", "b" and "c", what each was told it was made as, in order. */
function queued(gl: Gl, names = ["a", "b", "c"]) {
  const queue = new ProgramQueue(gl, new GlState(gl));
  const made: string[] = [];
  for (const name of names) {
    queue.add(name, "vertex", name, [4], () => made.push(name));
  }

  return { queue, made };
}

test("with parallel compiles, every program is begun after the first frame and finished once complete", () => {
  const { gl, log } = fakeGl(true);
  const { queue, made } = queued(gl);
  // The first frame is shown before anything is made.
  queue.step();
  assert.deepEqual(log, []);
  // Begun at once; none is complete yet, and none is waited for.
  queue.step();
  assert.deepEqual(log, ["link a", "link b", "link c"]);
  assert.deepEqual(made, []);
  log.length = 0;
  // Complete: finished without waiting, and the first drawn with.
  queue.step();
  assert.deepEqual(made, ["a", "b", "c"]);
  assert.deepEqual(log, ["status a", "status b", "status c", "draw"]);
  log.length = 0;
  // The others drawn with a frame apart, and then nothing.
  queue.step();
  queue.step();
  queue.step();
  assert.deepEqual(log, ["draw", "draw"]);
  assert.equal(queue.busy, false);
});

test("without parallel compiles, one program is linked a frame, each drawn with a frame after", () => {
  const { gl, log } = fakeGl(false);
  const { queue, made } = queued(gl);
  queue.step();
  queue.step();
  assert.deepEqual(log, ["link a", "status a", "draw"]);
  queue.step();
  queue.step();
  assert.deepEqual(made, ["a", "b", "c"]);
  queue.step();
  assert.deepEqual(log, [
    "link a",
    "status a",
    "draw",
    "link b",
    "status b",
    "draw",
    "link c",
    "status c",
    "draw",
  ]);
  assert.equal(queue.busy, false);
});

test("a program needed first is finished at once, waiting for its link, and not drawn with ahead", () => {
  const { gl, log } = fakeGl(true, 5);
  const { queue, made } = queued(gl);
  queue.step();
  queue.step();
  log.length = 0;
  assert.equal(queue.take("b"), true);
  assert.deepEqual(made, ["b"]);
  assert.deepEqual(log, ["status b (waits)"]);
  // Made once: asked again, it is no job of the queue's.
  assert.equal(queue.take("b"), false);
  // One never begun, as before the second frame, is linked then.
  const { gl: other, log: otherLog } = fakeGl(true);
  const fresh = queued(other);
  assert.equal(fresh.queue.take("c"), true);
  assert.deepEqual(otherLog, ["link c", "status c (waits)"]);
  assert.deepEqual(fresh.made, ["c"]);
});

test("a program that does not link is left to its owner, which links it to say why", () => {
  const { gl } = fakeGl(false);
  const { queue, made } = queued(gl, ["bad", "a"]);
  queue.step();
  queue.step();
  queue.step();
  assert.deepEqual(made, ["a"]);
  assert.equal(queue.take("bad"), false);
});

test("destroyed, the programs begun and not finished are deleted", () => {
  const { gl, log } = fakeGl(true, 5);
  const { queue } = queued(gl);
  queue.step();
  queue.step();
  queue.destroy();
  assert.deepEqual(log.slice(3), ["delete a", "delete b", "delete c"]);
  assert.equal(queue.busy, false);
});

test("a context lost mid-frame begins nothing and does not throw", () => {
  const { gl, log, context } = fakeGl(true);
  const { queue, made } = queued(gl);
  queue.step();
  context.lost = true;
  queue.step();
  assert.deepEqual(log, []);
  assert.deepEqual(made, []);
  assert.equal(queue.busy, true);
});

test("a program that cannot be begun leaves the ones begun before it begun once", () => {
  const { gl, log, context } = fakeGl(true);
  const { queue, made } = queued(gl);
  queue.step();
  // "b"'s vertex shader, after "a"'s two.
  context.refuse = 2;
  assert.throws(() => queue.step(), /cannot allocate shader/);
  queue.step();
  queue.step();
  assert.deepEqual(
    log.filter((l) => l.startsWith("link")),
    ["link a", "link b", "link c"],
  );
  assert.deepEqual(made, ["a", "b", "c"]);
});

test("a link that fails on a context flagged lost is thrown as lost, not left to its owner", () => {
  const { gl, context } = fakeGl(false);
  const { queue, made } = queued(gl);
  // Not flagged, a failure that says nothing is the owner's to link again, whose own failure
  // the backend weighs (LinkLosses).
  context.dead = true;
  assert.equal(queue.take("a"), false);
  context.dead = false;
  context.lost = true;
  assert.throws(
    () => queue.take("b"),
    (e: unknown) => e instanceof ShaderError && e.lost && lostShader(e),
  );
  assert.deepEqual(made, []);
});

test("a shader that does not compile, with the context there, is not taken for a loss", () => {
  const { gl } = fakeGl(false);
  assert.throws(
    () => linkProgram(gl, "vertex", "bad"),
    (e: unknown) => e instanceof ShaderError && e.stage === "compile" && !e.lost,
  );
});

/** performance.now set to `at` while `run` runs. */
function at<T>(now: { t: number }, run: () => T): T {
  const real = performance.now;
  performance.now = () => now.t;
  try {
    return run();
  } finally {
    performance.now = real;
  }
}

test("a kernel that fails saying nothing is drawn without, kept as failed only once it outlives a loss", () => {
  const { gl, log, context } = fakeGl(false);
  const losses = new LinkLosses(gl);
  const kernels = new KernelPrograms(gl, new GlState(gl), losses);
  const now = { t: 1000 };
  const links = () => log.filter((l) => l.startsWith("link")).length;
  // A frame of each `step` ms, using the kernel `name`.
  const frame = (name: string, step = 100) => {
    now.t += step;
    const kernel = at(now, () => kernels.use("vertex", name, () => {}));
    at(now, () => losses.endFrame());
    return kernel;
  };
  context.dead = true;
  // Taken for a context lost but not flagged yet: drawn without, and linked again each frame.
  for (let i = 0; i < 4; i++) {
    assert.equal(frame("k"), null);
  }

  assert.equal(links(), 4);
  // Still failing, still not flagged, past the grace: the kernel's fault, kept, not linked again.
  assert.equal(frame("k", LOSS_GRACE_MS - 300), null);
  assert.equal(links(), 5);
  assert.equal(frame("k"), null);
  assert.equal(links(), 5);
  // A frame drawn without a failure ended the run: another failure starts one of its own.
  assert.equal(losses.expired, true);
  assert.equal(frame("other"), null);
  assert.equal(links(), 6);
  at(now, () => assert.equal(losses.expired, false));
  // Flagged lost: drawn without, not kept, whatever the clock.
  context.dead = false;
  context.lost = true;
  assert.equal(frame("flagged", LOSS_GRACE_MS * 4), null);
  context.lost = false;
  assert.notEqual(frame("flagged"), null);
});

test("a failure a grace after the last starts a run of its own; one conceded throws till a clean frame", () => {
  const { gl, context } = fakeGl(false);
  const losses = new LinkLosses(gl);
  const now = { t: 1000 };
  context.dead = true;
  const failure = () => {
    try {
      linkProgram(gl, "vertex", "k");
    } catch (e) {
      return e;
    }

    throw new Error("linked");
  };
  // Work given up on, as a BitmapData draw, and no frame drawn after.
  at(now, () => assert.equal(losses.lost(failure()), true));
  now.t += LOSS_GRACE_MS * 10;
  // Long after, the GPU process dies: a loss again, not the fault of the run before.
  at(now, () => assert.equal(losses.lost(failure()), true));
  now.t += LOSS_GRACE_MS;
  at(now, () => assert.equal(losses.expired, true));
  // Its grace over unflagged, conceded: what fails is the shaders', till a frame draws clean.
  losses.concede();
  now.t += LOSS_GRACE_MS * 10;
  at(now, () => assert.equal(losses.lost(failure()), false));
  at(now, () => losses.endFrame());
  at(now, () => assert.equal(losses.lost(failure()), false));
  at(now, () => losses.endFrame());
  at(now, () => losses.endFrame());
  at(now, () => assert.equal(losses.lost(failure()), true));
});
