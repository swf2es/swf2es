import { check, color, create, rejects, shader } from "./context.ts";

export function drawState() {
  const { backend: c, gl, live } = create();
  const names = [
    "useProgram",
    "bindFramebuffer",
    "viewport",
    "bindVertexArray",
    "uniform1f",
    "uniform1i",
  ] as const;
  const raw = gl as unknown as Record<string, (...args: never[]) => unknown>;
  const saved = names.map((name) => raw[name]);
  const calls = new Array(names.length).fill(0);
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
    const fragment = shader(true);
    const first = c.createProgram();
    const second = c.createProgram();
    first.upload(vertex, fragment);
    second.upload(vertex, fragment);
    c.setProgram(first);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    const draw = (expected: string) => {
      calls.fill(0);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(color(c.read(), c.width / 2, c.height / 2, c.width) === expected, "stale draw state");
      check(gl.getError() === gl.NO_ERROR, "cached draw polluted GL state");
    };
    const unchanged = () =>
      check(
        calls.every((n) => n === 0),
        `redundant draw state calls ${calls}`,
      );
    draw("ffff0000");
    draw("ffff0000");
    unchanged();
    c.setProgram(second);
    draw("ffff0000");
    check(calls[0] === 1 && calls[4] === 1, "new program kept unset uniforms");
    c.setProgram(first);
    draw("ffff0000");
    check(calls[0] === 1 && calls[4] === 0, "program switch lost its target orientation");
    first.upload(vertex, fragment);
    draw("ffff0000");
    check(calls[0] === 1 && calls[4] === 1, "replacement reused retired program state");
    const bad = fragment.slice();
    bad[7] = 0xff;
    rejects(() => first.upload(vertex, bad));
    draw("ffff0000");
    c.present();
    draw("ffff0000");
    c.configure(64, 64);
    draw("ffff0000");
    draw("ffff0000");
    unchanged();

    const green = c.createTexture(4, 4);
    green.upload(new Uint32Array(16).fill(0xff00ff00));
    // The unassigned sampler default (unit 0) must differ from the shader's unit.
    const red = c.createTexture(4, 4);
    red.upload(new Uint32Array(16).fill(0xffff0000));
    const sampled = shader(true);
    const code = new DataView(sampled.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(23, 3, true);
    code.setUint32(27, 5, true);
    first.upload(vertex, sampled);
    c.setTexture(3, green);
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    draw("ff00ff00");
    check(calls[5] === 1, "sampler was not assigned to its unit");
    draw("ff00ff00");
    unchanged();
    c.setTexture(3, null);
    c.setProgram(second);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    draw("ffff0000");
    c.setTexture(3, green);
    c.setProgram(first);
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    draw("ff00ff00");
    check(calls[5] === 0, "program switch reassigned an unchanged sampler");
    code.setUint32(23, 2, true);
    first.upload(vertex, sampled);
    c.setTexture(3, null);
    c.setTexture(2, green);
    draw("ff00ff00");
    check(calls[5] === 1, "replacement lost its new sampler unit");

    const target = c.createTexture(16, 8);
    c.setRenderTarget(target);
    calls.fill(0);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(calls[4] === 1, "texture target kept the back-buffer orientation");
    // Readback temporarily binds the back buffer while the texture remains selected.
    check(color(c.read(), 32, 32, 64) === "ff00ff00", "texture draw changed back-buffer contents");
    calls.fill(0);
    c.draw(indices, 0, 1);
    check(calls[4] === 0, "readback changed the logical target orientation");
    c.setRenderTarget(null);
    c.setTexture(2, target);
    draw("ff00ff00");
    check(calls[4] === 1, "back buffer kept the texture orientation");
    c.setTexture(2, green);
    c.setRenderTarget(target, false, 0, 4);
    c.draw(indices, 0, 1);
    c.setRenderTarget(null);
    c.setTexture(2, target);
    draw("ff00ff00");
    c.configure(32, 32, false, 4);
    draw("ff00ff00");
    c.present();
    draw("ff00ff00");
    c.configure(32, 32);
    draw("ff00ff00");
    draw("ff00ff00");
    unchanged();

    return { passed: true };
  } finally {
    names.forEach((name, i) => {
      raw[name] = saved[i];
    });
    c.dispose();
    check(live.size === 0, "draw cache retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
