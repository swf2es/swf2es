// The transform table's atlas of local vertices and its runs of Graphics:
// what goes where in the buffers, and which builds share a draw call.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  Atlas,
  type AtlasStore,
  addToRun,
  type Packed,
  setTransformTable,
  type TableInstruction,
  TablePipe,
} from "../../../../packages/player/dist/render/table.js";

// Pixi as the player loads it, its ES module.
const cjs = createRequire(new URL("../../../../packages/player/package.json", import.meta.url));
const pixi = pathToFileURL(cjs.resolve("pixi.js").replace(/\.js$/, ".mjs")).href;
const { Graphics, InstructionSet } = (await import(pixi)) as {
  Graphics: new () => object;
  InstructionSet: new () => {
    instructionSize: number;
    instructions: unknown[];
    add(instruction: unknown): void;
    reset(): void;
  };
};
type Run = Parameters<typeof addToRun>;

const WHITE = 1;

/**
 * A store as the GPU's buffers keep the atlas, in arrays to read back, and
 * the calls made to it: each resize's sizes and what it kept, each write's place and length.
 */
function store(): AtlasStore & { vertices: Float32Array; indices: Uint32Array; calls: string[] } {
  const out = {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    calls: [] as string[],
    resize(vertices: number, indices: number, keptVertices: number, keptIndices: number) {
      const v = new Float32Array(vertices * 6);
      v.set(out.vertices.subarray(0, keptVertices * 6));
      const i = new Uint32Array(indices);
      i.set(out.indices.subarray(0, keptIndices));
      out.vertices = v;
      out.indices = i;
      out.calls.push(`resize ${vertices} ${indices} keeping ${keptVertices} ${keptIndices}`);
    },
    writeVertices(at: number, data: Float32Array, floats: number) {
      out.vertices.set(data.subarray(0, floats), at * 6);
      out.calls.push(`vertices ${at} ${floats / 6}`);
    },
    writeIndices(at: number, data: Uint32Array, count: number) {
      out.indices.set(data.subarray(0, count), at);
      out.calls.push(`indices ${at} ${count}`);
    },
  };
  return out;
}

/** A context's render data as Pixi packs it: `vertices` vertices of six floats, and its batches. */
function packed(
  vertices: number,
  indices: number[],
  batches: { start: number; size: number; texture?: number; topology?: string }[],
): Packed {
  const floats = new Float32Array(vertices * 6).map((_, i) => i);
  return {
    batcher: {
      attributeBuffer: { float32View: floats },
      attributeSize: floats.length,
      indexBuffer: Uint16Array.from(indices),
      indexSize: indices.length,
    },
    instructions: {
      instructionSize: batches.length,
      // Pixi's batches, as far as the atlas reads them.
      instructions: batches.map((b) => ({
        renderPipeId: "batch",
        canBundle: true,
        start: b.start,
        size: b.size,
        topology: b.topology ?? "triangle-list",
        textures: { count: 1, textures: [{ uid: b.texture ?? WHITE }] },
      })),
    },
  };
}

test("contexts go into the atlas once, their indices offset by the vertices before them", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  const a = {};
  const b = {};

  const first = atlas.place(a, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  const second = atlas.place(
    b,
    packed(
      4,
      [0, 1, 2, 0, 2, 3],
      [
        { start: 0, size: 3 },
        { start: 3, size: 3 },
      ],
    ),
  );
  assert.deepEqual(first?.counts, [3]);
  assert.deepEqual(first?.offsets, [0]);
  assert.deepEqual(second?.counts, [3, 3]);
  assert.deepEqual(second?.offsets, [3 * 4, 6 * 4]);
  assert.equal(atlas.vertexCount, 7);
  // Staged until sent, then written in one call each.
  assert.deepEqual(gpu.calls, ["resize 4096 12288 keeping 0 0"]);
  atlas.send();
  assert.deepEqual(gpu.calls.slice(1), ["vertices 0 7", "indices 0 9"]);
  assert.deepEqual([...gpu.indices.subarray(0, 9)], [0, 1, 2, 3, 4, 5, 3, 5, 6]);
  assert.equal(gpu.vertices[3 * 6], 0);
  assert.equal(gpu.vertices[3 * 6 + 1], 1);

  // Sent: asked again, a context is where it was, nothing copied.
  assert.equal(atlas.place(a, packed(3, [0, 1, 2], [{ start: 0, size: 3 }])), first);
  atlas.send();
  assert.equal(gpu.calls.length, 3);

  // One more goes after what was sent, for that alone to go up.
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.send();
  assert.deepEqual(gpu.calls.slice(3), ["vertices 7 3", "indices 9 3"]);
  assert.deepEqual([...gpu.indices.subarray(9, 12)], [7, 8, 9]);

  // One past the store's room: what was staged goes first, then the store grows keeping it.
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.place({}, packed(5000, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.deepEqual(gpu.calls.slice(5), [
    "vertices 10 3",
    "indices 12 3",
    "resize 6144 12288 keeping 13 15",
  ]);
  atlas.send();
  assert.deepEqual([...gpu.indices.subarray(12, 18)], [10, 11, 12, 13, 14, 15]);
  assert.equal(gpu.vertices[13 * 6 + 5], 5);
  atlas.destroy();
});

test("a context larger than the stage goes straight in, after what was staged", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.place({}, packed(70000, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.deepEqual(gpu.calls, [
    "resize 4096 12288 keeping 0 0",
    "vertices 0 3",
    "indices 0 3",
    "resize 70003 12288 keeping 3 3",
    "vertices 3 70000",
    "indices 3 3",
  ]);
  assert.deepEqual([...gpu.indices.subarray(0, 6)], [0, 1, 2, 3, 4, 5]);
  atlas.send();
  assert.equal(gpu.calls.length, 6);
  atlas.destroy();
});

test("a context with a texture or another topology is not the table's", () => {
  const atlas = new Atlas(WHITE, store());

  assert.equal(atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3, texture: 7 }])), null);
  assert.equal(
    atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3, topology: "line-list" }])),
    null,
  );
  assert.equal(atlas.vertexCount, 0);
  atlas.destroy();
});

test("the atlas starts again only once released contexts leave more holes than live vertices", () => {
  const atlas = new Atlas(WHITE, store());
  const big = 40000;
  const indices = [0, 1, 2];
  const keys = [{}, {}, {}];
  for (const key of keys) {
    atlas.place(key, packed(big, indices, [{ start: 0, size: 3 }]));
  }

  // One gone: a hole smaller than what is live stays.
  atlas.release(keys[0]);
  atlas.compact();
  assert.equal(atlas.vertexCount, 3 * big);

  // Two gone: the holes pass the live vertices; the one left is copied in again when next drawn.
  atlas.release(keys[1]);
  atlas.compact();
  assert.equal(atlas.vertexCount, 0);
  const again = atlas.place(keys[2], packed(big, indices, [{ start: 0, size: 3 }]));
  assert.deepEqual(again?.offsets, [0]);
  assert.equal(atlas.vertexCount, big);
  atlas.destroy();
});

test("the atlas starts again in a store cut down to what was live, and grows by half", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  const keys = Array.from({ length: 8 }, () => ({}));
  const big = 40000;
  for (const key of keys) {
    atlas.place(key, packed(big, [0, 1, 2], [{ start: 0, size: 3 }]));
  }

  const peak = atlas.capacity;
  assert.ok(peak >= 8 * big && peak < 8 * big * 1.5 + big);
  for (const key of keys.slice(1)) {
    atlas.release(key);
  }

  atlas.compact();
  assert.equal(atlas.vertexCount, 0);
  assert.equal(atlas.capacity, big * 1.5);
  assert.equal(atlas.indexCapacity, 4096 * 3);

  // Placed again, the one left fits, in a store made again at that size; more grows by half.
  gpu.calls.length = 0;
  atlas.place(keys[0], packed(big, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.equal(atlas.capacity, big * 1.5);
  assert.deepEqual(gpu.calls, [`resize ${big * 1.5} 12288 keeping 0 0`]);
  atlas.place({}, packed(big, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.equal(atlas.capacity, big * 1.5 * 1.5);
  atlas.destroy();
});

test("a lost context's atlas makes room again before writing, whatever its size", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.send();
  atlas.lost();
  assert.equal(atlas.vertexCount, 0);
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.send();
  assert.deepEqual(gpu.calls, [
    "resize 4096 12288 keeping 0 0",
    "vertices 0 3",
    "indices 0 3",
    "resize 4096 12288 keeping 0 0",
    "vertices 0 3",
    "indices 0 3",
  ]);
  atlas.destroy();
});

test("Graphics added one after another share a run, and anything between them starts another", () => {
  const set = new InstructionSet();
  const [a, b, c] = [new Graphics(), new Graphics(), new Graphics()];

  const add = (g: object) => addToRun(g as Run[0], set as unknown as Run[1]);

  add(a);
  add(b);
  set.add({ renderPipeId: "batch", canBundle: true });
  add(c);
  assert.equal(set.instructionSize, 3);
  assert.deepEqual((set.instructions[0] as TableInstruction).items, [a, b]);
  assert.deepEqual((set.instructions[2] as TableInstruction).items, [c]);

  // A build that starts over makes new runs, not the last build's.
  set.reset();
  add(c);
  assert.equal(set.instructionSize, 1);
  assert.deepEqual((set.instructions[0] as TableInstruction).items, [c]);
});

test("rows go up bound for an upload to texture unit 0", () => {
  // Bound already, Pixi's bind leaves the unit a pass activated to unbind
  // its target active: the table binds for an upload, which activates it.
  const steps: string[] = [];
  const texture = {
    bindForUpload(_source: unknown, location: number) {
      steps.push(`bind ${location}`);
    },
  };
  const gl = {
    TEXTURE_2D: 1,
    RGBA: 2,
    FLOAT: 3,
    texSubImage2D() {
      steps.push("upload");
    },
  };
  const renderer = {
    type: 1,
    gl,
    texture,
    runners: { contextChange: { add() {} }, prerender: { add() {} } },
  };
  const pipe = new TablePipe(renderer as unknown as ConstructorParameters<typeof TablePipe>[0]);
  const upload = (pipe as unknown as { upload(from: number, to: number): void }).upload.bind(pipe);

  upload(0, 1);
  upload(1, 2);
  assert.deepEqual(steps, ["bind 0", "upload", "bind 0", "upload"]);
});

test("a run's rows go up in one call: the part of their line, or the whole lines they span", () => {
  const calls: number[][] = [];
  const texture = { bindForUpload() {} };
  const gl = {
    TEXTURE_2D: 1,
    RGBA: 2,
    FLOAT: 3,
    texSubImage2D(...args: number[]) {
      // x, y, width, height, and the first float.
      calls.push([args[2], args[3], args[4], args[5], args[9]]);
    },
  };
  const renderer = {
    type: 1,
    gl,
    texture,
    runners: { contextChange: { add() {} }, prerender: { add() {} } },
  };
  const pipe = new TablePipe(renderer as unknown as ConstructorParameters<typeof TablePipe>[0]);
  const upload = (pipe as unknown as { upload(from: number, to: number): void }).upload.bind(pipe);

  // A line holds 256 rows of 5 texels, 20 floats a row.
  upload(10, 20);
  upload(250, 300);
  upload(256, 512);
  assert.deepEqual(calls, [
    [50, 0, 50, 1, 200],
    [0, 0, 1280, 2, 0],
    [0, 1, 1280, 1, 256 * 20],
  ]);
});

/**
 * A table pipe over a GL that logs its calls, gathered runs flushed by
 * hand: its program the given one, which a test may swap as a restored
 * context's would be, and Pixi's pipe logging the Graphics it draws.
 */
function flushing() {
  const calls: string[] = [];
  const gl = {
    TRIANGLES: 4,
    UNSIGNED_INT: 5,
    getUniformLocation(_program: unknown, name: string) {
      calls.push(`locate ${name}`);
      return name;
    },
    uniform4fv(location: string, _data: Float32Array, offset: number, length: number) {
      calls.push(`${location} ${offset} ${length}`);
    },
    uniform1i(location: string, value: number) {
      calls.push(`${location} ${value}`);
    },
    drawElements(_mode: number, count: number, _type: number, offset: number) {
      calls.push(`draw ${count} at ${offset}`);
    },
  };
  const programs = { current: {} };
  const renderer = {
    type: 1,
    gl,
    texture: { bindForUpload() {} },
    globalUniforms: { bindGroup: {} },
    state: { set() {} },
    shader: { bind() {}, _getProgramData: () => ({ program: programs.current }) },
    geometry: {
      bind() {
        calls.push("bind atlas");
      },
    },
    renderPipes: {
      graphics: {
        execute(graphics: { name: string }) {
          calls.push(`pixi ${graphics.name}`);
        },
      },
    },
    runners: { contextChange: { add() {} }, prerender: { add() {} } },
  };
  const pipe = new TablePipe(renderer as unknown as ConstructorParameters<typeof TablePipe>[0]);
  const run = pipe as unknown as {
    multi: { multiDrawElementsWEBGL(...args: unknown[]): void };
    atlas: { send(): void };
    shortShader: { groups: unknown[]; glProgram: object };
    segment: { name: string }[];
    counts: Int32Array;
    offsets: Int32Array;
    draws: number;
    cursor: number;
    flush(): void;
  };
  run.multi = {
    multiDrawElementsWEBGL(...args: unknown[]) {
      calls.push(`multi ${args[6]}`);
    },
  };
  run.atlas = { send() {} };
  // Pixi's program would want a canvas to compile in.
  run.shortShader = { groups: [], glProgram: {} };
  const gather = (draws: number) => {
    for (let i = 0; i < draws; i++) {
      run.counts[i] = 3 * (i + 1);
      run.offsets[i] = 4 * i;
    }

    run.draws = draws;
    run.cursor = draws;
  };

  return { calls, programs, run, gather };
}

test("a run too short for a multi-draw is drawn a call a draw from the atlas, each told its row", () => {
  const { calls, run, gather } = flushing();

  gather(3);
  run.flush();
  // Rows of 5 vectors, passed at once; the first row is 0 as the program starts.
  assert.deepEqual(calls, [
    "locate uRows",
    "locate uFirst",
    "uRows 0 60",
    "bind atlas",
    "draw 3 at 0",
    "uFirst 1",
    "draw 6 at 4",
    "uFirst 2",
    "draw 9 at 8",
  ]);
  // Their rows are free again.
  assert.equal(run.cursor, 0);

  calls.length = 0;
  gather(16);
  run.flush();
  assert.deepEqual(calls, ["uRows 0 320", "bind atlas", "uFirst 0", "multi 16"]);
});

test("a program linked again, as for a restored context, is told its rows and first row anew", () => {
  const { calls, programs, run, gather } = flushing();
  gather(3);
  run.flush();

  calls.length = 0;
  programs.current = {};
  gather(2);
  run.flush();
  // A new program's uFirst starts at 0: set only where a draw needs another.
  assert.deepEqual(calls, [
    "locate uRows",
    "locate uFirst",
    "uRows 0 40",
    "bind atlas",
    "draw 3 at 0",
    "uFirst 1",
    "draw 6 at 4",
  ]);
});

test("with short runs left to Pixi, a short run's Graphics go through its pipe", () => {
  const { calls, run, gather } = flushing();
  setTransformTable(true, 16, false);
  try {
    run.segment = [{ name: "a" }, { name: "b" }];
    gather(3);
    run.flush();
    assert.deepEqual(calls, ["pixi a", "pixi b"]);
    assert.equal(run.cursor, 0);
    assert.equal(run.segment.length, 0);
  } finally {
    setTransformTable(true);
  }
});
