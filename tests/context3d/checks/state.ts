import { check, color, create, rejects, shader } from "./context.ts";

export async function stencil() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32, true, 4);
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
    c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
    c.setStencilReference(42, 255, 0);
    const pixels = c.read();
    const allocated = owned.created;
    const func = gl.stencilFuncSeparate;
    const op = gl.stencilOpSeparate;
    const mask = gl.stencilMask;
    const query = gl.getParameter;
    let changes = 0;
    let queries = 0;
    gl.stencilFuncSeparate = (...args) => {
      changes++;
      func.apply(gl, args);
    };
    gl.stencilOpSeparate = (...args) => {
      changes++;
      op.apply(gl, args);
    };
    gl.stencilMask = (...args) => {
      changes++;
      mask.apply(gl, args);
    };
    gl.getParameter = (...args) => {
      queries++;
      return query.apply(gl, args);
    };
    try {
      for (let i = 0; i < 24; i++) {
        c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
        c.setStencilReference(42, 255, 0);
      }
      check(changes === 0, "unchanged stencil setters changed GPU state");
      for (let i = 0; i < 24; i++) {
        c.clear(0, 0, 1, 1, 1, 7, 42);
        c.draw(indices, 0, 1);
        c.setStencilActions("frontAndBack", "never", "keep", "keep", "keep");
        check(c.read() === pixels, "stencil changed readback storage");
        check(color(pixels, 16, 16, 32) === "ffff0000", "stencil clear or resolve failed");
        c.present();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        check(color(pixels, 16, 16, 32) === "ffff0000", "stencil clipped presentation");
        c.setStencilActions("frontAndBack", "equal", "keep", "keep", "keep");
      }
      check(queries === 0, "stencil operations queried GPU state");
      check(owned.created === allocated, "stencil operations allocated GPU handles");
    } finally {
      gl.stencilFuncSeparate = func;
      gl.stencilOpSeparate = op;
      gl.stencilMask = mask;
      gl.getParameter = query;
    }
    // A color-only target bypasses stencil, retaining state when depth returns.
    c.configure(32, 32, false);
    c.setStencilActions("frontAndBack", "never", "keep", "keep", "keep");
    c.clear(0, 0, 1, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "stencil rejected color-only draws");
    c.configure(32, 32, true);
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff000000", "configuration lost stencil state");
    check(gl.getError() === gl.NO_ERROR, "stencil operations polluted GL state");
    c.dispose();
    rejects(() => c.setStencilReference(0, 255, 255));
    rejects(() => c.setStencilActions("none", "always", "keep", "keep", "keep"));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "stencil test retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function colorMasks() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    c.configure(32, 32, true, 4);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    const program = c.createProgram();
    program.upload(shader(false), shader(true));
    c.setProgram(program);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 1, 0, 1], 1);
    c.setDepth(false, "always");
    const pixels = c.read();
    const allocated = owned.created;
    const setMask = gl.colorMask;
    const getParameter = gl.getParameter;
    let changes = 0;
    let queries = 0;
    gl.colorMask = (...args) => {
      changes++;
      setMask.apply(gl, args);
    };
    gl.getParameter = (...args) => {
      queries++;
      return getParameter.apply(gl, args);
    };
    try {
      c.setColorMask(true, false, false, false);
      const initial = changes;
      for (let i = 0; i < 32; i++) {
        c.setColorMask(true, false, false, false);
      }
      check(changes === initial, "unchanged color mask repeated a GL state change");
      for (let i = 0; i < 24; i++) {
        c.clear(0, 0, 1, 1);
        c.draw(indices, 0, 1);
        c.setColorMask(false, false, false, false);
        check(c.read() === pixels, "color mask replaced readback storage");
        check(color(pixels, 16, 16, 32) === "ffff00ff", "resolve obeyed draw-time color mask");
        c.present();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        check(color(pixels, 16, 16, 32) === "ffff00ff", "presentation obeyed color mask");
        check(color(pixels, 0, 0, 32) === "ff0000ff", "masked clear lost channels");
        c.setColorMask(true, false, false, false);
      }
      check(queries === 0, "color masks queried GPU state");
      check(owned.created === allocated, "color masks allocated GPU handles");
    } finally {
      gl.colorMask = setMask;
      gl.getParameter = getParameter;
    }
    check(gl.getError() === gl.NO_ERROR, "color masks polluted GL state");
    c.dispose();
    rejects(() => c.setColorMask(true, true, true, true));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "color mask test retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function reconfiguration() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    for (const quality of [0, 4]) {
      for (const depth of [false, true]) {
        c.configure(64, 64, depth, quality);
        c.clear(1, 0, 0, 1);
        const pixels = c.read();
        const warmed = new Set(live);
        const allocated = owned.created;
        const formats = gl.getInternalformatParameter;
        const status = gl.checkFramebufferStatus;
        let queries = 0;
        gl.getInternalformatParameter = (...args) => {
          queries++;
          return formats.apply(gl, args);
        };
        gl.checkFramebufferStatus = (...args) => {
          queries++;
          return status.apply(gl, args);
        };
        try {
          for (let i = 0; i < 24; i++) {
            c.clear(0, 0, 1, 1);
            c.configure(64, 64, depth, quality);
            check(c.read() === pixels, "unchanged configuration replaced readback storage");
            check(color(pixels, 32, 32, 64) === "ff0000ff", "configuration lost pending color");
            c.present();
            c.configure(64, 64, depth, quality);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            check(color(pixels, 32, 32, 64) === "ff0000ff", "configuration cleared presentation");
            check(owned.created === allocated, "unchanged configuration allocated GPU handles");
            check(live.size === warmed.size, "unchanged configuration retired GPU handles");
            for (const handle of live) {
              check(warmed.has(handle), "unchanged configuration replaced GPU handles");
            }
          }
          check(queries === 0, "unchanged configuration queried capabilities or completeness");
        } finally {
          gl.getInternalformatParameter = formats;
          gl.checkFramebufferStatus = status;
        }
        rejects(() => c.configure(64, 64, depth, Number.NaN));
        rejects(() => c.configure(64.5, 64, depth, quality));
        const allocation = gl as unknown as { createTexture(): WebGLTexture | null };
        const allocate = allocation.createTexture;
        allocation.createTexture = () => null;
        try {
          rejects(() => c.configure(32, 32, depth, quality));
        } finally {
          allocation.createTexture = allocate;
        }
        const afterFailure = owned.created;
        c.configure(64, 64, depth, quality);
        check(owned.created === afterFailure, "failed resize invalidated the previous request");
        check(c.read() === pixels, "failed resize replaced readback storage");
        check(color(pixels, 32, 32, 64) === "ff0000ff", "failed resize lost old pixels");
      }
    }
    const texture = c.createTexture(8, 8);
    c.setRenderTarget(texture);
    rejects(() => c.configure(64, 64, true, 4));
    c.setRenderTarget(null);
    check(gl.getError() === gl.NO_ERROR, "reconfiguration polluted GL state");
    c.dispose();
    rejects(() => c.configure(64, 64, true, 4));
    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "reconfiguration retained GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
