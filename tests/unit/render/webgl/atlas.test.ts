import assert from "node:assert/strict";
import { test } from "node:test";
import { GlState } from "../../../../packages/context3d/dist/device/state.js";
import { Geometries, type GeometryData } from "../../../../packages/render/dist/geometry.js";
import { GeometryAtlas, type Place } from "../../../../packages/render/dist/webgl/atlas.js";

const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;

interface FakeBuffer {
  bytes: Uint8Array;
}

interface FakeArray {
  elements: FakeBuffer | null;
}

/**
 * Just enough of WebGL 2 for the atlas: buffers that keep their bytes, the
 * element buffer bound in the vertex array as GL binds it, and counts of the
 * calls that make and fill buffers.
 */
function fakeGl() {
  let arrayBuffer: FakeBuffer | null = null;
  let vertexArray: FakeArray | null = null;
  const counts = { bufferData: 0, bufferSubData: 0 };
  const bound = (target: number): FakeBuffer => {
    const buffer = target === ARRAY_BUFFER ? arrayBuffer : (vertexArray?.elements ?? null);
    assert.ok(buffer, `no buffer bound to ${target}`);
    return buffer;
  };

  const impl: Record<string, unknown> = {
    ARRAY_BUFFER,
    ELEMENT_ARRAY_BUFFER,
    MAX_TEXTURE_SIZE: 0x0d33,
    createBuffer: (): FakeBuffer => ({ bytes: new Uint8Array(0) }),
    createVertexArray: (): FakeArray => ({ elements: null }),
    bindVertexArray(array: FakeArray | null) {
      vertexArray = array;
    },
    bindBuffer(target: number, buffer: FakeBuffer) {
      if (target === ARRAY_BUFFER) {
        arrayBuffer = buffer;
      } else {
        assert.ok(vertexArray, "an element buffer bound outside a vertex array");
        vertexArray.elements = buffer;
      }
    },
    bufferData(target: number, size: number) {
      counts.bufferData++;
      bound(target).bytes = new Uint8Array(size);
    },
    bufferSubData(
      target: number,
      offset: number,
      data: Float32Array | Uint32Array,
      from = 0,
      length = data.length - from,
    ) {
      counts.bufferSubData++;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + from * 4, length * 4);
      const buffer = bound(target);
      assert.ok(offset + bytes.length <= buffer.bytes.length, "an upload past the buffer's end");
      buffer.bytes.set(bytes, offset);
    },
    getParameter: () => 4096,
    isContextLost: () => false,
  };
  const gl = new Proxy(impl, {
    get: (target, key) => (key in target ? target[key as string] : () => ({})),
  }) as unknown as ConstructorParameters<typeof GeometryAtlas>[0];
  return { gl, counts };
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

/** Each live shape's vertices and indices as the atlas' buffers hold them, at its place, in its own page. */
function check(atlas: GeometryAtlas, geometries: Geometries, seeds: Map<number, number>): void {
  const taken = new Map<number, Place>();
  for (const [id, seed] of seeds) {
    const place = atlas.places[id] as Place;
    assert.ok(place, `geometry ${id} has no place`);
    const data = geometries.get(id) as GeometryData;
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
    const handle = geometries.add(shape(i + 1, 500));
    seeds.set(handle.id, i + 1);
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
      const handle = geometries.add(shape(seed, 300 + ((i * 37) % 200)));
      seeds.set(handle.id, seed);
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
      const handle = geometries.add(shape(seed, 1024));
      seeds.set(handle.id, seed);
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
  const small = geometries.add(shape(500, 1000));
  seeds.set(small.id, 500);
  const large = geometries.add(shape(501, 4000));
  seeds.set(large.id, 501);
  atlas.place(geometries);
  assert.equal(counts.bufferData, 4);
  check(atlas, geometries, seeds);
  // Packed from the start, in order of id.
  assert.equal((atlas.places[ids[1]] as Place).vertexStart, 0);
});

test("a context restored packs every live shape again from the start", () => {
  const { gl } = fakeGl();
  const atlas = new GeometryAtlas(gl, new GlState(gl));
  atlas.setUp();
  const geometries = new Geometries();
  const seeds = new Map<number, number>();
  for (let i = 0; i < 20; i++) {
    const handle = geometries.add(shape(i + 1, 100 + i));
    seeds.set(handle.id, i + 1);
  }

  atlas.place(geometries);
  for (const id of [...seeds.keys()].slice(0, 10)) {
    geometries.remove(id);
    seeds.delete(id);
  }

  atlas.place(geometries);
  atlas.setUp();
  atlas.repack(geometries);
  check(atlas, geometries, seeds);
  assert.equal(Math.min(...[...seeds.keys()].map((id) => atlas.places[id]?.vertexStart ?? 0)), 0);
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
      const handle = geometries.add(shape(seed, 1024));
      seeds.set(handle.id, seed);
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
    const handle = geometries.add(shape(900 + i, 300));
    seeds.set(handle.id, 900 + i);
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
  const kept = geometries.add(shape(1, 100));
  atlas.place(geometries);
  const first = geometries.add(shape(2, 200));
  geometries.remove(first.id);
  const second = geometries.add(shape(3, 50));
  assert.equal(second.id, first.id);
  atlas.place(geometries);
  check(
    atlas,
    geometries,
    new Map([
      [kept.id, 1],
      [second.id, 3],
    ]),
  );
  const page = atlas.pages[0];
  assert.equal(page.live, 150);
  // Letting both go leaves the page empty, filled again from its start.
  geometries.remove(kept.id);
  geometries.remove(second.id);
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
        seeds.set(geometries.add(shape(seed, count)).id, seed);
      } else if (roll < 0.85) {
        const id = ids[Math.floor(random() * ids.length)];
        geometries.remove(id);
        seeds.delete(id);
      } else {
        // The same lengths, new values: copied again where it lies.
        const id = ids[Math.floor(random() * ids.length)];
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
