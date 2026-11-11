import { check, create, rejects, shader } from "./context.ts";

export function pipelineState() {
  const { backend: c, gl, live } = create();
  const names = ["depthMask", "depthFunc", "blendFunc", "cullFace", "enable", "disable"] as const;
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
    c.configure(32, 32, true, 4);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setConstants("fragment", 0, [0.5, 0, 0, 0.5], 1);
    const pixel = (expected: number[]) => {
      const data = c.read();
      const at = ((c.height / 2) * c.width + c.width / 2) * 4;
      check(
        expected.every((n, i) => Math.abs(data[at + i] - n) <= 1),
        `pipeline pixel ${Array.from(data.subarray(at, at + 4))}, expected ${expected}`,
      );
      check(gl.getError() === gl.NO_ERROR, "pipeline reuse polluted GL state");
    };
    const draw = (expected: number[]) => {
      c.clear(0, 0, 1, 1);
      c.draw(indices, 0, 1);
      pixel(expected);
    };
    const unchanged = (apply: () => void) => {
      calls.fill(0);
      apply();
      check(
        calls.every((n) => n === 0),
        `repeated pipeline calls ${calls}`,
      );
    };
    const apply = () => {
      c.setDepth(false, "always");
      c.setBlend("one", "oneMinusSourceAlpha");
      c.setCulling("front");
    };
    apply();
    unchanged(apply);
    const purple = [128, 0, 128, 255];
    const blue = [0, 0, 255, 255];
    draw(purple);
    // A clear temporarily enables depth writes, then restores the selected mask.
    unchanged(apply);
    check(gl.getParameter(gl.DEPTH_WRITEMASK) === false, "clear retained its depth-write override");
    draw(purple);

    c.setBlend("one", "one");
    unchanged(() => c.setBlend("one", "one"));
    draw([128, 0, 255, 255]);
    c.setBlend("one", "zero");
    unchanged(() => c.setBlend("one", "zero"));
    draw([128, 0, 0, 128]);
    apply();
    draw(purple);
    c.setCulling("back");
    unchanged(() => c.setCulling("back"));
    draw(blue);
    c.setCulling("frontAndBack");
    draw(blue);
    c.setCulling("none");
    unchanged(() => c.setCulling("none"));
    draw(purple);
    apply();
    c.setDepth(false, "never");
    unchanged(() => c.setDepth(false, "never"));
    draw(blue);
    c.setDepth(true, "less");
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    unchanged(() => c.setDepth(true, "less"));
    c.setConstants("fragment", 0, [0, 1, 0, 1], 1);
    c.draw(indices, 0, 1);
    pixel(purple);
    c.setDepth(true, "equal");
    c.draw(indices, 0, 1);
    pixel([0, 255, 0, 255]);
    c.setConstants("fragment", 0, [0.5, 0, 0, 0.5], 1);
    apply();

    const target = c.createTexture(32, 32);
    target.upload(new Uint32Array(1024).fill(0xff0000ff));
    c.setRenderTarget(target, true, 0, 4);
    // Seeding temporarily disables blending and culling; the following draw must restore both.
    c.draw(indices, 0, 1);
    unchanged(apply);
    check(gl.isEnabled(gl.BLEND) && gl.isEnabled(gl.CULL_FACE), "MSAA seed lost enabled state");
    check(gl.getParameter(gl.DEPTH_WRITEMASK) === false, "target allocation retained depth writes");
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
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    draw(purple);
    c.setTexture(0, null);
    c.setProgram(program);
    c.setConstants("fragment", 0, [0.5, 0, 0, 0.5], 1);
    c.present();
    unchanged(apply);
    draw(purple);
    c.configure(64, 64, true, 4);
    unchanged(apply);
    draw(purple);

    const status = gl.checkFramebufferStatus;
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_UNSUPPORTED;
    try {
      rejects(() => c.configure(48, 48, true, 4));
    } finally {
      gl.checkFramebufferStatus = status;
    }
    unchanged(apply);
    draw(purple);
    c.dispose();
    rejects(() => c.setDepth(false, "always"));
    rejects(() => c.setBlend("one", "oneMinusSourceAlpha"));
    rejects(() => c.setCulling("front"));

    return { passed: true };
  } finally {
    names.forEach((name, i) => {
      raw[name] = saved[i];
    });
    c.dispose();
    check(live.size === 0, "pipeline cache retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
