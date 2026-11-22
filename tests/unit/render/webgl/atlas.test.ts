import assert from "node:assert/strict";
import { test } from "node:test";
import { GlState } from "../../../../packages/context3d/dist/device/state.js";
import {
  Geometries,
  type GeometryData,
  GLYPH_FLOATS,
  RELEASE_FRAMES,
  TARGET_TEXEL,
} from "../../../../packages/render/dist/geometry.js";
import {
  GeometryAtlas,
  gathered,
  type Place,
} from "../../../../packages/render/dist/webgl/atlas.js";
import { FillBatches } from "../../../../packages/render/dist/webgl/batches.js";
import {
  blendFillFragment,
  fillFragment,
  fillVertex,
  stageFillFragment,
  TABLE_ENTRIES,
} from "../../../../packages/render/dist/webgl/programs.js";

const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;
const COPY_READ_BUFFER = 0x8f36;
const COPY_WRITE_BUFFER = 0x8f37;

interface FakeBuffer {
  bytes: Uint8Array;
}

interface FakeArray {
  elements: FakeBuffer | null;
}

/**
 * Just enough of WebGL 2 for the atlas: buffers that keep their bytes, the
 * element buffer bound in the vertex array as GL binds it, copies between
 * buffers on the "GPU", and counts of the calls that make and fill the
 * atlas' buffers and of the copies.
 */
function fakeGl() {
  let arrayBuffer: FakeBuffer | null = null;
  let vertexArray: FakeArray | null = null;
  const copyBuffers: Record<number, FakeBuffer | null> = {
    [COPY_READ_BUFFER]: null,
    [COPY_WRITE_BUFFER]: null,
  };
  const counts = { bufferData: 0, bufferSubData: 0, copies: 0 };
  const context = { lost: false };
  const bound = (target: number): FakeBuffer => {
    const buffer =
      target === ARRAY_BUFFER
        ? arrayBuffer
        : target === ELEMENT_ARRAY_BUFFER
          ? (vertexArray?.elements ?? null)
          : copyBuffers[target];
    assert.ok(buffer, `no buffer bound to ${target}`);
    return buffer;
  };

  const impl: Record<string, unknown> = {
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    COPY_READ_BUFFER,
    COPY_WRITE_BUFFER,
    MAX_TEXTURE_SIZE: 0x0d33,
    createBuffer: (): FakeBuffer => ({ bytes: new Uint8Array(0) }),
    deleteBuffer(buffer: FakeBuffer) {
      buffer.bytes = new Uint8Array(0);
    },
    createVertexArray: (): FakeArray => ({ elements: null }),
    bindVertexArray(array: FakeArray | null) {
      vertexArray = array;
    },
    bindBuffer(target: number, buffer: FakeBuffer | null) {
      if (target === ARRAY_BUFFER) {
        arrayBuffer = buffer;
      } else if (target === ELEMENT_ARRAY_BUFFER) {
        assert.ok(vertexArray, "an element buffer bound outside a vertex array");
        vertexArray.elements = buffer;
      } else {
        copyBuffers[target] = buffer;
      }
    },
    bufferData(target: number, size: number) {
      if (target === ARRAY_BUFFER || target === ELEMENT_ARRAY_BUFFER) {
        counts.bufferData++;
      }

      bound(target).bytes = new Uint8Array(size);
    },
    bufferSubData(
      target: number,
      offset: number,
      data: Float32Array | Uint32Array | Int32Array,
      from = 0,
      length = data.length - from,
    ) {
      counts.bufferSubData++;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + from * 4, length * 4);
      const buffer = bound(target);
      assert.ok(offset + bytes.length <= buffer.bytes.length, "an upload past the buffer's end");
      buffer.bytes.set(bytes, offset);
    },
    copyBufferSubData(read: number, write: number, from: number, to: number, size: number) {
      counts.copies++;
      const source = bound(read);
      const target = bound(write);
      assert.notEqual(source, target, "a copy within one buffer");
      assert.ok(from + size <= source.bytes.length, "a copy from past the buffer's end");
      assert.ok(to + size <= target.bytes.length, "a copy to past the buffer's end");
      target.bytes.set(source.bytes.subarray(from, from + size), to);
    },
    getParameter: () => 4096,
    isContextLost: () => context.lost,
  };
  const gl = new Proxy(impl, {
    get: (target, key) => (key in target ? target[key as string] : () => ({})),
  }) as unknown as ConstructorParameters<typeof GeometryAtlas>[0];
  return { gl, counts, context };
}

/** A shape of `count` vertices, each at (seed, i), coloured seed, and a fan of triangles. */
function shape(seed: number, count: number): GeometryData {
  const positions = new Float32Array(count * 2);
  const colors = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = seed;
    positions[i * 2 + 1] = i;
    colors[i] = seed;
  }

  const indices = new Uint32Array(Math.max(0, count - 2) * 3);
  for (let i = 0; i + 2 < count; i++) {
    indices.set([0, i + 1, i + 2], i * 3);
  }

  return { positions, colors, indices };
}

/** Frames placed till what was added has stood long enough for its arrays to be let go of. */
function settle(atlas: GeometryAtlas, geometries: Geometries): void {
  // Placed on the first, let go of RELEASE_FRAMES of the registry's on, where too large to merge
  // or short-lived and drawn once.
  for (let i = 0; i <= RELEASE_FRAMES; i++) {
    atlas.place(geometries);
    drawn(geometries);
  }
}

/** A frame ended with every geometry drawn, so that none goes for its idle frames. */
function drawn(geometries: Geometries): void {
  for (let id = 0; id < geometries.size; id++) {
    if (geometries.holds(id)) {
      geometries.use(id);
    }
  }

  geometries.endFrame();
}

/** Idle frames fewer than IDLE_FRAMES, as text's glyph quads are given: a short-lived geometry. */
const SHORT_IDLE = 8;

/** Every shape added, by id, as its owner keeps it: the registry lets go of its arrays. */
const made = new WeakMap<Geometries, Map<number, GeometryData>>();

/** `data` added to `geometries`, kept where `keep`, and remembered for check. */
function add(geometries: Geometries, data: GeometryData, keep = false): number {
  const id = geometries.add(data, keep).id;
  let shapes = made.get(geometries);
  if (!shapes) {
    shapes = new Map();
    made.set(geometries, shapes);
  }

  shapes.set(id, data);
  return id;
}

/**
 * Each live shape's vertices and indices as the atlas' buffers hold them, at its place, in its
 * own page; its indices as its place keeps them; and its arrays let go of by the registry unless
 * it was added to be kept.
 */
function check(atlas: GeometryAtlas, geometries: Geometries, seeds: Map<number, number>): void {
  const taken = new Map<number, Place>();
  for (const [id, seed] of seeds) {
    const place = atlas.places[id] as Place;
    assert.ok(place, `geometry ${id} has no place`);
    const data = made.get(geometries)?.get(id) as GeometryData;
    assert.ok(geometries.get(id) === null || geometries.get(id) === data);
    const page = atlas.pages[place.page] as unknown as {
      vertexBuffer: FakeBuffer;
      indexBuffer: FakeBuffer;
    };
    const floats = new Float32Array(page.vertexBuffer.bytes.buffer);
    const words = new Uint32Array(page.vertexBuffer.bytes.buffer);
    for (let i = 0; i < place.vertices; i++) {
      const at = (place.vertexStart + i) * 5;
      assert.equal(floats[at], seed);
      assert.equal(floats[at + 1], i);
      assert.equal(words[at + 4], seed);
    }

    const indices = new Uint32Array(page.indexBuffer.bytes.buffer);
    assert.equal(place.indices, data.indices.length);
    for (let i = 0; i < place.indices; i++) {
      assert.equal(indices[place.indexStart + i], data.indices[i] + place.vertexStart);
    }

    assert.deepEqual([...place.local], [...data.indices]);
    // Once let go of, its indices are a copy of their own, not a view on the geometry's arrays.
    if (geometries.released(id)) {
      assert.ok(place.local.buffer !== data.indices.buffer);
    }

    taken.set(id, place);
  }

  // No two live shapes share a vertex or an index, which batches' keys count on.
  const places = [...taken.values()];
  for (const key of ["vertex", "index"] as const) {
    const ranges = places
      .map((p) => (key === "vertex" ? [p.vertexStart, p.vertices] : [p.indexStart, p.indices]))
      .filter(([, length]) => length > 0)
      .sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < ranges.length; k++) {
      assert.ok(ranges[k][0] >= ranges[k - 1][0] + ranges[k - 1][1], `${key} ranges overlap`);
    }
  }
}

test("shapes let go of leave holes that later shapes fill, each indexed from its own vertices", () => {
  const { gl, counts } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  for (let i = 0; i < 64; i++) {
    const id = add(geometries, shape(i + 1, 500));
    seeds.set(id, i + 1);
  }

  atlas.place(geometries);
  check(atlas, geometries, seeds);
  const made = counts.bufferData;
  assert.equal(made, 2);

  // Half let go of, every other one, then as many again, smaller, added: in the holes once the
  // top is full, never packing the atlas again.
  for (let round = 0; round < 40; round++) {
    for (const [id] of [...seeds].filter((_, k) => k % 2 === round % 2)) {
      geometries.remove(id);
      seeds.delete(id);
    }

    for (let i = 0; i < 32; i++) {
      const seed = 1000 + round * 100 + i;
      const id = add(geometries, shape(seed, 300 + ((i * 37) % 200)));
      seeds.set(id, seed);
    }

    atlas.place(geometries);
    check(atlas, geometries, seeds);
  }

  assert.equal(counts.bufferData, made);
});

test("a shape no hole holds packs the atlas again, with what was added before it that frame", () => {
  const { gl, counts } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  // Packed with room for twice its 64 shapes of 1024, filled to its end by as many again, then
  // every other one let go of.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 64; i++) {
      const seed = round * 64 + i + 1;
      const id = add(geometries, shape(seed, 1024));
      seeds.set(id, seed);
    }

    atlas.place(geometries);
  }

  assert.equal(counts.bufferData, 2);
  const ids = [...seeds.keys()];
  for (let k = 0; k < ids.length; k += 2) {
    geometries.remove(ids[k]);
    seeds.delete(ids[k]);
  }

  atlas.place(geometries);
  // Room for half the atlas, but in holes of 1024: a small shape fits, then a large one does not.
  const small = add(geometries, shape(500, 1000));
  seeds.set(small, 500);
  seeds.set(add(geometries, shape(501, 4000)), 501);
  atlas.place(geometries);
  assert.equal(counts.bufferData, 4);
  check(atlas, geometries, seeds);
  // Packed from the start in their order in the page, their vertices moved on the GPU: the
  // small one first, from the first hole.
  assert.equal((atlas.places[small] as Place).vertexStart, 0);
  assert.equal((atlas.places[ids[1]] as Place).vertexStart, 1000);
  assert.equal((atlas.places[ids[3]] as Place).vertexStart, 2024);
  assert.ok(counts.copies > 0);
});

test("a context lost takes the shapes whose arrays were let go of, and copies those kept again from the start", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  const handles = new Map<number, ReturnType<Geometries["add"]>>();
  for (let i = 0; i < 20; i++) {
    // Every fourth kept, as a 3D object's quad is, whose owner changes it in place.
    const id = add(geometries, shape(i + 1, 300 + i), i % 4 === 0);
    handles.set(id, { id, generation: geometries.generation(id) });
    seeds.set(id, i + 1);
  }

  settle(atlas, geometries);
  for (const id of [...seeds.keys()].slice(0, 6)) {
    geometries.remove(id);
    seeds.delete(id);
  }

  atlas.place(geometries);
  const version = geometries.removalVersion;
  atlas.setUp();
  geometries.lost();
  assert.ok(geometries.removalVersion > version);
  atlas.place(geometries);
  for (const [id, handle] of handles) {
    const kept = seeds.has(id) && (seeds.get(id) as number) % 4 === 1;
    assert.equal(geometries.alive(handle), kept, `geometry ${id}`);
    if (!kept) {
      seeds.delete(id);
    }
  }

  assert.equal(seeds.size, 3);
  check(atlas, geometries, seeds);
  assert.equal(Math.min(...[...seeds.keys()].map((id) => atlas.places[id]?.vertexStart ?? -1)), 0);
  // Their owners add the others again, which go after them.
  for (let i = 0; i < 4; i++) {
    seeds.set(add(geometries, shape(100 + i, 50)), 100 + i);
  }

  atlas.place(geometries);
  check(atlas, geometries, seeds);
});

test("shapes added together go in one hole that holds them all, in one upload a buffer", () => {
  const { gl, counts } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  // 128 shapes of 1024 fill a packed atlas to its end.
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 64; i++) {
      const seed = round * 64 + i + 1;
      const id = add(geometries, shape(seed, 1024));
      seeds.set(id, seed);
    }

    atlas.place(geometries);
  }

  // Eight in a row let go of: one hole of 8192 vertices.
  const ids = [...seeds.keys()];
  for (const id of ids.slice(16, 24)) {
    geometries.remove(id);
    seeds.delete(id);
  }

  atlas.place(geometries);
  const hole = (atlas.places[ids[15]] as Place).vertexStart + 1024;
  const uploads = counts.bufferSubData;
  for (let i = 0; i < 20; i++) {
    const id = add(geometries, shape(900 + i, 300));
    seeds.set(id, 900 + i);
  }

  atlas.place(geometries);
  assert.equal(counts.bufferData, 2);
  assert.equal(counts.bufferSubData - uploads, 2);
  check(atlas, geometries, seeds);
  const starts = [...seeds.keys()]
    .filter((id) => (seeds.get(id) as number) >= 900)
    .map((id) => (atlas.places[id] as Place).vertexStart)
    .sort((a, b) => a - b);
  assert.equal(starts[0], hole);
  assert.equal(starts.at(-1), hole + 19 * 300);
});

test("an id added twice in a frame keeps one place, its first copy's room given back", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const kept = add(geometries, shape(1, 100));
  atlas.place(geometries);
  const first = add(geometries, shape(2, 200));
  geometries.remove(first);
  const second = add(geometries, shape(3, 50));
  assert.equal(second, first);
  atlas.place(geometries);
  check(
    atlas,
    geometries,
    new Map([
      [kept, 1],
      [second, 3],
    ]),
  );
  const page = atlas.pages[0];
  assert.equal(page.live, 150);
  // Letting both go leaves the page empty, filled again from its start.
  geometries.remove(kept);
  geometries.remove(second);
  atlas.place(geometries);
  assert.equal(page.live, 0);
  assert.equal(page.vertices.top, 0);
  assert.equal(page.indices.top, 0);
});

test("random adds, removals and in-place updates keep every live shape whole and apart", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  // mulberry32, so that a failure repeats.
  let state = 7;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let next = 1;
  const keeps = new Set<number>();
  for (let frame = 0; frame < 300; frame++) {
    const ops = 1 + Math.floor(random() * 24);
    for (let op = 0; op < ops; op++) {
      const roll = random();
      const ids = [...seeds.keys()];
      if (roll < 0.45 || ids.length === 0) {
        // Mostly small, now and then empty, or past what one staged upload holds.
        const big = random() < 0.03;
        const count = big ? 17000 + Math.floor(random() * 4000) : Math.floor(random() * 900);
        const seed = next++;
        // A few kept, which alone may change in place.
        const keep = random() < 0.2;
        const id = add(geometries, shape(seed, count), keep);
        seeds.set(id, seed);
        if (keep) {
          keeps.add(id);
        } else {
          keeps.delete(id);
        }
      } else if (roll < 0.85) {
        const id = ids[Math.floor(random() * ids.length)];
        geometries.remove(id);
        seeds.delete(id);
        keeps.delete(id);
      } else {
        // The same lengths, new values: copied again where it lies.
        const kept = ids.filter((id) => keeps.has(id));
        if (kept.length === 0) {
          continue;
        }

        const id = kept[Math.floor(random() * kept.length)];
        const data = geometries.get(id) as GeometryData;
        const seed = next++;
        for (let i = 0; i < data.colors.length; i++) {
          data.positions[i * 2] = seed;
          data.colors[i] = seed;
        }

        geometries.update(id);
        seeds.set(id, seed);
      }
    }

    atlas.place(geometries);
    check(atlas, geometries, seeds);
    // No place outlives its geometry.
    for (let id = 0; id < atlas.places.length; id++) {
      if (atlas.places[id] && !seeds.has(id)) {
        assert.fail(`geometry ${id}, let go of, still has a place`);
      }
    }
  }
});

test("a fill sampling the stage's pixel anywhere is marked for the stage fill program, as it changes", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const plain = { ...shape(1, 4), texels: new Float32Array(8) };
  // One fill of a part that samples the stage, after one that does not (samplesAlike).
  const mixed = { ...shape(2, 4), texels: Float32Array.of(0, 0, 1, 1, TARGET_TEXEL, 0, 2, 2) };
  const a = add(geometries, plain, true);
  const b = add(geometries, mixed, true);
  atlas.place(geometries);
  assert.equal(atlas.places[a]?.stage, false);
  assert.equal(atlas.places[b]?.stage, true);

  plain.texels[6] = TARGET_TEXEL;
  geometries.update(a);
  mixed.texels[4] = 3;
  geometries.update(b);
  atlas.place(geometries);
  assert.equal(atlas.places[a]?.stage, true);
  assert.equal(atlas.places[b]?.stage, false);
});

test("only the stage fill program finds the stage's pixel, so the fill program's fragments never pay for it", () => {
  for (const vertex of [fillVertex(true), fillVertex(false, true), fillVertex(false)]) {
    assert.equal(vertex.includes(String(TARGET_TEXEL / 2)), false);
  }

  // The blend program reads what is below by gl_FragCoord, as it always did.
  assert.equal(fillFragment.includes("gl_FragCoord"), false);
  assert.equal(fillFragment.includes("uStage"), false);
  assert.equal(blendFillFragment.includes("uStage"), false);

  assert.equal(fillVertex(false, false, true).includes(String(TARGET_TEXEL / 2)), true);
  assert.equal(stageFillFragment.includes("gl_FragCoord"), true);
});

test("a shape of more vertices than 16 bits count keeps its indices in 32 bits, and moves with them", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  const small = add(geometries, shape(1, 300));
  seeds.set(small, 1);
  seeds.set(add(geometries, shape(2, 70000)), 2);
  settle(atlas, geometries);
  check(atlas, geometries, seeds);
  const wide = [...seeds.keys()].find((id) => id !== small) as number;
  assert.ok(atlas.places[wide]?.local instanceof Uint32Array);
  assert.ok(atlas.places[small]?.local instanceof Uint16Array);
  // Packed again behind a shape added where the first was, past what the room holds.
  geometries.remove(small);
  seeds.delete(small);
  seeds.set(add(geometries, shape(3, 200000)), 3);
  atlas.place(geometries);
  check(atlas, geometries, seeds);
});

/** Advanced text's quads: `quads` of them, each vertex's floats from `seed`, mode and table their own. */
function glyphs(seed: number, quads: number): GeometryData {
  const count = quads * 4;
  const vertices = new Float32Array(count * GLYPH_FLOATS);
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = seed * 1000 + i;
  }

  const indices = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }

  return {
    positions: new Float32Array(count * 2),
    colors: new Uint32Array(count),
    indices,
    glyphs: {
      vertices,
      mode: Float32Array.of(seed, 0, 0, 0),
      table: new Float32Array(TABLE_ENTRIES * 4).fill(seed),
    },
  };
}

test("texts' quads let go of are packed out of the glyph atlas on the GPU, their tables slotted again", () => {
  const { gl, counts } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const texts = new Map<number, GeometryData>();
  for (let i = 0; i < 12; i++) {
    const data = glyphs(i + 1, 40 + i * 10);
    texts.set(geometries.add(data).id, data);
  }

  atlas.place(geometries);
  // Most let go of: their holes outweigh what is live, and the next frame packs the atlas.
  for (const id of [...texts.keys()].filter((_, k) => k % 4 !== 1)) {
    geometries.remove(id);
    texts.delete(id);
  }

  const copies = counts.copies;
  const added = glyphs(99, 20);
  texts.set(geometries.add(added).id, added);
  atlas.place(geometries);
  assert.ok(counts.copies > copies);
  settle(atlas, geometries);
  const fake = atlas as unknown as { glyphBuffer: FakeBuffer; glyphIndexBuffer: FakeBuffer };
  const floats = new Float32Array(fake.glyphBuffer.bytes.buffer);
  const indices = new Uint32Array(fake.glyphIndexBuffer.bytes.buffer);
  let top = 0;
  for (const [id, data] of texts) {
    assert.equal(geometries.get(id), null);
    const place = atlas.places[id] as Place;
    const vertices = data.glyphs?.vertices as Float32Array;
    assert.deepEqual(
      floats.subarray(
        place.vertexStart * GLYPH_FLOATS,
        (place.vertexStart + place.vertices) * GLYPH_FLOATS,
      ),
      vertices,
    );
    for (let i = 0; i < place.indices; i++) {
      assert.equal(indices[place.indexStart + i], data.indices[i] + place.vertexStart);
    }

    assert.ok((place.glyphs?.slot ?? -1) >= 0);
    top = Math.max(top, place.vertexStart + place.vertices);
  }

  // Only the live texts' quads, in a row from the start.
  assert.equal(
    top,
    [...texts.values()].reduce((n, d) => n + (d.indices.length / 6) * 4, 0),
  );
});

/** A run's stream over a fake GL's atlas, and what it uploaded: its vertices, slots' words and indices. */
function stream() {
  const { gl, counts } = fakeGl();
  const state = new GlState(gl);
  const atlas = new GeometryAtlas(gl, state);
  atlas.setUp();
  const batches = new FillBatches(gl, state);
  batches.setUp(64);
  const geometries = new Geometries();
  const uploaded = () => {
    const fake = batches as unknown as { vertexBuffer: FakeBuffer; indexBuffer: FakeBuffer };
    return {
      words: new Uint32Array(fake.vertexBuffer.bytes.buffer),
      floats: new Float32Array(fake.vertexBuffer.bytes.buffer),
      indices: new Uint32Array(fake.indexBuffer.bytes.buffer),
    };
  };
  return { gl, counts, atlas, batches, geometries, uploaded };
}

/** The stream asked for a run of `ids`, one geometry drawn twice; what it gave, uploaded. */
function run(s: ReturnType<typeof stream>, ids: number[]) {
  const ids2 = [...ids, ids[3]];
  const places = ids2.map((id) => s.atlas.places[id] as Place);
  // Counted as Draws counts the draws it gathers.
  for (let k = 0; k < places.length; k++) {
    gathered(places[k], s.atlas.frame, k);
  }

  s.batches.reset();
  const segment = s.batches.add(
    places,
    Int32Array.from(ids2, (_, k) => 1000 + k),
    ids2.length,
    s.atlas.frame,
    32,
    false,
  );
  s.batches.upload();
  return { segment, places, ids: ids2 };
}

test("a run's stream stages its geometries from their arrays, which merged geometries keep", () => {
  const s = stream();
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const data = shape(i + 1, 3 + (i % 7) * 20);
    // Some textured, whose texels the stream stages too.
    if (i % 3 === 0) {
      data.texels = Float32Array.from(data.positions, (v, k) => v * 2 + k);
    }

    ids.push(add(s.geometries, data));
  }

  // A moving scene's runs, made anew each frame, long past the frames a geometry too large to
  // merge would have kept its arrays.
  for (let frame = 0; frame <= RELEASE_FRAMES + 10; frame++) {
    s.atlas.place(s.geometries);
    drawn(s.geometries);
    const ordered = frame % 2 ? ids : [...ids].reverse();
    const { segment, places, ids: order } = run(s, ordered);
    if (frame === 0) {
      // Placed this frame: drawn from the atlas till the next.
      assert.equal(segment, null);
      continue;
    }

    assert.ok(segment, `frame ${frame}`);
    const { words, floats, indices } = s.uploaded();
    let base = 0;
    let index = segment.indexStart;
    for (let k = 0; k < order.length; k++) {
      const data = made.get(s.geometries)?.get(order[k]) as GeometryData;
      for (let j = 0; j < places[k].vertices; j++) {
        const at = (base + j) * 6;
        assert.equal(floats[at], data.positions[j * 2]);
        assert.equal(floats[at + 1], data.positions[j * 2 + 1]);
        assert.equal(floats[at + 2], data.texels ? data.texels[j * 2] : 0);
        assert.equal(floats[at + 3], data.texels ? data.texels[j * 2 + 1] : 0);
        assert.equal(words[at + 4], data.colors[j]);
        assert.equal(words[at + 5] - words[5], k, "each draw's slot, in order");
      }

      for (let j = 0; j < places[k].indices; j++) {
        assert.equal(indices[index + j], base + data.indices[j]);
      }

      base += places[k].vertices;
      index += places[k].indices;
    }

    // Each frame's segment staged anew at the stream's top, which then makes it anew.
    s.batches.reset();
  }

  for (const id of ids) {
    assert.ok(!s.geometries.released(id), `geometry ${id} small enough to merge keeps its arrays`);
  }

  assert.equal(s.counts.copies, 0);
});

test("a short-lived geometry drawn once is let go of at RELEASE_FRAMES, others kept", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  // 256 vertices and 1,024 indices at most merge (Place.batch).
  const twice = add(geometries, shape(3, 256));
  // Small enough, but short-lived and drawn once, as a text changed every frame is.
  const once = add(geometries, shape(1, 256));
  geometries.idleWithin(once, SHORT_IDLE);
  const large = add(geometries, shape(2, 257));
  // Drawn once, but of the usual idle frames, as a timeline's stroke made at a scale is.
  const usual = add(geometries, shape(4, 64));
  for (let frame = 0; frame < RELEASE_FRAMES; frame++) {
    atlas.place(geometries);
    // The draws the runs gather (Draws): two of one in its first frame, as two objects drawing
    // it would make, and one of the other.
    if (frame === 0) {
      gathered(atlas.places[twice] as Place, atlas.frame, 0);
      gathered(atlas.places[twice] as Place, atlas.frame, 1);
      gathered(atlas.places[once] as Place, atlas.frame, 2);
      gathered(atlas.places[usual] as Place, atlas.frame, 3);
    }

    drawn(geometries);
    for (const id of [twice, once, large]) {
      assert.ok(!geometries.released(id), `frame ${frame}`);
    }
  }

  const onceBatch = (atlas.places[once] as Place).batch;
  atlas.place(geometries);
  assert.ok(geometries.released(large));
  assert.ok(atlas.places[large]?.local instanceof Uint16Array);
  assert.ok(geometries.released(once));
  // Nor does the batch let go of hold its arrays, wherever V8 keeps it till a full collection.
  assert.equal(onceBatch?.data, null);
  assert.ok(atlas.places[once]?.local instanceof Uint16Array);
  assert.equal(atlas.places[once]?.batch, null, "no longer merges");
  assert.ok(!geometries.released(twice));
  assert.equal(atlas.places[twice]?.batch?.data, made.get(geometries)?.get(twice));
  assert.ok(!geometries.released(usual));
  // However long it stands.
  settle(atlas, geometries);
  settle(atlas, geometries);
  assert.ok(!geometries.released(twice));
  check(
    atlas,
    geometries,
    new Map([
      [twice, 3],
      [once, 1],
      [large, 2],
      [usual, 4],
    ]),
  );
});

test("a run of short-lived geometries let go of after a single draw draws from the atlas", () => {
  const s = stream();
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push(add(s.geometries, shape(i + 1, 4 + i)));
    s.geometries.idleWithin(ids[i], SHORT_IDLE);
  }

  settle(s.atlas, s.geometries);
  for (const id of ids) {
    assert.ok(s.geometries.released(id));
  }

  assert.equal(run(s, ids).segment, null);
});

test("a draw gathered again is counted once, and the count stops at 2", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const id = add(geometries, shape(1, 8));
  atlas.place(geometries);
  const place = atlas.places[id] as Place;
  // A mask's entry, gathered for its push and its pop, and a frame's whose run table overflowed,
  // gathered as it prepares and again as it draws.
  gathered(place, atlas.frame, 5);
  gathered(place, atlas.frame, 5);
  assert.equal(place.batch?.draws, 1);
  // Another entry in the frame, or the same entry in another frame, is another draw.
  gathered(place, atlas.frame, 6);
  assert.equal(place.batch?.draws, 2);
  gathered(place, atlas.frame + 1, 6);
  gathered(place, atlas.frame + 2, 7);
  assert.equal(place.batch?.draws, 2);
});

test("a short-lived geometry drawn in its first frame and its third keeps its arrays", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const id = add(geometries, shape(1, 8));
  geometries.idleWithin(id, SHORT_IDLE);
  for (let frame = 0; frame <= RELEASE_FRAMES; frame++) {
    atlas.place(geometries);
    if (frame === 0 || frame === 2) {
      gathered(atlas.places[id] as Place, atlas.frame, 0);
    }

    drawn(geometries);
  }

  assert.ok(!geometries.released(id));
  assert.equal(atlas.places[id]?.batch?.draws, 2);
});

test("a kept geometry changed in place keeps its count, its old batch letting go of its arrays", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const data = shape(1, 8);
  const id = add(geometries, data, true);
  atlas.place(geometries);
  gathered(atlas.places[id] as Place, atlas.frame, 0);
  const before = (atlas.places[id] as Place).batch;
  data.positions[0] = 7;
  geometries.update(id);
  atlas.place(geometries);
  const after = (atlas.places[id] as Place).batch;
  assert.notEqual(after, before);
  assert.equal(before?.data, null);
  assert.equal(after?.data, data);
  assert.equal(after?.draws, 1);
});

test("a short-lived geometry let go of after a single draw, rebuilt and drawn twice, merges again", () => {
  const s = stream();
  const data = Array.from({ length: 40 }, (_, i) => shape(i + 1, 4 + i));
  const addShort = (d: GeometryData): number => {
    const id = add(s.geometries, d);
    s.geometries.idleWithin(id, SHORT_IDLE);
    return id;
  };
  let ids = data.map(addShort);
  // Drawn once, by no run: let go of, and no longer merging.
  settle(s.atlas, s.geometries);
  for (const id of ids) {
    assert.ok(s.geometries.released(id));
  }

  assert.equal(run(s, ids).segment, null);
  // Its owner asks for it again (rebuild) and adds it anew, as it does an expired one.
  for (const id of ids) {
    assert.ok(s.geometries.rebuild(id));
  }

  ids = data.map(addShort);
  for (let frame = 0; frame <= RELEASE_FRAMES; frame++) {
    s.atlas.place(s.geometries);
    drawn(s.geometries);
    if (frame > 0) {
      assert.ok(run(s, ids).segment, `frame ${frame}`);
    }
  }

  for (const id of ids) {
    assert.ok(!s.geometries.released(id));
  }
});

test("geometries copied while the context is lost keep their arrays, for the restore to copy", () => {
  const { gl, context } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const before = add(geometries, shape(1, 300));
  settle(atlas, geometries);
  assert.ok(geometries.released(before));
  context.lost = true;
  const during = add(geometries, shape(2, 400));
  settle(atlas, geometries);
  assert.ok(!geometries.released(during) && geometries.get(during) !== null);
  // Restored: the one let go of is rebuilt by its owner, the other copied again as it is.
  context.lost = false;
  atlas.setUp();
  geometries.lost();
  assert.ok(!geometries.holds(before));
  settle(atlas, geometries);
  check(atlas, geometries, new Map([[during, 2]]));
  assert.ok(geometries.released(during));
});

test("a geometry drawn anew each frame is let go of whole before its indices are copied", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  let last = -1;
  for (let frame = 0; frame < 10; frame++) {
    if (last >= 0) {
      geometries.remove(last);
    }

    last = add(geometries, shape(frame + 1, 300));
    atlas.place(geometries);
    geometries.endFrame();
    const place = atlas.places[last] as Place;
    // Its indices still the geometry's own, uncopied, and its arrays held.
    assert.equal(place.local, made.get(geometries)?.get(last)?.indices);
    assert.ok(!geometries.released(last));
  }

  // One that stands is let go of, its indices copied.
  settle(atlas, geometries);
  assert.ok(geometries.released(last));
  check(atlas, geometries, new Map([[last, 10]]));
});
