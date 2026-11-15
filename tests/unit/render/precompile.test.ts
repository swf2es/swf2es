// How @swf2es/render's ProgramQueue makes programs ahead of their first use (webgl/precompile.ts):
// after the first frame, all at once where the driver compiles in parallel, asked after only once
// complete; one a frame without; each drawn with once, a frame apart; and at once where a frame
// needs one first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GlState } from "../../../packages/context3d/dist/device/index.js";
import { ProgramQueue } from "../../../packages/render/dist/webgl/precompile.js";

/** The context the queue takes, whose DOM type the unit tests do not load. */
type Gl = ConstructorParameters<typeof ProgramQueue>[0];

const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * A WebGL 2 context of what the queue calls, logging the calls that matter: programs linked,
 * their status asked (and whether it had to wait for the link), and draws. A program's link
 * completes `delay` asks of its completion after it was linked; a fragment shader of "bad" fails.
 */
function fakeGl(parallel: boolean, delay = 1) {
  const log: string[] = [];
  let next = 0;
  const programs = new Map<object, { name: string; asks: number; shaders: string[] }>();
  const shaders = new Map<object, string>();
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
    createShader: () => ({ shader: next++ }),
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
      return known.name !== "bad";
    },
    getShaderParameter: (shader: object) => shaders.get(shader) !== "bad",
    getShaderInfoLog: () => "refused",
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
  return { gl: gl as unknown as Gl, log };
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
