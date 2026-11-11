import { check, color, create, rejects, shader } from "./context.ts";

export function vertexBindings() {
  const { backend: c, gl, live } = create();
  const methods = [
    "vertexAttribPointer",
    "enableVertexAttribArray",
    "disableVertexAttribArray",
  ] as const;
  const raw = gl as unknown as Record<string, (...args: never[]) => unknown>;
  const saved = methods.map((name) => raw[name]);
  const calls = [0, 0, 0];
  methods.forEach((name, i) => {
    raw[name] = (...args) => {
      calls[i]++;
      return saved[i].apply(gl, args);
    };
  });
  try {
    c.configure(32, 32);
    c.setDepth(false, "always");
    const positions = [-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1];
    const floats = new Float32Array(24);
    for (let i = 0; i < 3; i++) {
      floats.set(positions.slice(i * 4, i * 4 + 4), i * 8);
      floats.set([1, 0, 0, 1], i * 8 + 4);
    }

    const vertices = c.createBuffer(3, 8);
    vertices.upload(floats, 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const vertex = (position: number) => {
      const bytes = new Uint8Array(55);
      bytes.set(shader(false));
      bytes.set(bytes.subarray(7, 31), 31);
      const fields = new DataView(bytes.buffer);
      fields.setUint32(15, 0xe4000000 | position, true);
      fields.setUint32(35, 0x040f0000, true);
      fields.setUint32(39, 0xe4000001, true);
      return bytes;
    };
    const fragment = shader(true);
    new DataView(fragment.buffer).setUint32(19, 4, true);
    const first = c.createProgram();
    const second = c.createProgram();
    first.upload(vertex(0), fragment);
    second.upload(vertex(2), fragment);
    c.setProgram(first);
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "float4");
    const draw = (expected: number[], pixel: string) => {
      calls.fill(0);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(
        calls.every((n, i) => n === expected[i]),
        `vertex calls ${calls}, expected ${expected}`,
      );
      check(color(c.read(), c.width / 2, c.height / 2, c.width) === pixel, "stale vertex binding");
      check(gl.getError() === gl.NO_ERROR, "vertex reuse polluted GL state");
    };
    draw([2, 2, 0], "ffff0000");
    draw([0, 0, 0], "ffff0000");
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "float4");
    draw([0, 0, 0], "ffff0000");
    c.setVertex(1, vertices, 5, "float3");
    draw([1, 0, 0], "ff0000ff");

    const packed = c.createBuffer(3, 5);
    const bytes = new Uint8Array(60);
    const data = new Float32Array(bytes.buffer);
    const words = new Uint32Array(bytes.buffer);
    for (let i = 0; i < 3; i++) {
      data.set(positions.slice(i * 4, i * 4 + 4), i * 5);
      words[i * 5 + 4] = 0xff00ff00;
    }

    packed.uploadBytes(bytes, 0, 0, 3);
    c.setVertex(0, packed, 0, "float4");
    c.setVertex(1, packed, 4, "bytes4");
    draw([2, 0, 0], "ff00ff00");
    c.setVertex(2, packed, 0, "float4");
    c.setProgram(second);
    draw([1, 1, 1], "ff00ff00");
    c.setProgram(first);
    draw([0, 1, 1], "ff00ff00");
    first.upload(vertex(2), fragment);
    draw([0, 1, 1], "ff00ff00");
    first.upload(vertex(0), fragment);
    draw([0, 1, 1], "ff00ff00");

    for (let i = 0; i < 3; i++) {
      words[i * 5 + 4] = 0xffff0000;
    }

    packed.uploadBytes(bytes, 0, 0, 3);
    // Uploading another buffer changes ARRAY_BUFFER, but the VAO retains its vertex pointers.
    vertices.upload(floats, 0, 3);
    draw([0, 0, 0], "ff0000ff");
    c.present();
    c.configure(64, 64);
    draw([0, 0, 0], "ff0000ff");
    indices.upload([3], 0, 1);
    rejects(() => c.draw(indices, 0, 1));
    indices.upload([0], 0, 1);
    draw([0, 0, 0], "ff0000ff");
    c.setVertex(0, packed, 5, "float4");
    rejects(() => c.draw(indices, 0, 1));
    c.setVertex(0, packed, 0, "float4");
    draw([1, 0, 0], "ff0000ff");
    c.setVertex(1, null, 0, "float4");
    rejects(() => c.draw(indices, 0, 1));
    c.setVertex(1, packed, 4, "bytes4");
    draw([1, 0, 0], "ff0000ff");
    packed.dispose();
    rejects(() => c.draw(indices, 0, 1));
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "float4");
    draw([2, 0, 0], "ffff0000");

    return { passed: true };
  } finally {
    methods.forEach((name, i) => {
      raw[name] = saved[i];
    });
    c.dispose();
    check(live.size === 0, "vertex cache retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
