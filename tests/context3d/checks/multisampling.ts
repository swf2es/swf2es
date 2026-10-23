import { check, color, create, rejects, shader } from "./context.ts";

export async function multisampling() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
    c.setDepth(false, "always");
    const baseline = live.size;
    const partial = (pixels: Uint8Array): number => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 0 && pixels[i] < 255) {
          count++;
        }
      }
      return count;
    };
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(partial(c.read()) === 0, "nonmultisampled triangle has partial coverage");

    for (let i = 0; i < 6; i++) {
      const size = i % 2 === 0 ? 64 : 32;
      const depth = i % 3 !== 0;
      c.configure(size, size, depth, 4);
      check(gl.getParameter(gl.SAMPLES) === 4, "4x sample buffers unavailable in test browser");
      check(live.size === baseline + 2 + Number(depth), "MSAA resize retained GPU handles");
      c.clear(0, 0, 1, 1);
      c.draw(indices, 0, 1);
      check(partial(c.read()) > 0, "multisample readback lost edge coverage");
    }

    c.configure(64, 64, true, 4);
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    c.setScissor(30, 30, 4, 4);
    let resolves = 0;
    const blit = gl.blitFramebuffer;
    gl.blitFramebuffer = function (...args) {
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) {
        resolves++;
      }
      blit.apply(this, args);
    };
    try {
      const pixels = c.read();
      check(partial(pixels) > 0, "scissor clipped the resolve outside its rectangle");
      check(color(pixels, 0, 0, 64) === "ff0000ff", "resolve lost background");
      c.read();
      c.present();
      check(resolves === 1, "unchanged buffer resolved more than once");
      const presented = new Uint8Array(64 * 64 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, presented);
      check(partial(presented) > 0, "presentation lost antialiased edges");
      check(color(presented, 0, 0, 64) === "ff0000ff", "scissor clipped presentation");
      c.clear(0, 1, 0, 1);
      check(color(c.read(), 0, 0, 64) === "ff00ff00", "scissor clipped multisample clear");
      check(Number(resolves) === 2, "clear did not invalidate the resolve");
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, presented);
      check(color(presented, 0, 0, 64) === "ff0000ff", "clear overwrote presentation");
      c.draw(indices, 0, 1);
      const clipped = c.read();
      check(color(clipped, 32, 32, 64) === "ffff0000", "resolve lost the new draw");
      check(color(clipped, 20, 32, 64) === "ff00ff00", "resolve disabled draw-time scissor");
      check(Number(resolves) === 3, "draw did not invalidate the resolve");
      c.clear(0, 0, 0, 1, 1, 2);
      c.read();
      check(Number(resolves) === 3, "depth-only clear needlessly resolved color");
    } finally {
      gl.blitFramebuffer = blit;
    }

    c.setScissor(null);
    const handles = live.size;
    const allocation = gl as unknown as { createRenderbuffer(): WebGLRenderbuffer | null };
    const allocate = allocation.createRenderbuffer;
    allocation.createRenderbuffer = () => null;
    try {
      rejects(() => c.configure(32, 32, false, 4));
    } finally {
      allocation.createRenderbuffer = allocate;
    }
    check(live.size === handles, "failed MSAA allocation leaked GPU handles");
    const status = gl.checkFramebufferStatus;
    for (let failed = 1; failed <= 2; failed++) {
      let checks = 0;
      gl.checkFramebufferStatus = function (target) {
        return ++checks === failed
          ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
          : status.call(this, target);
      };
      try {
        rejects(() => c.configure(32, 32, true, 4));
      } finally {
        gl.checkFramebufferStatus = status;
      }
      check(live.size === handles, "incomplete MSAA framebuffer leaked GPU handles");
      check(c.width === 64 && c.height === 64, "failed MSAA resize changed dimensions");
      check(color(c.read(), 32, 32, 64) === "ffff0000", "failed MSAA resize lost old pixels");
    }
    c.configure(64, 64);
    check(live.size === baseline, "disabling MSAA retained its resources");
    c.draw(indices, 0, 1);
    check(partial(c.read()) === 0, "disabling MSAA retained partial coverage");

    const formats = gl.getInternalformatParameter;
    gl.getInternalformatParameter = (_target, format) =>
      format === gl.RGBA8 ? Int32Array.of(4) : Int32Array.of(2);
    try {
      c.configure(32, 32, true, 4);
      check(gl.getParameter(gl.SAMPLES) === 0, "incompatible sample counts were selected");
      check(live.size === baseline + 1, "MSAA fallback allocated unused resources");
    } finally {
      gl.getInternalformatParameter = formats;
    }
    check(gl.getError() === gl.NO_ERROR, "multisampling polluted GL state");
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "multisampling retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function targetMultisampling() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(64, 64);
    const vertices = c.createBuffer(4, 6);
    vertices.upload(
      [-1, -1, 0.5, 1, 0, 1, 1, -1, 0.5, 1, 1, 1, -1, 1, 0.5, 1, 0, 0, 1, 1, 0.5, 1, 1, 0],
      0,
      4,
    );
    const triangle = c.createBuffer(3, 4);
    triangle.upload([-0.8, -0.8, 0.5, 1, 0.8, -0.8, 0.5, 1, 0, 0.8, 0.5, 1], 0, 3);
    const indices = c.createBuffer(6, 0);
    indices.upload([0, 1, 2, 2, 1, 3], 0, 6);
    const solid = c.createProgram();
    solid.upload(shader(false), shader(true));
    const vertex = new Uint8Array(55);
    vertex.set(shader(false));
    const v = new DataView(vertex.buffer);
    v.setUint32(35, 0x040f0000, true);
    v.setUint32(39, 0xe4000001, true);
    const fragment = shader(true);
    const f = new DataView(fragment.buffer);
    f.setUint32(7, 0x28, true);
    f.setUint32(19, 4, true);
    f.setUint32(27, 5, true);
    const sampled = c.createProgram();
    sampled.upload(vertex, fragment);
    const texture = c.createTexture(64, 64);
    const rectangle = c.createRectangleTexture(64, 48);
    const draw = () => {
      c.setVertex(0, triangle, 0, "float4");
      c.setVertex(1, null, 0, "float2");
      c.setProgram(solid);
      c.setConstants("fragment", 0, [1, 0, 0, 1], 1);
      c.draw(indices, 0, 1);
    };
    const show = (target: typeof texture) => {
      c.setRenderTarget(null);
      c.setScissor(null);
      c.setDepth(false, "always");
      c.clear(0, 0, 0, 1);
      c.setVertex(0, vertices, 0, "float4");
      c.setVertex(1, vertices, 4, "float2");
      c.setProgram(sampled);
      c.setTexture(0, target);
      c.draw(indices, 0, 2);
      c.setTexture(0, null);
      return c.read();
    };
    const partial = (pixels: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 0 && pixels[i] < 255) {
          count++;
        }
      }
      return count;
    };
    c.setDepth(false, "always");
    c.setRenderTarget(texture);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(texture)) === 0, "single-sample texture has partial coverage");
    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(texture)) > 0, "multisample texture lost antialiased edges");
    c.setRenderTarget(rectangle, false, 0, 4);
    c.clear(0, 0, 1, 1);
    draw();
    check(partial(show(rectangle)) > 0, "multisample rectangle lost antialiased edges");

    const handles = owned.created;
    for (let i = 0; i < 16; i++) {
      c.setRenderTarget(texture, i % 2 === 0, 0, 4);
      c.setRenderTarget(texture, i % 2 === 0, 0, 4);
      c.clear(0, 0, 1, 1);
      draw();
      c.setScissor(30, 30, 4, 4);
      const pixels = show(texture);
      check(color(pixels, 32, 32, 64) === "ffff0000", "warm target lost color");
      check(partial(pixels) > 0, "scissor clipped the multisample resolve");
      check(owned.created === handles, "warm multisample targets allocated GPU handles");
    }

    const blit = gl.blitFramebuffer;
    let resolves = 0;
    gl.blitFramebuffer = (...args) => {
      resolves++;
      blit.apply(gl, args);
    };
    try {
      c.setRenderTarget(texture, true, 0, 4);
      c.clear(0, 1, 0, 1);
      c.setRenderTarget(null);
      check(resolves === 1, "color changes did not resolve once");
      c.setRenderTarget(texture, true, 0, 4);
      c.clear(0, 0, 0, 1, 1, 6);
      c.setRenderTarget(null);
      check(resolves === 1, "depth-only clear repeated the color resolve");
    } finally {
      gl.blitFramebuffer = blit;
    }

    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 1, 0, 1);
    const before = live.size;
    const fresh = c.createTexture(32, 32);
    const baseline = live.size;
    const allocation = gl as unknown as {
      createRenderbuffer(): WebGLRenderbuffer | null;
      createTexture(): WebGLTexture | null;
    };
    const allocate = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["color", "depth", "single", "multi"] as const) {
      let allocations = 0;
      let checks = 0;
      allocation.createRenderbuffer = () =>
        ++allocations === (failure === "color" ? 1 : failure === "depth" ? 2 : 0)
          ? null
          : allocate.call(gl);
      gl.checkFramebufferStatus = (target) =>
        ++checks === (failure === "single" ? 1 : failure === "multi" ? 2 : 0)
          ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT
          : status.call(gl, target);
      try {
        rejects(() => c.setRenderTarget(fresh, true, 0, 4));
      } finally {
        allocation.createRenderbuffer = allocate;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === baseline, "failed multisample target leaked handles");
      check(color(show(texture), 32, 32, 64) === "ff00ff00", "failed target lost old color");
      c.setRenderTarget(texture, true, 0, 4);
    }
    c.setRenderTarget(fresh, false, 0, 4);
    c.clear(0, 1, 0, 1);
    const warm = live.size;
    for (const fail of ["allocation", "framebuffer"]) {
      allocation.createRenderbuffer = () => (fail === "allocation" ? null : allocate.call(gl));
      gl.checkFramebufferStatus = (target) =>
        fail === "framebuffer" ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : status.call(gl, target);
      try {
        rejects(() => c.setRenderTarget(fresh, true, 0, 4));
      } finally {
        allocation.createRenderbuffer = allocate;
        gl.checkFramebufferStatus = status;
      }
      check(live.size === warm, "failed cached target upgrade leaked handles");
      draw();
      check(color(show(fresh), 32, 32, 64) === "ffff0000", "cached target rollback broke drawing");
      check(gl.getError() === gl.NO_ERROR, "cached target rollback polluted GL state");
      c.setRenderTarget(fresh, false, 0, 4);
    }
    c.setRenderTarget(null);
    fresh.dispose();
    check(live.size === before, "failed target retained resources after disposal");

    const cube = c.createTexture(16, 16, true);
    for (let face = 0; face < 6; face++) {
      for (let level = 0; level < cube.levels; level++) {
        const size = 16 >> level;
        const pixels = new Uint32Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            pixels[y * size + x] =
              (0xff000000 |
                (((face + 1) * 24) << 16) |
                (x < size / 2 ? 0x2000 : 0x8000) |
                (y < size / 2 ? 0x40 : 0xc0)) >>>
              0;
          }
        }
        cube.upload(pixels, level, face);
      }
    }
    const cubeFragment = shader(true);
    new DataView(cubeFragment.buffer).setUint32(7, 0x28, true);
    new DataView(cubeFragment.buffer).setUint32(27, 0x1005, true);
    const cubeProgram = c.createProgram();
    cubeProgram.upload(shader(false), cubeFragment);
    const directions = [
      [1, -0.5, -0.5, 1],
      [-1, -0.5, 0.5, 1],
      [0.5, 1, 0.5, 1],
      [0.5, -1, -0.5, 1],
      [0.5, -0.5, 1, 1],
      [-0.5, -0.5, -1, 1],
    ];
    c.setRenderTarget(null);
    c.clear(0, 0, 0, 1);
    c.setVertex(0, triangle, 0, "float4");
    c.setVertex(1, null, 0, "float2");
    c.setProgram(cubeProgram);
    c.setConstants("fragment", 0, directions[0], 1);
    c.setTexture(0, cube);
    c.draw(indices, 0, 1);
    const cubeBaseline = color(c.read(), 32, 32, 64);
    check(cubeBaseline === "ff1880c0", `cube source baseline: ${cubeBaseline}`);
    c.setTexture(0, null);
    for (let face = 0; face < 6; face++) {
      c.setRenderTarget(cube, false, face, 4);
      c.setScissor(0, 0, 8, 8);
      draw();
      c.setRenderTarget(null);
      c.setScissor(null);
      c.clear(0, 0, 0, 1);
      c.setProgram(cubeProgram);
      c.setConstants("fragment", 0, directions[face], 1);
      c.setTexture(0, cube);
      c.draw(indices, 0, 1);
      const expected = ((0xff000000 | (((face + 1) * 24) << 16) | 0x80c0) >>> 0).toString(16);
      const actual = color(c.read(), 32, 32, 64);
      check(
        actual === expected,
        `cube multisample seed lost face ${face}: ${actual} != ${expected}`,
      );
      c.setTexture(0, null);
    }
    const unbound = c.createTexture(16, 16, true);
    const originalTexture = allocation.createTexture;
    const count = live.size;
    allocation.createTexture = () => null;
    try {
      rejects(() => c.setRenderTarget(unbound, false, 0, 4));
    } finally {
      allocation.createTexture = originalTexture;
    }
    check(live.size === count, "failed cube resolve allocation leaked handles");
    check(gl.getError() === gl.NO_ERROR, "failed cube resolve polluted GL state");
    unbound.dispose();

    const warmed = owned.created;
    for (let i = 0; i < 12; i++) {
      c.setRenderTarget(cube, false, i % 6, 4);
      c.clear(0, 1, 0, 1);
      c.setRenderTarget(null);
      check(owned.created === warmed, "cube face switching allocated GPU handles");
    }
    c.configure(32, 32, true, 4);
    c.setRenderTarget(texture, true, 0, 4);
    c.clear(0, 0, 1, 1);
    c.setRenderTarget(null);
    c.read();
    check(gl.getError() === gl.NO_ERROR, "multisample targets polluted GL state");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejects(() => c.setRenderTarget(texture, true, 0, 4));
  } finally {
    c.dispose();
    check(live.size === 0, "multisample target teardown retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const bytes = 32 * 32 * 4 * 4;
  for (const budget of ["color", "cube", "depth", "fallback"] as const) {
    const owned = create({
      maxTargetColorBytes:
        budget === "cube" ? bytes + 32 * 32 * 4 : budget === "color" ? bytes : bytes * 2,
      maxTargetDepthBytes: bytes,
    });
    const { backend: c, gl } = owned;
    try {
      c.configure(32, 32);
      if (budget === "fallback") {
        gl.getInternalformatParameter = () => new Int32Array();
      }
      const first = c.createTexture(32, 32, budget === "cube");
      const second = c.createTexture(32, 32, budget === "cube");
      c.setRenderTarget(first, true, 0, 4);
      const count = owned.live.size;
      if (budget === "color" || budget === "cube") {
        rejects(() => c.setRenderTarget(second, false, 0, 4));
        check(owned.live.size === count, "color budget failure leaked handles");
      } else if (budget === "depth") {
        c.setRenderTarget(second, false, 0, 4);
        const count = owned.live.size;
        rejects(() => c.setRenderTarget(second, true, 0, 4));
        check(owned.live.size === count, "depth budget failure leaked handles");
      } else {
        check(gl.getParameter(gl.SAMPLES) === 0, "unsupported MSAA did not fall back");
      }
      c.setRenderTarget(null);
      first.dispose();
      c.setRenderTarget(second, true, 0, 4);
      c.setRenderTarget(null);
      second.dispose();
      check(gl.getError() === gl.NO_ERROR, "multisample target quotas polluted GL state");
    } finally {
      c.dispose();
      check(owned.live.size === 0, "multisample target budgets retained GPU handles");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  return { passed: true };
}
