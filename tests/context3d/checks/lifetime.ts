import { check, color, create, rejects, shader } from "./context.ts";

export async function lifetime() {
  const first = create();
  const second = create();
  const c = first.backend;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const p = c.createProgram();
    p.upload(shader(false), shader(true));
    c.setProgram(p);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, -1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "initial triangle");
    c.setScissor(30, 30, 4, 4);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.present();
    first.gl.bindFramebuffer(first.gl.FRAMEBUFFER, null);
    const presented = new Uint8Array(64 * 64 * 4);
    first.gl.readPixels(0, 0, 64, 64, first.gl.RGBA, first.gl.UNSIGNED_BYTE, presented);
    check(color(presented, 0, 0, 64) === "ff0000ff", "scissor clipped presentation");
    check(color(presented, 32, 32, 64) === "ffff0000", "scissor lost the drawn region");
    c.setScissor(null);
    const swizzled = shader(true);
    new DataView(swizzled.buffer).setUint32(15, 0xe1000000, true);
    p.upload(shader(false), swizzled);
    check(first.gl.getParameter(first.gl.CURRENT_PROGRAM) === null, "replaced program still bound");
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff00ff00", "AGAL swizzle did not reach the GPU");
    p.upload(shader(false), shader(true));
    vertices.upload([-0.75, -0.75, -0.5, 1, 0.75, -0.75, -0.5, 1, 0, 0.75, -0.5, 1], 0, 3);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "negative AGAL clip depth was not clipped");
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    rejects(() => second.backend.setProgram(p));
    rejects(() => second.backend.setVertex(0, vertices, 0, "float4"));
    rejects(() => c.draw(vertices, 0, 1));
    rejects(() => indices.upload([0], 3, 1));
    rejects(() => c.setVertex(8, vertices, 0, "float4"));
    rejects(() => c.setConstants("fragment", 28, [1, 0, 0, 1], 1));
    const handles = first.live.size;
    // Valid stages with incompatible varyings fail linking after GPU allocation.
    const varying = shader(true);
    new DataView(varying.buffer).setUint32(19, 4, true);
    rejects(() => p.upload(shader(false), varying));
    check(first.live.size === handles, "failed program upload leaked GPU handles");
    // A failed replacement must leave the previously linked program usable.
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "failed upload replaced a working program");
    check(first.gl.getError() === first.gl.NO_ERROR, "failed upload polluted GL state");
    rejects(() => c.configure(31, 32));
    c.configure(32, 32);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "resize invalidated live resources");
    const colorHandles = first.live.size;
    const allocation = first.gl as unknown as { createRenderbuffer(): WebGLRenderbuffer | null };
    const makeDepth = allocation.createRenderbuffer;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.configure(64, 64, true));
    } finally {
      allocation.createRenderbuffer = makeDepth;
    }
    check(first.live.size === colorHandles, "failed depth allocation leaked GPU handles");
    const status = first.gl.checkFramebufferStatus;
    first.gl.checkFramebufferStatus = () => first.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    try {
      rejects(() => c.configure(64, 64, true));
    } finally {
      first.gl.checkFramebufferStatus = status;
    }
    check(first.live.size === colorHandles, "incomplete depth target leaked GPU handles");
    check(c.width === 32 && c.height === 32, "failed resize changed back-buffer dimensions");
    check(color(c.read(), 16, 16, 32) === "ffff0000", "failed resize lost the old back buffer");

    c.setDepth(false, "always");
    for (let i = 0; i < 8; i++) {
      const size = i % 2 === 0 ? 64 : 32;
      c.configure(size, size, true);
      c.draw(indices, 0, 1);
      check(color(c.read(), size / 2, size / 2, size) === "ffff0000", "depth resize lost geometry");
      check(first.live.size === colorHandles + 1, "depth resize retained retired handles");
      check(
        !first.gl.getParameter(first.gl.DEPTH_WRITEMASK),
        "resize changed the depth write mask",
      );
    }
    c.setDepth(true, "never");
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff0000ff", "depth test was disabled after resize");
    c.configure(32, 32, false);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "color-only target performed a depth test");
    check(first.live.size === colorHandles, "disabling depth retained its attachment");
    c.setDepth(true, "less");
    check(first.gl.getError() === first.gl.NO_ERROR, "depth resize polluted GL state");

    rejects(() => c.createTexture(0, 2));
    rejects(() => c.createTexture(3, 2));
    rejects(() => c.createTexture(4096, 2));
    const texture = c.createTexture(2, 2);
    rejects(() => second.backend.setTexture(0, texture));
    rejects(() => c.setTexture(8, texture));
    const textured = shader(true);
    const textureCode = new DataView(textured.buffer);
    textureCode.setUint32(7, 0x28, true);
    textureCode.setUint32(27, 5, true);
    p.upload(shader(false), textured);
    c.setConstants("fragment", 0, [0.25, 0.25, 0, 1], 1);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    rejects(() => c.draw(indices, 0, 1));
    const pixels = Uint32Array.of(0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff);
    rejects(() => texture.upload(pixels.subarray(1)));
    rejects(() => texture.upload(pixels, 2));
    rejects(() => texture.upload(pixels, -1));
    rejects(() => texture.upload(pixels, 0.5));
    rejects(() => texture.upload(pixels, 1));
    const gl = first.gl as unknown as { texSubImage2D: (...args: unknown[]) => void };
    const upload = gl.texSubImage2D;
    let staging: unknown;
    let uploads = 0;
    gl.texSubImage2D = function (...args) {
      if (uploads === 0) {
        staging = args[8];
      }
      check(staging === args[8], "texture upload replaced its staging buffer");
      uploads++;
      upload.apply(this, args);
    };
    try {
      texture.upload(pixels);
      c.draw(indices, 0, 1);
      const warmed = new Set(first.live);
      for (let i = 0; i < 8; i++) {
        pixels[0] = i % 2 === 0 ? 0xff00ff00 : 0xffff0000;
        texture.upload(pixels);
        c.draw(indices, 0, 1);
        check(color(c.read(), 16, 16, 32) === pixels[0].toString(16), "reupload did not reach GPU");
        check(first.live.size === warmed.size, "warm texture draws allocated GPU handles");
        for (const handle of first.live) {
          check(warmed.has(handle), "warm texture draws replaced a GPU handle");
        }
      }
      textureCode.setUint32(27, 0x12000005, true);
      p.upload(shader(false), textured);
      rejects(() => c.draw(indices, 0, 1));
      const mip = Uint32Array.of(0xff0000ff);
      texture.upload(mip, 1);
      c.draw(indices, 0, 1);
      const mipHandles = new Set(first.live);
      texture.upload(mip, 1);
      c.draw(indices, 0, 1);
      check(first.live.size === mipHandles.size, "mip reupload allocated GPU handles");
      for (const handle of first.live) {
        check(mipHandles.has(handle), "mip reupload replaced a GPU handle");
      }
      check(uploads === 11, "texture upload was skipped");
    } finally {
      gl.texSubImage2D = upload;
    }
    c.configure(64, 64);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "resize lost texture bindings");
    c.setTexture(0, null);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    texture.dispose();
    texture.dispose();
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, texture);
    rejects(() => c.draw(indices, 0, 1));
    rejects(() => texture.upload(pixels));
    c.setTexture(0, null);
    rejects(() => c.createTexture(2, 4, true));
    rejects(() => c.createTexture(2048, 2048, true));
    const cube = c.createTexture(2, 2, true);
    rejects(() => second.backend.setTexture(0, cube));
    rejects(() => cube.upload(pixels, 0, -1));
    rejects(() => cube.upload(pixels, 0, 6));
    rejects(() => cube.upload(pixels, 0, 0.5));
    textureCode.setUint32(27, 0x12001005, true);
    p.upload(shader(false), textured);
    c.setTexture(0, cube);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    uploads = 0;
    staging = undefined;
    gl.texSubImage2D = function (...args) {
      if (uploads === 0) {
        staging = args[8];
      }
      check(staging === args[8], "cube faces/mips replaced the shared staging buffer");
      uploads++;
      upload.apply(this, args);
    };
    try {
      const mip = Uint32Array.of(0xffff0000);
      pixels.fill(0xffff0000);
      for (let face = 0; face < 6; face++) {
        cube.upload(pixels, 0, face);
        rejects(() => c.draw(indices, 0, 1));
        cube.upload(mip, 1, face);
      }
      c.draw(indices, 0, 1);
      const handles = new Set(first.live);
      for (let frame = 0; frame < 8; frame++) {
        const argb = frame % 2 ? 0xffff0000 : 0xff00ff00;
        pixels.fill(argb);
        cube.upload(pixels, 0, 0);
        c.clear(0, 0, 0, 1);
        c.draw(indices, 0, 1);
        check(color(c.read(), 32, 32, 64) === argb.toString(16), "cube reupload did not reach GPU");
        check(first.live.size === handles.size, "cube reupload allocated GPU handles");
        for (const handle of first.live) {
          check(handles.has(handle), "cube reupload replaced GPU handles");
        }
      }
      check(uploads === 20, "cube uploads were skipped");
    } finally {
      gl.texSubImage2D = upload;
    }
    c.configure(32, 32);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "resize lost cube binding");
    c.setTexture(0, null);
    check(
      first.gl.getParameter(first.gl.TEXTURE_BINDING_CUBE_MAP) === null,
      "cube was not unbound",
    );
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    cube.dispose();
    cube.dispose();
    check(
      first.gl.getParameter(first.gl.TEXTURE_BINDING_CUBE_MAP) === null,
      "disposed cube remains bound",
    );
    rejects(() => cube.upload(pixels));
    c.setTexture(0, cube);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    check(first.gl.getError() === first.gl.NO_ERROR, "cube lifetime polluted GL state");
    p.upload(shader(false), shader(true));
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    vertices.dispose();
    rejects(() => c.draw(indices, 0, 1));
    rejects(() => vertices.upload([], 0, 0));
    p.dispose();
    check(first.gl.getParameter(first.gl.CURRENT_PROGRAM) === null, "disposed program still bound");
    rejects(() => c.setProgram(p));
    c.dispose();
    c.dispose();
    check(first.live.size === 0, "context disposal leaked resources");
    rejects(() => c.createProgram());
    rejects(() => c.configure(1, 1));
    second.backend.configure(32, 32);
    const lossCube = second.backend.createTexture(2, 2, true);
    lossCube.upload(pixels, 0, 0);
    const loss = second.gl.getExtension("WEBGL_lose_context");
    check(loss, "context loss extension unavailable");
    const lost = new Promise<void>((resolve) =>
      second.canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }),
    );
    loss.loseContext();
    await lost;
    rejects(() => second.backend.clear(1, 0, 0, 1));
    rejects(() => second.backend.configure(32, 32));
    second.backend.dispose();
    check(second.live.size === 0, "lost context retains resource handles");
    rejects(() => lossCube.upload(pixels));
    return { passed: true };
  } finally {
    c.dispose();
    second.backend.dispose();
    first.gl.getExtension("WEBGL_lose_context")?.loseContext();
    second.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
