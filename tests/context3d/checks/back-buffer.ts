import { check, color, create, shader } from "./context.ts";

/**
 * A back buffer larger than the GPU allows, under a faked limit of 64: configure takes it, the
 * SWF sees its size, and it is drawn at the GPU's largest and stretched to it. Scissor
 * rectangles, readback and presentation follow; the GPU is never asked for more.
 */
export async function backBufferLimit() {
  const owned = create();
  const { backend: c, gl, canvas } = owned;
  const MOST = 64;
  const parameter = gl.getParameter.bind(gl);
  gl.getParameter = (name: number) => {
    switch (name) {
      case gl.MAX_TEXTURE_SIZE:
      case gl.MAX_RENDERBUFFER_SIZE:
        return MOST;
      case gl.MAX_VIEWPORT_DIMS:
        return Int32Array.of(MOST, MOST);
      default:
        return parameter(name);
    }
  };
  const asked: number[] = [];
  const texImage = gl.texImage2D.bind(gl) as (...args: unknown[]) => void;
  gl.texImage2D = ((...args: unknown[]) => {
    asked.push(args[3] as number, args[4] as number);
    texImage(...args);
  }) as typeof gl.texImage2D;
  const storage = gl.renderbufferStorage.bind(gl);
  gl.renderbufferStorage = (target, format, width, height) => {
    asked.push(width, height);
    storage(target, format, width, height);
  };
  const multisample = gl.renderbufferStorageMultisample.bind(gl);
  gl.renderbufferStorageMultisample = (target, samples, format, width, height) => {
    asked.push(width, height);
    multisample(target, samples, format, width, height);
  };

  try {
    // A triangle over the whole clip space, blue.
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-1, -1, 0.5, 1, 3, -1, 0.5, 1, -1, 3, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    for (const antiAlias of [0, 4]) {
      asked.length = 0;
      c.configure(200, 48, true, antiAlias);
      check(c.width === 200 && c.height === 48, `the size asked for is the back buffer's`);
      check(
        asked.length > 0 && asked.every((size) => size <= MOST),
        `storage within the GPU's limit: ${asked}`,
      );
      check(canvas.width === 64 && canvas.height === 48, `canvas ${canvas.width}x${canvas.height}`);
      check(
        canvas.style.width === "200px" && canvas.style.height === "",
        `canvas shown at ${canvas.style.width} by ${canvas.style.height}`,
      );

      c.clear(1, 0, 0, 1);
      c.setVertex(0, vertices, 0, "float4");
      c.setProgram(program);
      c.setConstants("fragment", 0, [0, 0, 1, 1], 1);
      // The left half, in the back buffer's pixels.
      c.setScissor(0, 0, 100, 48);
      c.draw(indices, 0, 1);
      c.setScissor(null);
      const pixels = c.read();
      for (const [x, expected] of [
        [0, "ff0000ff"],
        [95, "ff0000ff"],
        [104, "ffff0000"],
        [199, "ffff0000"],
      ] as const) {
        check(
          color(pixels, x, 20, 200) === expected,
          `aa${antiAlias} read at ${x}: ${color(pixels, x, 20, 200)}`,
        );
      }
      const corner = c.read(10, 10);
      check(color(corner, 9, 9, 10) === "ff0000ff", "a region read from a stretched back buffer");

      c.present();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      const shown = (x: number) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, 20, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Array.from(pixel).join();
      };
      check(shown(60) === "255,0,0,255", `presented right half: ${shown(60)}`);
      check(shown(2) === "0,0,255,255", `presented left half: ${shown(2)}`);
    }

    // Within the limit the canvas is the size asked for, unstyled.
    c.configure(32, 40, false, 0);
    check(canvas.width === 32 && canvas.height === 40, "a back buffer within the limit");
    check(canvas.style.width === "" && canvas.style.height === "", "an unstyled canvas");

    c.unconfigure();
    check(c.width === 0 && c.height === 0, "no back buffer");
    let refused = false;
    try {
      c.clear(0, 0, 0, 1);
    } catch {
      refused = true;
    }
    check(refused, "clear without a back buffer");
    c.configure(32, 32, true, 0);
    c.clear(0, 1, 0, 1);
    check(color(c.read(), 3, 3, 32) === "ff00ff00", "a back buffer after none");
    check(gl.getError() === gl.NO_ERROR, "GL error");
  } finally {
    c.dispose();
  }

  return { passed: true };
}
