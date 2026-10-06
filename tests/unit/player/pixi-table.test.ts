// The transform table's atlas of local vertices and its runs of Graphics:
// what goes where in the buffers, and which builds share a draw call.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  Atlas,
  addToRun,
  type Packed,
  type TableInstruction,
  TablePipe,
} from "../../../packages/player/dist/pixi-table.js";

// Pixi as the player loads it, its ES module.
const cjs = createRequire(new URL("../../../packages/player/package.json", import.meta.url));
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
      instructions: batches.map((b) => ({
        start: b.start,
        size: b.size,
        topology: b.topology ?? "triangle-list",
        textures: { count: 1, textures: [{ uid: b.texture ?? WHITE }] },
      })),
    },
  };
}

test("contexts go into the atlas once, their indices offset by the vertices before them", () => {
  const atlas = new Atlas(WHITE);
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
  assert.deepEqual([...atlas.indices.subarray(0, atlas.indexCount)], [0, 1, 2, 3, 4, 5, 3, 5, 6]);
  assert.equal(atlas.vertexCount, 7);
  assert.equal(atlas.vertices[3 * 6], 0);
  assert.equal(atlas.whole, true);

  // Sent: asked again, a context is where it was, nothing copied.
  atlas.whole = false;
  atlas.sentVertices = atlas.vertexCount;
  atlas.sentIndices = atlas.indexCount;
  assert.equal(atlas.place(a, packed(3, [0, 1, 2], [{ start: 0, size: 3 }])), first);
  assert.equal(atlas.vertexCount, atlas.sentVertices);

  // One more goes after what was sent, for that alone to go up; one past the arrays, all of it.
  atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.equal(atlas.vertexCount, 10);
  assert.equal(atlas.whole, false);
  atlas.place({}, packed(5000, [0, 1, 2], [{ start: 0, size: 3 }]));
  assert.equal(atlas.whole, true);
  atlas.destroy();
});

test("a context with a texture or another topology is not the table's", () => {
  const atlas = new Atlas(WHITE);

  assert.equal(atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3, texture: 7 }])), null);
  assert.equal(
    atlas.place({}, packed(3, [0, 1, 2], [{ start: 0, size: 3, topology: "line-list" }])),
    null,
  );
  assert.equal(atlas.vertexCount, 0);
  atlas.destroy();
});

test("the atlas starts again only once released contexts leave more holes than live vertices", () => {
  const atlas = new Atlas(WHITE);
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

test("rows go up to texture unit 0, even where a render pass left another active", () => {
  // Pixi's texture system as far as the table uses it: a bind of what a unit
  // holds already changes nothing, so the unit a pass activated to unbind its
  // target stays active.
  const units: unknown[] = [];
  let active = 0;
  const uploads: number[] = [];
  const texture = {
    _boundTextures: units,
    _premultiplyAlpha: false,
    _activateLocation(location: number) {
      active = location;
    },
    bind(source: unknown, location: number) {
      if (units[location] !== source) {
        units[location] = source;
        active = location;
      }
    },
  };
  const gl = {
    TEXTURE_2D: 1,
    RGBA: 2,
    FLOAT: 3,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 4,
    pixelStorei() {},
    texSubImage2D() {
      uploads.push(active);
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
  // A pass's target, bound at unit 1 as a back texture, unbound: unit 1 active.
  active = 1;
  upload(1, 2);
  assert.deepEqual(uploads, [0, 0]);
});

test("a run's rows go up in one call: the part of their line, or the whole lines they span", () => {
  const calls: number[][] = [];
  const texture = { _premultiplyAlpha: false, _activateLocation() {}, bind() {} };
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

  // A line holds 256 rows of 4 texels, 16 floats a row.
  upload(10, 20);
  upload(250, 300);
  upload(256, 512);
  assert.deepEqual(calls, [
    [40, 0, 40, 1, 160],
    [0, 0, 1024, 2, 0],
    [0, 1, 1024, 1, 256 * 16],
  ]);
});
