import { encodeDxt } from "@swf2es/context3d";
import { check, color, create, rejects, shader } from "./context.ts";

export function textureBindings() {
  const { backend: c, gl, live } = create();
  const names = ["activeTexture", "bindTexture", "bindSampler"] as const;
  const raw = gl as unknown as Record<string, (...args: never[]) => unknown>;
  const saved = names.map((name) => raw[name]);
  const calls = [0, 0, 0];
  names.forEach((name, i) => {
    raw[name] = (...args) => {
      calls[i]++;
      return saved[i].apply(gl, args);
    };
  });
  try {
    c.configure(32, 32);
    c.setDepth(false, "always");
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const vertex = shader(false);
    const fragment = (slot: number, cube = false) => {
      const bytes = shader(true);
      const fields = new DataView(bytes.buffer);
      fields.setUint32(7, 0x28, true);
      fields.setUint32(23, slot, true);
      fields.setUint32(27, cube ? 0x1005 : 5, true);
      return bytes;
    };
    const flat = c.createProgram();
    const cubed = c.createProgram();
    flat.upload(vertex, fragment(0));
    cubed.upload(vertex, fragment(0, true));
    c.setProgram(flat);
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    const green = c.createTexture(4, 4);
    green.upload(new Uint32Array(16).fill(0xff00ff00));
    const red = c.createTexture(4, 4);
    red.upload(new Uint32Array(16).fill(0xffff0000));
    c.setTexture(0, green);
    const draw = (expected: string, bindings?: number[]) => {
      calls.fill(0);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(
        color(c.read(), c.width / 2, c.height / 2, c.width) === expected,
        "stale texture binding",
      );
      if (bindings) {
        check(
          calls.every((n, i) => n === bindings[i]),
          `texture calls ${calls}, expected ${bindings}`,
        );
      }
      check(gl.getError() === gl.NO_ERROR, "texture reuse polluted GL state");
    };
    draw("ff00ff00", [1, 1, 1]);
    draw("ff00ff00", [0, 0, 0]);
    c.setTexture(0, green);
    draw("ff00ff00", [0, 0, 0]);
    c.setTexture(0, red);
    draw("ffff0000", [1, 1, 1]);
    c.setTexture(0, green);
    c.setSampler(0, "clamp", "linear", "mipnone");
    draw("ff00ff00", [1, 1, 1]);
    draw("ff00ff00", [0, 0, 0]);
    c.setSampler(0, "clamp", "linear", "mipnearest");
    rejects(() => c.draw(indices, 0, 1));
    c.setSampler(0, "clamp", "linear", "mipnone");
    draw("ff00ff00", [1, 1, 1]);

    const other = c.createTexture(4, 4);
    draw("ff00ff00");
    other.upload(new Uint32Array(16).fill(0xff0000ff));
    draw("ff00ff00", [1, 1, 1]);
    other.uploadBytes(new Uint8Array(64).fill(255), 0);
    draw("ff00ff00", [1, 1, 1]);
    rejects(() => other.upload(new Uint32Array(1)));
    draw("ff00ff00");

    const replacement = c.createTexture(4, 4);
    replacement.upload(new Uint32Array(16).fill(0xffff0000));
    draw("ff00ff00");
    // Disposal unbinds the selected slot even if that texture was never drawn there.
    c.setTexture(0, replacement);
    replacement.dispose();
    c.setTexture(0, green);
    draw("ff00ff00", [1, 1, 1]);

    // A callback can warm the cache before the compressed upload binds its own texture.
    const compressed = c.createTexture(4, 4, false, "compressedAlpha");
    c.setDxtEncoder(() => {
      draw("ff00ff00");
      return null;
    });
    compressed.upload(new Uint32Array(16).fill(0xffff0000));
    draw("ff00ff00", [1, 1, 1]);
    c.setDxtEncoder(() => null);
    compressed.uploadCompressed(encodeDxt(new Uint8Array(64).fill(255), true, 4, 4));
    draw("ff00ff00", [1, 1, 1]);

    const cube = c.createTexture(4, 4, true);
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level < cube.levels; level++) {
        cube.upload(new Uint32Array((4 >> level) ** 2).fill(0xff0000ff), level, face);
      }
    }
    c.setTexture(0, cube);
    rejects(() => c.draw(indices, 0, 1));
    c.setProgram(cubed);
    c.setConstants("fragment", 0, [1, 0, 0, 0], 1);
    draw("ff0000ff", [1, 1, 1]);
    draw("ff0000ff", [0, 0, 0]);
    c.setProgram(flat);
    c.setTexture(0, green);
    draw("ff00ff00", [1, 1, 1]);
    c.setProgram(cubed);
    c.setTexture(0, cube);
    draw("ff0000ff", [1, 1, 1]);
    c.setTexture(0, null);
    c.setTexture(0, cube);
    draw("ff0000ff", [1, 1, 1]);

    c.setTexture(0, null);
    cubed.upload(vertex, fragment(3, true));
    c.setTexture(3, cube);
    draw("ff0000ff", [1, 1, 1]);
    draw("ff0000ff", [0, 0, 0]);
    c.setSampler(3, "repeat", "nearest", "mipnone");
    rejects(() => c.draw(indices, 0, 1));
    c.setSampler(3, "clamp", "nearest", "mipnone");
    draw("ff0000ff", [1, 1, 1]);
    cube.dispose();
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(3, green);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(3, null);
    c.setTexture(0, green);
    c.setProgram(flat);
    draw("ff00ff00");

    const target = c.createTexture(32, 32);
    target.upload(new Uint32Array(1024).fill(0xffff0000));
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    c.setRenderTarget(target, false, 0, 4);
    // Without clear, the copy shader seeds the MSAA target through texture unit zero.
    c.draw(indices, 0, 1);
    c.setRenderTarget(null);
    c.setTexture(0, target);
    draw("ff00ff00");
    c.setTexture(0, green);
    draw("ff00ff00");
    c.present();
    draw("ff00ff00");
    c.configure(64, 64);
    draw("ff00ff00");
    draw("ff00ff00", [0, 0, 0]);

    return { passed: true };
  } finally {
    names.forEach((name, i) => {
      raw[name] = saved[i];
    });
    c.dispose();
    check(live.size === 0, "texture reuse retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
