import { check, color, create, rejects, shader } from "./context.ts";

/** Uniform values survive program switches, but a newly linked program starts afresh. */
export async function uniformUploads() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  const upload = gl.uniform4fv;
  let calls = 0;
  gl.uniform4fv = (...args) => {
    calls++;
    upload.apply(gl, args);
  };
  try {
    c.configure(32, 32);
    c.setDepth(false, "always");
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const vertex = shader(false);
    const fragment = shader(true);
    const sparse = fragment.slice();
    new DataView(sparse.buffer).setUint32(15, 0xe4000005, true);
    const first = c.createProgram();
    const second = c.createProgram();
    first.upload(vertex, fragment);
    second.upload(vertex, fragment);
    const red = [1, 0, 0, 1];
    const green = [0, 1, 0, 1];
    c.setConstants("fragment", 0, red, 1);
    c.setConstants("fragment", 5, green, 1);
    const draw = (uploads: number, expected?: string) => {
      calls = 0;
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(calls === uploads, `expected ${uploads} uniform uploads, got ${calls}`);
      if (expected) {
        const actual = color(c.read(), c.width / 2, c.height / 2, c.width);
        check(actual === expected, `program constants produced ${actual}, expected ${expected}`);
      }
    };
    c.setProgram(first);
    draw(1, "ffff0000");
    draw(0, "ffff0000");
    c.setProgram(second);
    draw(1, "ffff0000");
    c.setProgram(first);
    draw(0, "ffff0000");
    second.upload(vertex, sparse);
    c.setConstants("fragment", 0, red, 1);
    draw(1, "ffff0000");
    c.setConstants("fragment", 9, green, 1);
    draw(0, "ffff0000");
    c.setProgram(second);
    draw(1, "ff00ff00");
    c.setConstants("fragment", 0, green, 1);
    draw(0, "ff00ff00");
    c.setProgram(first);
    draw(1, "ff00ff00");
    c.setProgram(second);
    draw(0, "ff00ff00");
    c.setProgram(first);
    draw(0, "ff00ff00");

    first.upload(vertex, fragment);
    draw(1, "ff00ff00");
    const malformed = fragment.slice();
    malformed[7] = 0xff;
    rejects(() => first.upload(vertex, malformed));
    draw(0, "ff00ff00");
    c.configure(64, 64);
    draw(0, "ff00ff00");

    // Every explicit write reaches GL, including equal values and the sign of zero.
    c.setConstants("fragment", 0, [-0, 1, 0, 1], 1);
    draw(1, "ff00ff00");
    c.setConstants("fragment", 0, [-0, 1, 0, 1], 1);
    draw(1, "ff00ff00");
    c.setConstants("fragment", 0, [0, 1, 0, 1], 1);
    draw(1, "ff00ff00");
    c.setConstants("fragment", 0, [Number.NaN, 1, 0, 1], 1);
    draw(1);
    draw(0);
    c.setConstants("fragment", 0, [1 + 2 ** -30, 0, 0, 1], 1);
    draw(1, "ffff0000");
    c.setConstants("fragment", 0, red, 1);
    draw(1, "ffff0000");

    // The public ArrayLike setter can fail after earlier components were already written.
    rejects(() =>
      c.setConstants(
        "fragment",
        0,
        {
          length: 4,
          0: 0,
          1: 1,
          get 2(): number {
            throw new Error("source failed");
          },
          3: 1,
        },
        1,
      ),
    );
    draw(1, "ff00ff00");
    draw(0, "ff00ff00");

    // A source getter can consume the partial bank before the setter finishes.
    c.setConstants(
      "fragment",
      0,
      {
        length: 4,
        get 0() {
          c.setConstants("fragment", 0, red, 1);
          draw(1, "ffff0000");
          return 0;
        },
        get 1() {
          draw(1, "ff000000");
          return 1;
        },
        2: 0,
        3: 1,
      },
      1,
    );
    draw(1, "ff00ff00");
    draw(0, "ff00ff00");
    check(gl.getError() === gl.NO_ERROR, "uniform reuse polluted GL state");

    return { passed: true };
  } finally {
    gl.uniform4fv = upload;
    c.dispose();
    check(live.size === 0, "uniform reuse retained GPU resources");
    if (!gl.isContextLost()) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}

export async function indirectConstants() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 5);
    vertices.upload([-0.75, -0.75, 0.5, 1, 5, 0.75, -0.75, 0.5, 1, 5, 0, 0.75, 0.5, 1, 5], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    c.setVertex(1, vertices, 4, "float1");
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    vertex.set(vertex.subarray(7, 31), 31);
    const code = new DataView(vertex.buffer);
    code.setUint32(35, 0x040f0000, true);
    code.setUint32(39, 0xe4000001, true);
    code.setUint32(43, 0x80000001, true);
    const fragment = shader(true);
    new DataView(fragment.buffer).setUint32(19, 4, true);
    const program = c.createProgram();
    program.upload(vertex, fragment);
    c.setProgram(program);
    const value = new Float32Array([0, 1, 0, 1]);
    const readback = c.read();
    const allocated = owned.created;
    const uniform = gl.uniform4fv.bind(gl);
    const location = gl.getUniformLocation.bind(gl);
    let queries = 0;
    let calls = 0;
    let bank: Float32Array | null = null;
    let bankMode = true;
    gl.getUniformLocation = (program, name) => {
      queries++;
      return location(program, name);
    };
    gl.uniform4fv = (location, data, offset, length) => {
      calls++;
      check(data instanceof Float32Array, "constant upload is not typed storage");
      check(data.length === 512, "constant upload allocated a temporary slice");
      check(!bank || data === bank, "draw replaced constant storage");
      bank = data;
      if (bankMode) {
        check(offset === undefined && length === undefined, "indexed draw did not upload one bank");
      } else {
        check(offset === 20 && length === 4, "direct-only draw stopped uploading sparse constants");
      }
      uniform(location, data, offset, length);
    };

    for (let iteration = 0; iteration < 32; iteration++) {
      value[1] = iteration & 1;
      value[2] = 1 - value[1];
      c.setConstants("vertex", 5, value, 1);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(c.read() === readback, "indexed draw replaced readback storage");
      check(
        color(readback, 16, 16, 32) === (value[1] ? "ff00ff00" : "ff0000ff"),
        "stale indexed constant",
      );
      check(calls === iteration + 1, "indexed draw made redundant uniform uploads");
      c.draw(indices, 0, 1);
      check(calls === iteration + 1, "unchanged indexed constants uploaded again");
      check(
        queries === 0 && owned.created === allocated,
        "indexed draw queried or allocated GPU state",
      );
    }

    const badFragment = fragment.slice();
    badFragment[7] = 0xff;
    rejects(() => program.upload(vertex, badFragment));
    check(queries === 0 && owned.created === allocated, "invalid shader allocated GPU state");
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "failed upload replaced indexed program");
    const direct = vertex.slice();
    const directCode = new DataView(direct.buffer);
    directCode.setUint32(39, 0xe4000005, true);
    directCode.setUint32(43, 1, true);
    program.upload(direct, fragment);
    bankMode = false;
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "direct replacement lost constants");
    program.upload(vertex, fragment);
    bankMode = true;
    c.configure(64, 64);
    value[0] = 1;
    value[1] = 0;
    c.setConstants("vertex", 5, value, 1);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(
      color(c.read(), 32, 32, 64) === "ffff0000",
      "indexed replacement or resize lost constants",
    );
    // Dead indexed reads can leave only a statically used prefix of the bank.
    const overwritten = new Uint8Array(79);
    overwritten.set(vertex);
    overwritten.set(direct.subarray(31), 55);
    program.upload(overwritten, fragment);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "optimized bank prefix lost constants");
    program.dispose();
    rejects(() => c.draw(indices, 0, 1));
    check(gl.getError() === gl.NO_ERROR, "indexed constants polluted GL state");

    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "indexed constants retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
