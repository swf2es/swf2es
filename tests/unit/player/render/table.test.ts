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
  Ranges,
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
    writeVertices(at: number, data: Float32Array, from: number, floats: number) {
      out.vertices.set(data.subarray(from, from + floats), at * 6);
      out.calls.push(`vertices ${at} ${floats / 6}`);
    },
    writeIndices(at: number, data: Uint32Array, from: number, count: number) {
      out.indices.set(data.subarray(from, from + count), at);
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

  // One past the store's room: what was staged goes first, then the store doubles keeping it.
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  atlas.place({}, packed(5000, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.deepEqual(gpu.calls.slice(5), [
    "vertices 10 3",
    "indices 12 3",
    "resize 8192 12288 keeping 13 15",
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

test("free ranges join their neighbours, and one that reaches the top lowers it", () => {
  const ranges = new Ranges();
  assert.equal(ranges.take(10, 100), 0);
  assert.equal(ranges.take(20, 100), 10);
  assert.equal(ranges.take(30, 100), 30);
  assert.equal(ranges.take(41, 100), -1);
  assert.equal(ranges.top, 60);

  ranges.give(10, 20);
  assert.deepEqual([ranges.free, ranges.stretches], [20, 1]);
  ranges.give(0, 10);
  assert.deepEqual([ranges.free, ranges.stretches], [30, 1]);
  // The closest fit, part of the joined stretch, the rest left free.
  assert.equal(ranges.take(25, 100), 0);
  assert.deepEqual([ranges.free, ranges.stretches], [5, 1]);
  ranges.give(0, 25);
  ranges.give(30, 30);
  assert.deepEqual([ranges.top, ranges.free, ranges.stretches], [0, 0, 0]);
});

test("released ranges are taken again from the next frame on, each by the closest fit", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  const place = (key: object, vertices: number) =>
    atlas.place(key, packed(vertices, [0, 1, 2], [{ start: 0, size: 3 }]));
  const [a, b, c, d] = [{}, {}, {}, {}];
  place(a, 100);
  place(b, 300);
  place(c, 200);
  place(d, 50);
  atlas.release(a);
  atlas.release(c);

  // Still this frame: a run gathered may read where a and c lay, so nothing new goes there.
  assert.deepEqual(place({}, 100)?.offsets, [12 * 4]);
  assert.equal(atlas.vertexCount, 750);

  atlas.compact();
  const f = place({}, 150);
  const g = place({}, 100);
  const h = place({}, 50);
  assert.deepEqual([f?.vertexStart, g?.vertexStart, h?.vertexStart], [400, 0, 550]);
  // Their indices too, in the stretches a and c left, offset by where their vertices went.
  assert.deepEqual([f?.indexStart, g?.indexStart, h?.indexStart], [0, 6, 15]);
  assert.equal(atlas.vertexCount, 750);
  atlas.send();
  const triangle = (first: number) => [first, first + 1, first + 2];
  assert.deepEqual(
    [...gpu.indices.subarray(0, 18)],
    [400, 100, 0, 600, 650, 550].flatMap(triangle),
  );
  assert.deepEqual(atlas.stats, { placed: 8, reused: 3, released: 2, grown: 0, compacted: 0 });
  atlas.destroy();
});

test("contexts that come and go each frame grow the atlas only while the live ones grow", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  const alive: object[] = [];
  const resizes: number[] = [];
  // Ten contexts a frame of 900 to 1,350 vertices, the oldest let go once 300 live.
  for (let frame = 0; frame < 200; frame++) {
    atlas.compact();
    for (let i = 0; i < 10; i++) {
      const key = {};
      const vertices = 900 + ((frame * 10 + i) % 7) * 75;
      atlas.place(key, packed(vertices, [0, 1, 2], [{ start: 0, size: 3 }]));
      alive.push(key);
      if (alive.length > 300) {
        atlas.release(alive.shift() as object);
      }
    }

    atlas.send();
    const grown = gpu.calls.filter((call) => call.startsWith("resize")).length;
    gpu.calls.length = 0;
    if (grown) {
      resizes.push(frame);
    }
  }

  // Doubling up to some 340,000 vertices, in the first 30 frames, and never after.
  assert.ok(resizes.length <= 8, `grown in frames ${resizes}`);
  assert.ok(
    resizes.every((frame) => frame < 31),
    `grown in frames ${resizes}`,
  );
  assert.equal(atlas.stats.compacted, 0);
  assert.equal(atlas.stats.placed, 2000);
  assert.equal(atlas.stats.released, 1700);
  assert.ok(atlas.stats.reused > 1500);
  assert.ok(atlas.vertexCount <= atlas.capacity);
  atlas.destroy();
});

test("the atlas packs again once holes no context fits pass twice the live vertices", () => {
  const gpu = store();
  const atlas = new Atlas(WHITE, gpu);
  const keys = Array.from({ length: 8 }, () => ({}));
  const big = 40000;
  for (const key of keys) {
    atlas.place(key, packed(big, [0, 1, 2], [{ start: 0, size: 3 }]));
  }

  assert.equal(atlas.capacity, 320000);
  assert.deepEqual(
    gpu.calls.filter((call) => call.startsWith("resize")),
    [
      "resize 4096 12288 keeping 0 0",
      "resize 40000 12288 keeping 0 0",
      "resize 80000 12288 keeping 40000 3",
      "resize 160000 12288 keeping 80000 6",
      "resize 320000 12288 keeping 160000 12",
    ],
  );

  // Five gone, 200,000 vertices free beside 120,000 live: kept, to be filled.
  for (const key of keys.slice(0, 5)) {
    atlas.release(key);
  }

  atlas.compact();
  assert.equal(atlas.vertexCount, 8 * big);
  assert.equal(atlas.stats.compacted, 0);

  // Seven: 280,000 beside 40,000. Packed again, in a store cut down to twice what is live.
  atlas.release(keys[5]);
  atlas.release(keys[6]);
  atlas.compact();
  assert.equal(atlas.stats.compacted, 1);
  assert.equal(atlas.vertexCount, 0);
  assert.equal(atlas.capacity, 2 * big);
  assert.equal(atlas.indexCapacity, 4096 * 3);
  gpu.calls.length = 0;
  const again = atlas.place(keys[7], packed(big, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.deepEqual(again?.offsets, [0]);
  assert.deepEqual(gpu.calls, [`resize ${2 * big} 12288 keeping 0 0`]);

  // The last placed released: the top comes down to the hole below, and nothing is left to pack.
  atlas.release(keys[7]);
  atlas.compact();
  assert.equal(atlas.vertexCount, 0);
  assert.equal(atlas.stats.compacted, 1);
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

/** A float's bits, as an expanded atlas keeps a position. */
const bits = (f: number) => new Uint32Array(Float32Array.of(f).buffer)[0];

test("an expanded atlas keeps each index as its vertex, and counts no vertices", () => {
  const calls: string[] = [];
  const words: number[] = [];
  const atlas = new Atlas(
    WHITE,
    {
      resize(vertices, indices, keptVertices, keptIndices) {
        calls.push(`resize ${vertices} ${indices} keeping ${keptVertices} ${keptIndices}`);
      },
      writeVertices() {
        calls.push("vertices");
      },
      writeIndices(at, data, from, count) {
        calls.push(`indices ${at} ${count}`);
        words.push(...data.subarray(from * 4, (from + count) * 4));
      },
    },
    true,
  );
  const batches = [
    { start: 0, size: 3 },
    { start: 3, size: 3 },
  ];
  const placed = atlas.place({}, packed(4, [0, 1, 2, 0, 2, 3], batches));
  assert.equal(placed?.vertices, 0);
  assert.deepEqual(placed?.offsets, [0, 3 * 4]);
  assert.equal(atlas.vertexCount, 0);
  assert.equal(atlas.indexCount, 6);
  atlas.send();
  assert.deepEqual(calls, ["resize 4096 12288 keeping 0 0", "indices 0 6"]);
  // Each index' vertex: its position's two floats, and its colour's word, the packed floats'
  // fifth, as two floats of two bytes each.
  const expected: number[] = [];
  for (const v of [0, 1, 2, 0, 2, 3]) {
    const color = bits(v * 6 + 4);
    expected.push(bits(v * 6), bits(v * 6 + 1), bits(color & 0xffff), bits(color >>> 16));
  }

  assert.deepEqual(words, expected);
  atlas.destroy();
});

/** A table pipe over a GL that logs its texture writes, its pulled draws possible. */
function pulling(
  contexts: Map<object, { batches: unknown[]; isBatchable: boolean; packed: Packed }>,
) {
  const writes: number[][] = [];
  const renderer = {
    type: 1,
    _roundPixels: 0,
    gl: {
      TEXTURE_2D: 1,
      RGBA: 2,
      FLOAT: 3,
      texSubImage2D(...args: number[]) {
        // x, y, width, height, and the first float.
        writes.push([args[2], args[3], args[4], args[5], args[9]]);
      },
    },
    texture: { bindForUpload() {} },
    graphicsContext: {
      getGpuContext: (context: object) => contexts.get(context),
      getContextRenderDataOnCpu: (context: object) => contexts.get(context)?.packed,
    },
    runners: { contextChange: { add() {} }, prerender: { add() {} } },
  };
  const pipe = new TablePipe(renderer as unknown as ConstructorParameters<typeof TablePipe>[0]);
  const inner = pipe as unknown as {
    pullable: boolean;
    atlasMostLines: number;
    maxRows: number;
    atlasTexture: object | null;
    pulledRows: { resource: Float32Array };
    chunks: { resource: Float32Array };
    pulled: Atlas;
    render: number;
    plan(run: TableInstruction): {
      steps: number;
      alone: ({ name: string } | null)[];
      first: number[];
      chunks: number[];
      rows: number[];
      blends: string[];
    };
    stillPlaced(plan: object): boolean;
    writeAtlasTexture(at: number, data: Uint32Array, from: number, count: number): void;
  };
  inner.pullable = true;
  inner.atlasMostLines = 8192;
  inner.maxRows = 16384 * 256;
  return { pipe, inner, writes };
}

test("the expanded atlas goes into its texture a line at a time, whole lines at once", () => {
  const { inner, writes } = pulling(new Map());
  inner.atlasTexture = {};
  // Lines of 2048 texels: the rest of the first, a whole line, and what is left, from index 1 on.
  inner.writeAtlasTexture(2040, new Uint32Array(4101 * 4), 1, 4100);
  assert.deepEqual(writes, [
    [2040, 0, 8, 1, 4],
    [0, 1, 2048, 1, 4 + 8 * 4],
    [0, 2, 2044, 1, 4 + 2056 * 4],
  ]);
});

test("a run is planned as a pulled draw for each blend mode, and Pixi's pipe between", () => {
  const contexts = new Map<object, { batches: unknown[]; isBatchable: boolean; packed: Packed }>();
  const graphics = (name: string, sizes: number[], blend = "normal", batchable = false) => {
    const context = { customShader: null };
    let start = 0;
    const batches = sizes.map((size) => {
      const batch = { start, size };
      start += size;
      return batch;
    });
    const indices = Array.from({ length: start }, (_, i) => i % 3);
    contexts.set(context, {
      batches,
      isBatchable: batchable,
      packed: packed(3, indices, batches),
    });
    return {
      name,
      isRenderable: true,
      context,
      groupBlendMode: blend,
      _roundPixels: 0,
      groupTransform: { a: 1, b: 0, c: 0, d: 1, tx: name.charCodeAt(0), ty: 0 },
      groupColorAlpha: 0xffffffff,
      localColor: 0xffffff,
      localAlpha: 1,
    };
  };
  const { inner } = pulling(contexts);
  const a = graphics("a", [3]);
  const b = graphics("b", [3, 99]);
  const c = graphics("c", [3], "normal", true);
  const d = graphics("d", [3], "add");
  const run = { renderPipeId: "flashTable", canBundle: false, items: [a, b, c, d] };
  const plan = inner.plan(run as unknown as TableInstruction);

  assert.equal(plan.steps, 3);
  assert.deepEqual(plan.alone.slice(0, 3), [null, c, null]);
  assert.deepEqual(plan.first.slice(0, 3), [0, 0, 4]);
  assert.deepEqual(plan.chunks.slice(0, 3), [4, 0, 1]);
  assert.deepEqual(plan.rows.slice(0, 3), [3, 0, 1]);
  assert.deepEqual(plan.blends.slice(0, 3), ["normal", "", "add"]);
  // A row a batch, 5 texels of 4 floats, its translation the Graphics'; a chunk of up to 96
  // indices a texel: its row, its first index in the atlas, and how many.
  const rows = inner.pulledRows.resource;
  assert.deepEqual(
    [0, 1, 2, 3].map((r) => rows[r * 20 + 4]),
    [97, 98, 98, 100],
  );
  const chunks = inner.chunks.resource;
  const chunk = (k: number) => [...chunks.subarray(k * 4, k * 4 + 3)];
  assert.deepEqual([0, 1, 2, 3, 4].map(chunk), [
    [0, 0, 3],
    [1, 3, 3],
    [2, 6, 96],
    [2, 102, 3],
    [3, 105, 3],
  ]);

  // Planned for this render, it holds while its contexts stay where they were.
  assert.ok(inner.stillPlaced(plan));
  inner.pulled.release(contexts.get(c.context) as object);
  assert.ok(inner.stillPlaced(plan));
  inner.pulled.release(contexts.get(b.context) as object);
  assert.ok(!inner.stillPlaced(plan));
});
