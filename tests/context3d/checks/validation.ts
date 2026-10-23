import type { Buffer3D } from "@swf2es/context3d";
import type { BufferState, VertexBinding } from "../../../packages/context3d/dist/webgl/buffers.js";
import { check, color, create, rejects, shader } from "./context.ts";

export function drawValidation() {
  const owned = create();
  const c = owned.backend;
  const state = c as unknown as {
    buffers: Map<Buffer3D, BufferState>;
    vertices: (VertexBinding | null)[];
  };
  let reads = 0;
  const watch = (buffer: Buffer3D) => {
    const value = state.buffers.get(buffer);
    check(value?.indices, "missing validation indices");
    value.indices = new Proxy(value.indices, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++;
        }
        const result = Reflect.get(target, key, target);
        return typeof result === "function" ? result.bind(target) : result;
      },
    });
    return value;
  };

  try {
    c.configure(32, 32);
    const vertex = new Uint8Array(7 + 9 * 24);
    vertex.set(shader(false).subarray(0, 7));
    const fields = new DataView(vertex.buffer);
    for (let i = 0; i < 8; i++) {
      vertex.set(shader(false).subarray(7), 7 + i * 24);
      fields.setUint32(11 + i * 24, 0x020f0000, true);
      fields.setUint32(15 + i * 24, 0xe4000000 | i, true);
    }
    vertex.set(shader(false).subarray(7), 7 + 8 * 24);
    fields.setUint32(19 + 8 * 24, 2, true);
    const program = c.createProgram();
    program.upload(vertex, shader(true));
    c.setProgram(program);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    const vertices = c.createBuffer(4, 4);
    vertices.upload([-1, -1, 0, 1, 1, -1, 0, 1, 0, 1, 0, 1, 1, -1, 0, 1], 0, 4);
    for (let slot = 0; slot < 8; slot++) {
      c.setVertex(slot, vertices, 0, "float4");
    }
    const indices = c.createBuffer(6000, 0);
    const values = new Uint16Array(6000);
    for (let i = 0; i < values.length; i++) {
      values[i] = i % 3;
    }
    indices.upload(values, 0, values.length);
    watch(indices);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, -1);
    check(reads === values.length, "cold validation scanned indices more than once");
    const handles = owned.created;
    reads = 0;
    for (let i = 0; i < 4; i++) {
      c.draw(indices, 0, -1);
    }
    check(reads === 0 && owned.created === handles, "warm validation scanned or allocated handles");
    check(color(c.read(), 16, 16, 32) === "ffff0000", "cached draw changed pixels");
    indices.upload([4], 0, 1);
    rejects(() => c.draw(indices, 0, -1));
    indices.upload([0], 0, 1);
    c.draw(indices, 0, -1);
    c.draw(indices, 3, 1);

    const sparse = c.createBuffer(4, 4);
    sparse.upload([-1, -1, 0, 1], 0, 1);
    sparse.upload([1, -1, 0, 1], 3, 1);
    for (let slot = 0; slot < 8; slot++) {
      c.setVertex(slot, sparse, 0, "float4");
    }
    const partial = c.createBuffer(4, 0);
    partial.upload([0, 3, 3], 0, 3);
    const partialState = watch(partial);
    c.draw(partial, 0, -1);
    reads = 0;
    c.draw(partial, 0, -1);
    check(reads === 0, "sparse warm validation was not cached");
    partial.upload([2], 1, 1);
    rejects(() => c.draw(partial, 0, -1));
    sparse.upload([0, 1, 0, 1], 2, 1);
    c.draw(partial, 0, -1);
    rejects(() => c.draw(partial, 1, 1));
    partial.upload([0], 3, 1);
    c.draw(partial, 1, 1);
    partial.dispose();
    for (let i = 0; i < state.vertices.length; i++) {
      check(state.vertices[i]?.checkedIndex !== partialState, "cache retained disposed indices");
    }
    check(owned.gl.getError() === owned.gl.NO_ERROR, "GL error after validation checks");
    return { passed: true };
  } finally {
    c.dispose();
    check(owned.live.size === 0, "validation cache retained GPU handles");
    owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
