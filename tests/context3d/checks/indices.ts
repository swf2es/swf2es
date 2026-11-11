import type { Buffer3D } from "@swf2es/context3d";
import { check, color, create, rejects, shader } from "./context.ts";

export function indexBindings() {
  const { backend: c, gl, live } = create();
  const bind = gl.bindBuffer;
  let calls = 0;
  gl.bindBuffer = (target, buffer) => {
    if (target === gl.ELEMENT_ARRAY_BUFFER) {
      calls++;
    }
    bind.call(gl, target, buffer);
  };
  try {
    c.configure(32, 32);
    c.setDepth(false, "always");
    const positions = [
      -1, -1, 0.5, 1, 0, -1, 0.5, 1, -0.5, 1, 0.5, 1, 0, -1, 0.5, 1, 1, -1, 0.5, 1, 0.5, 1, 0.5, 1,
    ];
    const vertices = c.createBuffer(6, 4);
    vertices.upload(positions, 0, 6);
    c.setVertex(0, vertices, 0, "float4");
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    const left = c.createBuffer(3, 0);
    const right = c.createBuffer(3, 0);
    left.upload([0, 1, 2], 0, 3);
    right.upload([3, 4, 5], 0, 3);
    const draw = (
      indices: Buffer3D,
      expectedCalls: number,
      side: number,
      foreground = "ffff0000",
    ) => {
      calls = 0;
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(calls === expectedCalls, `index binds ${calls}, expected ${expectedCalls}`);
      const pixels = c.read();
      for (let i = 0; i < 2; i++) {
        check(
          color(pixels, (c.width * (i * 2 + 1)) / 4, c.height / 2, c.width) ===
            (i === side ? foreground : "ff000000"),
          "stale index binding",
        );
      }
      check(gl.getError() === gl.NO_ERROR, "index reuse polluted GL state");
    };
    draw(left, 1, 0);
    draw(left, 0, 0);
    draw(right, 1, 1);
    draw(right, 0, 1);
    draw(left, 1, 0);

    const unused = c.createBuffer(3, 0);
    draw(left, 1, 0);
    unused.upload([3, 4, 5], 0, 3);
    draw(left, 1, 0);
    unused.uploadBytes(new Uint8Array([3, 0, 4, 0, 5, 0]), 0, 0, 3);
    draw(left, 1, 0);
    unused.uploadBytes(new Uint8Array(0), 0, 0, 0);
    draw(left, 1, 0);
    rejects(() => unused.upload([0], 3, 1));
    draw(left, 1, 0);
    vertices.upload(positions, 0, 6);
    draw(left, 0, 0);
    vertices.uploadBytes(new Uint8Array(new Float32Array(positions).buffer), 0, 0, 6);
    draw(left, 0, 0);

    // The nested draw warms the cache before uploadBuffer binds a different index buffer.
    unused.upload(
      {
        length: 3,
        get 0() {
          draw(left, 0, 0);
          return 3;
        },
        1: 4,
        2: 5,
      },
      0,
      3,
    );
    draw(left, 1, 0);
    rejects(() =>
      unused.upload(
        {
          length: 3,
          get 0(): number {
            throw new Error("source");
          },
        },
        0,
        3,
      ),
    );
    draw(left, 1, 0);
    right.upload([6], 0, 1);
    rejects(() => c.draw(right, 0, 1));
    draw(left, 1, 0);
    right.upload([3], 0, 1);
    draw(right, 1, 1);
    right.dispose();
    rejects(() => c.draw(right, 0, 1));
    draw(left, 1, 0);
    unused.dispose();
    draw(left, 0, 0);

    const target = c.createTexture(32, 32);
    target.upload(new Uint32Array(1024).fill(0xff0000ff));
    c.setRenderTarget(target, false, 0, 4);
    calls = 0;
    // The seeding copy draws arrays through the same VAO; its index binding survives.
    c.draw(left, 0, 1);
    check(calls === 0, "MSAA seed discarded the index binding");
    c.setRenderTarget(null);
    const fragment = shader(true);
    const fields = new DataView(fragment.buffer);
    fields.setUint32(7, 0x28, true);
    fields.setUint32(23, 0, true);
    fields.setUint32(27, 5, true);
    const sample = c.createProgram();
    sample.upload(shader(false), fragment);
    c.setProgram(sample);
    c.setTexture(0, target);
    c.setConstants("fragment", 0, [0.25, 0.5, 0, 1], 1);
    draw(left, 0, 0);
    c.setConstants("fragment", 0, [0.75, 0.5, 0, 1], 1);
    draw(left, 0, 0, "ff0000ff");
    c.setTexture(0, null);
    c.setProgram(program);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    draw(left, 0, 0);
    c.present();
    draw(left, 0, 0);
    c.configure(64, 64);
    draw(left, 0, 0);
    program.upload(shader(false), shader(true));
    draw(left, 0, 0);

    return { passed: true };
  } finally {
    gl.bindBuffer = bind;
    c.dispose();
    check(live.size === 0, "index cache retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
