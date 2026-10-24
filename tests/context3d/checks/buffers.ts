import type { VertexFormat } from "@swf2es/context3d";

import { check, color, create, rejects, shader } from "./context.ts";

export async function vertexFormats() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 5);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const bytes = new Uint8Array(60);
    const view = new DataView(bytes.buffer);
    const xy = [-0.75, -0.75, 0.75, -0.75, 0, 0.75];
    for (let i = 0; i < 3; i++) {
      view.setFloat32(i * 20, xy[i * 2], true);
      view.setFloat32(i * 20 + 4, xy[i * 2 + 1], true);
      view.setFloat32(i * 20 + 8, 0.5, true);
      view.setFloat32(i * 20 + 12, 1, true);
    }
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    vertex.set(vertex.subarray(7, 31), 31);
    const code = new DataView(vertex.buffer);
    code.setUint32(35, 0x040f0000, true);
    code.setUint32(39, 0xe4000001, true);
    const fragment = shader(true);
    new DataView(fragment.buffer).setUint32(19, 4, true);
    const program = c.createProgram();
    program.upload(vertex, fragment);
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "bytes4");
    const readback = c.read();
    const allocated = owned.created;
    for (let iteration = 0; iteration < 24; iteration++) {
      for (let i = 0; i < 3; i++) {
        const at = i * 20 + 16;
        bytes[at] = iteration;
        bytes[at + 1] = 255 - iteration;
        bytes[at + 2] = 128 + iteration;
        bytes[at + 3] = 255;
      }
      vertices.uploadBytes(bytes, 0, 0, 3);
      c.setVertex(1, vertices, 3, "float1");
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(color(c.read(), 16, 16, 32) === "ffff0000", "float default components changed");
      c.setVertex(1, vertices, 4, "bytes4");
      c.draw(indices, 0, 1);
      check(c.read() === readback, "vertex formats replaced readback storage");
      const expected =
        (0xff000000 | (iteration << 16) | ((255 - iteration) << 8) | (128 + iteration)) >>> 0;
      check(
        color(readback, 16, 16, 32) === expected.toString(16),
        "packed channels not normalized",
      );
      rejects(() => c.setVertex(1, vertices, 4, "invalid" as VertexFormat));
      c.draw(indices, 0, 1);
      check(
        color(c.read(), 16, 16, 32) === expected.toString(16),
        "invalid format replaced binding",
      );
      for (const offset of [-1, 5, 6]) {
        c.setVertex(1, vertices, offset, "bytes4");
        rejects(() => c.draw(indices, 0, 1));
      }
      c.setVertex(1, vertices, 2, "float4");
      rejects(() => c.draw(indices, 0, 1));
      check(color(c.read(), 16, 16, 32) === expected.toString(16), "invalid offset changed pixels");
      check(owned.created === allocated, "vertex formats allocated GPU handles");
    }
    c.setVertex(1, vertices, 4, "bytes4");
    c.configure(64, 64);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff17e897", "resize lost packed format");
    const other = create();
    try {
      rejects(() => other.backend.setVertex(1, vertices, 4, "bytes4"));
    } finally {
      other.backend.dispose();
      check(other.live.size === 0, "foreign packed-buffer check retained resources");
      other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    vertices.dispose();
    rejects(() => c.draw(indices, 0, 1));
    check(gl.getError() === gl.NO_ERROR, "vertex format validation polluted GL state");
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "packed vertices retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function bufferBytes() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(6, 4);
    const indices = c.createBuffer(6, 0);
    // Exercise both a view's byteOffset and an unaligned offset inside that view.
    const vertexSource = new Uint8Array(new ArrayBuffer(64), 5, 51);
    const floats = new DataView(vertexSource.buffer, 8, 48);
    const values = [-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1];
    const indexSource = new Uint8Array(new ArrayBuffer(16), 2, 9);
    const indexValues = new Uint8Array([3, 0, 4, 0, 5, 0]);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);

    // Raw uploads preserve float bit patterns without converting through JS Numbers.
    const raw = c.createBuffer(2, 1);
    const bits = new Uint8Array([0xa5, 0, 0, 0, 128, 1, 0, 192, 127]);
    const stored = new Uint8Array(8);
    raw.uploadBytes(bits, 1, 0, 2);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, stored);
    for (let i = 0; i < stored.length; i++) {
      check(stored[i] === bits[i + 1], "raw vertex upload changed float bits");
    }

    const allocated = owned.created;
    const pixels = c.read();
    const upload = gl.bufferSubData;
    let uploads = 0;
    gl.bufferSubData = (
      target: number,
      offset: number,
      data: AllowSharedBufferSource,
      sourceOffset: number = 0,
      length?: number,
    ) => {
      uploads++;
      check(data === vertexSource || data === indexSource, "byte upload made a new view");
      check(ArrayBuffer.isView(data), "byte upload expected a view");
      upload.call(gl, target, offset, data, sourceOffset, length);
    };
    try {
      for (let iteration = 0; iteration < 24; iteration++) {
        for (let i = 0; i < values.length; i++) {
          floats.setFloat32(i * 4, values[i], true);
        }
        indexSource.set(indexValues, 3);
        vertices.uploadBytes(vertexSource, 3, 3, 3);
        indices.uploadBytes(indexSource, 3, 0, 3);
        const before = uploads;
        vertices.uploadBytes(vertexSource, 0, 6, 0);
        indices.uploadBytes(indexSource, 0, 6, 0);
        check(uploads === before, "empty upload sent data to WebGL");
        rejects(() => vertices.uploadBytes(vertexSource, 4, 3, 3));
        rejects(() => indices.uploadBytes(indexSource, 3, 5, 3));
        check(uploads === before, "invalid upload changed GPU storage");
        vertexSource.fill(0);
        indexSource.fill(255);
        c.clear(0, 0, 1, 1);
        c.draw(indices, 0, 1);
        check(c.read() === pixels, "byte uploads replaced readback storage");
        check(color(pixels, 16, 16, 32) === "ffff0000", "upload retained source bytes");
      }
      check(uploads === 48, "unexpected number of GPU uploads");
      check(owned.created === allocated, "byte uploads allocated GPU handles");
    } finally {
      gl.bufferSubData = upload;
    }

    // Updating byte indices must also update the CPU bounds checks used by draw().
    indexSource.fill(255);
    indices.uploadBytes(indexSource, 3, 0, 3);
    rejects(() => c.draw(indices, 0, 1));
    const fresh = c.createBuffer(3, 0);
    fresh.uploadBytes(indexSource, 0, 0, 0);
    rejects(() => c.draw(fresh, 0, 1));
    const other = create();
    try {
      rejects(() => other.backend.setVertex(0, vertices, 0, "float4"));
    } finally {
      other.backend.dispose();
      check(other.live.size === 0, "foreign byte-buffer check retained resources");
      other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    check(gl.getError() === gl.NO_ERROR, "byte uploads polluted GL state");
    vertices.dispose();
    rejects(() => vertices.uploadBytes(vertexSource, 3, 0, 3));
    c.dispose();
    rejects(() => indices.uploadBytes(indexSource, 3, 0, 3));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "byte uploads retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
