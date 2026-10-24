import { check, color, create, rejects, shader } from "./context.ts";

export async function renderTargets() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64, true, 4);
    c.clear(0, 0, 1, 1);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const solid = c.createProgram();
    solid.upload(shader(false), shader(true));
    const sampled = c.createProgram();
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 5, true);
    sampled.upload(shader(false), fragment);
    const texture = c.createTexture(32, 16);
    const fresh = c.createTexture(16, 32);
    const tiny = c.createTexture(1, 1);
    const cube = c.createTexture(8, 8, true);
    rejects(() => c.setRenderTarget(tiny));
    rejects(() => c.setRenderTarget(cube, false, 6));
    rejects(() => other.backend.setRenderTarget(texture));
    tiny.dispose();
    cube.dispose();
    const show = () => {
      c.setRenderTarget(null);
      c.setTexture(0, texture);
      c.setProgram(sampled);
      c.setDepth(false, "always");
      c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
      c.draw(indices, 0, 1);
      check(color(c.read(), 32, 32, 64) === "ffff0000", "rendered texture was not sampled");
      c.setTexture(0, null);
    };
    c.setRenderTarget(texture, true);
    c.clear(1, 0, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "target read changed the MSAA back buffer");
    show();
    const warmed = new Set(live);
    for (let i = 0; i < 24; i++) {
      c.setRenderTarget(texture, i % 2 === 0);
      c.setRenderTarget(texture, i % 2 === 0);
      c.clear(0, 1, 0, 1);
      c.setProgram(solid);
      c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
      c.draw(indices, 0, 1);
      show();
      check(live.size === warmed.size, "warm render target pass allocated GPU resources");
      for (const handle of live) {
        check(warmed.has(handle), "warm render target pass replaced GPU resources");
      }
    }

    c.setRenderTarget(texture, true);
    c.setTexture(0, texture);
    c.setProgram(sampled);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "depth", "incomplete"] as const) {
      const before = new Set(live);
      try {
        if (failure === "framebuffer") {
          allocation.createFramebuffer = () => null;
        }
        if (failure === "depth") {
          allocation.createRenderbuffer = () => null;
        }
        if (failure === "incomplete") {
          gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        rejects(() => c.setRenderTarget(fresh, true));
      } finally {
        allocation.createFramebuffer = framebuffer;
        allocation.createRenderbuffer = renderbuffer;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === before.size, "failed render target leaked GPU resources");
      for (const handle of live) {
        check(before.has(handle), "failed target replaced a resource");
      }
      c.clear(1, 0, 0, 1);
      show();
      c.setRenderTarget(texture, true);
    }
    c.setRenderTarget(fresh, false);
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    try {
      rejects(() => c.setRenderTarget(fresh, true));
    } finally {
      gl.checkFramebufferStatus = status;
    }
    c.setDepth(true, "never");
    c.setProgram(solid);
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.setRenderTarget(null);
    c.setTexture(0, fresh);
    c.setProgram(sampled);
    c.setDepth(false, "always");
    c.setConstants("fragment", 0, [0.5, 0.5, 0, 1], 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "failed target attached depth state");
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    texture.dispose();
    rejects(() => c.setRenderTarget(texture));
    c.clear(0, 1, 0, 1);
    check(
      color(c.read(), 32, 32, 64) === "ff00ff00",
      "disposing active target left invalid framebuffer",
    );
    c.setRenderTarget(fresh, true);
    c.clear(1, 0, 0, 1);
    c.present();
    c.clear(0, 0, 1, 1);
    check(color(c.read(), 32, 32, 64) === "ff0000ff", "present did not restore back buffer");
    check(gl.getError() === gl.NO_ERROR, "render targets polluted GL state");

    other.backend.configure(32, 32);
    const lost = other.backend.createTexture(16, 16);
    other.backend.setRenderTarget(lost, true);
    other.backend.clear(1, 0, 0, 1);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => other.backend.setRenderTarget(lost));
    return { passed: true };
  } finally {
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "render target teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function cubeTargets() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  let inspect: WebGLFramebuffer | null = null;
  try {
    c.configure(32, 32, true, 4);
    c.clear(0, 0, 0, 1);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-1, -1, 0.5, 1, 1, -1, 0.5, 1, 0, 1, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const sampled = c.createProgram();
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 0x1005, true);
    sampled.upload(shader(false), fragment);
    const cube = c.createTexture(32, 32, true);
    const directions = [
      [1, 0, 0, 1],
      [-1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, -1, 0, 1],
      [0, 0, 1, 1],
      [0, 0, -1, 1],
    ];
    const colors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [0, 1, 1],
      [1, 0, 1],
    ];
    const expected = ["ffff0000", "ff00ff00", "ff0000ff", "ffffff00", "ff00ffff", "ffff00ff"];
    const show = (face: number) => {
      c.setRenderTarget(null);
      c.setDepth(false, "always");
      c.setProgram(sampled);
      c.setTexture(0, cube);
      c.setConstants("fragment", 0, directions[face], 1);
      c.draw(indices, 0, 1);
      const pixels = c.read();
      check(color(pixels, 16, 16, 32) === expected[face], `cube face ${face} changed`);
      c.setTexture(0, null);
      return pixels;
    };
    for (let face = 0; face < 6; face++) {
      c.setRenderTarget(cube, true, face);
      c.clear(colors[face][0], colors[face][1], colors[face][2], 1);
    }
    const readback = show(0);
    inspect = gl.createFramebuffer();
    check(inspect, "cannot create inspection framebuffer");
    // Inspect every mip, including the levels that are not visible at screen resolution.
    const pixel = new Uint8Array(4);
    gl.activeTexture(gl.TEXTURE0);
    // Bind through a draw to inspect the actual GPU handle.
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    const handle = gl.getParameter(gl.TEXTURE_BINDING_CUBE_MAP) as WebGLTexture;
    check(handle, "cube was not bound");
    c.setTexture(0, null);
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level < cube.levels; level++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, inspect);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          handle,
          level,
        );
        check(
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
          "cube mip incomplete",
        );
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        check(color(pixel, 0, 0, 1) === expected[face], `cube face ${face} mip ${level} differs`);
      }
    }
    const created = owned.created;
    for (let i = 0; i < 48; i++) {
      const face = i % 6;
      c.setRenderTarget(cube, i % 2 === 0, face);
      c.setRenderTarget(cube, i % 2 === 0, face);
      c.setScissor(0, 0, 4, 4);
      c.clear(colors[face][0], colors[face][1], colors[face][2], 1);
      c.setScissor(null);
      check(show(face) === readback, "cube target allocated readback storage");
      check(owned.created === created, "warm cube pass allocated GPU handles");
    }
    c.setRenderTarget(cube, true, 4);
    c.setProgram(sampled);
    c.setTexture(0, cube);
    rejects(() => c.draw(indices, 0, 1));
    c.setTexture(0, null);
    for (const face of [-1, 6, 1.5, NaN]) {
      rejects(() => c.setRenderTarget(cube, false, face));
    }
    rejects(() => other.backend.setRenderTarget(cube, true, 2));
    const fresh = c.createTexture(16, 16, true);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "mip-framebuffer", "depth", "incomplete"]) {
      const before = new Set(live);
      let calls = 0;
      try {
        if (failure === "framebuffer" || failure === "mip-framebuffer") {
          allocation.createFramebuffer = () =>
            ++calls === (failure === "framebuffer" ? 1 : 2) ? null : framebuffer.call(gl);
        }
        if (failure === "depth") {
          allocation.createRenderbuffer = () => null;
        }
        if (failure === "incomplete") {
          gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        rejects(() => c.setRenderTarget(fresh, true, 5));
      } finally {
        allocation.createFramebuffer = framebuffer;
        allocation.createRenderbuffer = renderbuffer;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === before.size, "failed cube target leaked handles");
      for (const handle of live) {
        check(before.has(handle), "failed cube target replaced handles");
      }
      c.clear(0, 1, 1, 1);
      show(4);
      c.setRenderTarget(cube, true, 4);
    }
    // Roll back a face switch that fails while adding depth to an existing framebuffer.
    c.setRenderTarget(fresh, false, 2);
    c.clear(1, 0, 0, 1);
    const freshHandle = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
    ) as WebGLTexture;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.setRenderTarget(fresh, true, 3));
    } finally {
      allocation.createRenderbuffer = renderbuffer;
    }
    c.clear(0, 1, 0, 1);
    c.setRenderTarget(null);
    // Sampling would require all six faces; inspect the two affected faces directly.
    gl.bindFramebuffer(gl.FRAMEBUFFER, inspect);
    for (let face = 2; face <= 3; face++) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        freshHandle,
        0,
      );
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      check(
        color(pixel, 0, 0, 1) === (face === 2 ? "ff00ff00" : "0"),
        "failed switch changed the active face",
      );
    }
    check(gl.getError() === gl.NO_ERROR, "cube operations polluted GL state");
    c.setRenderTarget(cube, true, 5);
    cube.dispose();
    rejects(() => c.setRenderTarget(cube, true, 0));
    c.clear(0, 1, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "disposed cube did not restore back buffer");
    fresh.dispose();
    c.configure(64, 32);
    c.clear(1, 0, 0, 1);
    check(color(c.read(), 32, 16, 64) === "ffff0000", "cube target broke resize");
    other.backend.configure(32, 32);
    const lost = other.backend.createTexture(16, 16, true);
    other.backend.setRenderTarget(lost, true, 3);
    other.backend.clear(1, 0, 0, 1);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => other.backend.setRenderTarget(lost, true, 4));
    return { passed: true };
  } finally {
    gl.deleteFramebuffer(inspect);
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "cube target teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
