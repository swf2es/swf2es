import { SAMPLER_FILTERS, SAMPLER_MIPS, SAMPLER_WRAPS, type SamplerWrap } from "@swf2es/context3d";

import { check, color, create, rejects, shader } from "./context.ts";

export async function rectangleTextures() {
  const owned = create();
  const other = create();
  const { backend: c, gl, live } = owned;
  const uploads = gl as unknown as { texSubImage2D(...args: unknown[]): void };
  const upload = uploads.texSubImage2D.bind(gl);
  let staging: unknown;
  let uploadCount = 0;
  uploads.texSubImage2D = (...args) => {
    const bytes = args[8];
    check(!staging || staging === bytes, "rectangle upload replaced staging storage");
    staging = bytes;
    uploadCount++;
    upload(...args);
  };
  const mipmap = gl.generateMipmap;
  gl.generateMipmap = () => {
    throw new Error("rectangle target generated mipmaps");
  };
  try {
    c.configure(32, 32);
    const texture = c.createRectangleTexture(17, 9);
    check(texture.rectangle && !texture.cube && texture.levels === 1, "rectangle allocated mips");
    const bitmap = new Uint32Array(17 * 9).fill(0xff00ff00);
    const small = new Uint32Array([0xffff0000]);
    const big = new Uint32Array(20 * 12).fill(0xff0000ff);
    big[8 * 20 + 16] = 0xff00ffff;
    big[11 * 20 + 19] = 0xffffff00;
    const bytes = new Uint8Array(17 * 9 * 4 + 1);
    for (let i = 1; i < bytes.length; i += 4) {
      bytes[i + 1] = 255;
      bytes[i + 3] = 255;
    }
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-1, -1, 0.5, 1, 3, -1, 0.5, 1, -1, 3, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 5, true);
    const program = c.createProgram();
    program.upload(shader(false), fragment);
    c.setProgram(program);
    const readback = c.read();
    const show = (x: number, y: number, expected: string): void => {
      c.setTexture(0, texture);
      c.setConstants("fragment", 0, [x, y, 0, 1], 1);
      c.clear(0, 0, 0, 1);
      c.draw(indices, 0, 1);
      check(c.read() === readback, "rectangle replaced readback storage");
      check(color(readback, 16, 16, 32) === expected, "rectangle contents differ");
    };
    texture.upload(bitmap);
    show(0.5, 0.5, "ff00ff00");
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    c.clear(0, 1, 0, 1);
    c.setRenderTarget(null);
    const allocated = owned.created;
    for (let pass = 0; pass < 10; pass++) {
      texture.upload(small, 0, 0, 1, 1);
      show(0, 0, "ffff0000");
      show(1, 1, "0");
      texture.upload(big, 0, 0, 20, 12);
      show(1, 1, "ff00ffff");
      texture.uploadBytes(bytes, 1);
      show(0.5, 0.5, "ff00ff00");
      c.setTexture(0, null);
      c.setRenderTarget(texture, !!(pass & 1));
      c.clear(1, 0, 0, 1);
      c.setRenderTarget(null);
      show(0.5, 0.5, "ffff0000");
      check(owned.created === allocated, "warm rectangle operations allocated GPU handles");
    }
    check(uploadCount === 31, "unexpected rectangle upload count");
    check(staging instanceof Uint8Array && staging.length === 17 * 9 * 4, "oversized staging");
    rejects(() => texture.upload(bitmap, 1));
    rejects(() => texture.upload(bitmap, 0, 1));
    rejects(() => texture.upload(small, 0, 0, NaN, 1));
    rejects(() => texture.upload(small, 0, 0, 2, 1));
    rejects(() => texture.uploadBytes(bytes, 2));
    rejects(() => other.backend.setTexture(0, texture));
    rejects(() => other.backend.setRenderTarget(texture));
    rejects(() => c.setRenderTarget(texture, false, 1));
    show(0.5, 0.5, "ffff0000");
    const fresh = c.createRectangleTexture(19, 11);
    const allocation = gl as unknown as {
      createFramebuffer(): WebGLFramebuffer | null;
      createRenderbuffer(): WebGLRenderbuffer | null;
    };
    const framebuffer = allocation.createFramebuffer;
    const renderbuffer = allocation.createRenderbuffer;
    const status = gl.checkFramebufferStatus;
    for (const failure of ["framebuffer", "depth", "incomplete"]) {
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
      check(live.size === before.size, "failed rectangle target leaked handles");
      for (const handle of live) {
        check(before.has(handle), "failed rectangle target replaced handles");
      }
      show(0.5, 0.5, "ffff0000");
    }
    c.setTexture(0, null);
    c.setRenderTarget(texture, true);
    texture.dispose();
    c.clear(0, 1, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ff00ff00", "rectangle disposal lost back buffer");
    rejects(() => texture.upload(bitmap));
    rejects(() => c.setRenderTarget(texture));
    check(gl.getError() === gl.NO_ERROR, "rectangle operations polluted GL state");
    other.backend.configure(32, 32);
    const lost = other.backend.createRectangleTexture(17, 9);
    other.backend.setRenderTarget(lost, true);
    other.gl.getExtension("WEBGL_lose_context")?.loseContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    rejects(() => lost.upload(bitmap));
    rejects(() => other.backend.setRenderTarget(lost));
    return { passed: true };
  } finally {
    uploads.texSubImage2D = upload;
    gl.generateMipmap = mipmap;
    c.dispose();
    other.backend.dispose();
    check(live.size === 0 && other.live.size === 0, "rectangle teardown leaked GPU resources");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function samplerStates(mode: "native" | "clamped" | "missing" = "native") {
  const owned = create();
  const { backend: c, gl, live } = owned;
  try {
    const getExtension = gl.getExtension.bind(gl);
    const getParameter = gl.getParameter.bind(gl);
    const extension = getExtension("EXT_texture_filter_anisotropic");
    const maximum = extension ? getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    const limit = mode === "clamped" ? Math.min(2, maximum) : maximum;
    let extensionQueries = 0;
    let limitQueries = 0;
    gl.getExtension = ((name: string) => {
      if (name === "EXT_texture_filter_anisotropic") {
        extensionQueries++;
        return mode === "missing" ? null : extension;
      }

      return getExtension(name);
    }) as typeof gl.getExtension;
    gl.getParameter = (name: number) => {
      if (extension && name === extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT) {
        limitQueries++;
        return limit;
      }

      return getParameter(name);
    };
    c.configure(32, 32);
    const vertices = c.createBuffer(3, 4);
    vertices.upload([-0.75, -0.75, 0.5, 1, 0.75, -0.75, 0.5, 1, 0, 0.75, 0.5, 1], 0, 3);
    const indices = c.createBuffer(3, 0);
    indices.upload([0, 1, 2], 0, 3);
    c.setVertex(0, vertices, 0, "float4");
    c.setConstants("fragment", 0, [1, 0.25, 0.25, 1], 1);
    const texture = c.createTexture(4, 4);
    const cube = c.createTexture(4, 4, true);
    const rectangle = c.createRectangleTexture(4, 4);
    const pixels = new Uint32Array(16).fill(0xffff0000);
    rectangle.upload(pixels);
    for (let level = 0; level < 3; level++) {
      const data = pixels.subarray(0, (4 >> level) ** 2);
      texture.upload(data, level);
      for (let face = 0; face < 6; face++) {
        cube.upload(data, level, face);
      }
    }

    const fragment = shader(true);
    const code = new DataView(fragment.buffer);
    code.setUint32(7, 0x28, true);
    code.setUint32(27, 0x40005, true);
    code.setUint32(23, 8 << 16, true);
    const flat = c.createProgram();
    flat.upload(shader(false), fragment);
    code.setUint32(27, 0x41005, true);
    code.setUint32(23, 248 << 16, true);
    const spherical = c.createProgram();
    spherical.upload(shader(false), fragment);
    const encoded = [];
    for (let f = 0; f < SAMPLER_FILTERS.length; f++) {
      code.setUint32(27, 5 | (f << 28) | (2 << 24), true);
      const program = c.createProgram();
      program.upload(shader(false), fragment);
      encoded.push(program);
    }
    c.setProgram(flat);
    c.setTexture(0, texture);
    const readback = c.read();
    const make = gl.createSampler.bind(gl);
    gl.createSampler = () => null as unknown as WebGLSampler;
    c.clear(0, 0, 0, 1);
    rejects(() => c.draw(indices, 0, 1));
    gl.createSampler = make;
    const minFilters = [
      gl.NEAREST,
      gl.LINEAR,
      gl.NEAREST_MIPMAP_NEAREST,
      gl.LINEAR_MIPMAP_NEAREST,
      gl.NEAREST_MIPMAP_LINEAR,
      gl.LINEAR_MIPMAP_LINEAR,
    ];
    let allocated = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (let dimension = 0; dimension < 3; dimension++) {
        c.setProgram(dimension === 1 ? spherical : flat);
        c.setTexture(0, dimension === 1 ? cube : dimension === 2 ? rectangle : texture);
        for (let w = 0; w < SAMPLER_WRAPS.length; w++) {
          for (let f = 0; f < SAMPLER_FILTERS.length; f++) {
            for (let m = 0; m < SAMPLER_MIPS.length; m++) {
              c.setSampler(0, SAMPLER_WRAPS[w], SAMPLER_FILTERS[f], SAMPLER_MIPS[m]);
              c.clear(0, 0, 0, 1);
              if ((dimension !== 0 && w !== 0) || (dimension === 2 && m !== 0)) {
                rejects(() => c.draw(indices, 0, 1));
                continue;
              }
              c.draw(indices, 0, 1);
              const sampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler;
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_MIN_FILTER) ===
                  minFilters[m * 2 + Number(f !== 0)],
                "wrong mip/filter combination",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_MAG_FILTER) ===
                  (f ? gl.LINEAR : gl.NEAREST),
                "wrong magnification filter",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_WRAP_S) ===
                  (w & 1 ? gl.REPEAT : gl.CLAMP_TO_EDGE),
                "wrong U wrap",
              );
              check(
                gl.getSamplerParameter(sampler, gl.TEXTURE_WRAP_T) ===
                  (w & 2 ? gl.REPEAT : gl.CLAMP_TO_EDGE),
                "wrong V wrap",
              );
              if (extension) {
                check(
                  gl.getSamplerParameter(sampler, extension.TEXTURE_MAX_ANISOTROPY_EXT) ===
                    (f > 1 && mode !== "missing" ? Math.min(1 << (f - 1), limit) : 1),
                  "wrong anisotropy or retained previous filter",
                );
              }
              check(c.read() === readback, "samplers replaced readback storage");
              check(color(readback, 16, 16, 32) === "ffff0000", "sampler lost texture contents");
              if (pass) {
                check(owned.created === allocated, "warm sampler draw allocated GPU handles");
              }
            }
          }
        }
      }
      c.setTexture(0, texture);
      for (let f = 0; f < encoded.length; f++) {
        c.setProgram(encoded[f]);
        c.clear(0, 0, 0, 1);
        c.draw(indices, 0, 1);
        const sampler = gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler;
        check(
          gl.getSamplerParameter(sampler, gl.TEXTURE_MIN_FILTER) ===
            minFilters[4 + Number(f !== 0)],
          "AGAL sampler did not replace the previous filter",
        );
        if (extension) {
          check(
            gl.getSamplerParameter(sampler, extension.TEXTURE_MAX_ANISOTROPY_EXT) ===
              (f > 1 && mode !== "missing" ? Math.min(1 << (f - 1), limit) : 1),
            "AGAL sampler did not replace anisotropy",
          );
        }
        if (pass) {
          check(owned.created === allocated, "warm AGAL sampler draw allocated GPU handles");
        }
      }
      if (!pass) {
        allocated = owned.created;
      }
    }

    check(extensionQueries === 1, "anisotropy extension was queried more than once");
    check(
      limitQueries === (extension && mode !== "missing" ? 1 : 0),
      "anisotropy limit was queried during warm draws",
    );
    c.setTexture(0, texture);
    c.setSampler(0, "clamp", "linear", "miplinear");
    rejects(() => c.setSampler(0, "bad" as SamplerWrap, "nearest", "mipnone"));
    rejects(() => c.setSampler(-1, "repeat", "nearest", "mipnone"));
    rejects(() => c.setSampler(16, "repeat", "nearest", "mipnone"));
    c.setSampler(15, "repeat", "nearest", "mipnone");
    c.draw(indices, 0, 1);
    check(color(c.read(), 16, 16, 32) === "ffff0000", "invalid sampler state damaged drawing");
    const bad = fragment.slice();
    bad[7] = 0xff;
    rejects(() => spherical.upload(shader(false), bad));
    const conflicting = new Uint8Array(55);
    conflicting.set(fragment);
    conflicting.set(fragment.subarray(7), 31);
    conflicting[49] = 8;
    rejects(() => spherical.upload(shader(false), conflicting));
    c.draw(indices, 0, 1);
    check(owned.created === allocated, "invalid sampler program allocated handles");
    c.configure(64, 64);
    c.clear(0, 0, 0, 1);
    c.draw(indices, 0, 1);
    check(color(c.read(), 32, 32, 64) === "ffff0000", "resize lost runtime sampler state");
    check(gl.getError() === gl.NO_ERROR, "sampler tests polluted GL state");

    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "samplers retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export async function textureBytes() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  const framebuffer = gl.createFramebuffer();
  check(framebuffer, "byte upload readback framebuffer unavailable");
  const uploads = gl as unknown as { texSubImage2D: (...args: unknown[]) => void };
  const upload = uploads.texSubImage2D;
  try {
    c.configure(32, 32);
    const flat = c.createTexture(8, 4);
    const cube = c.createTexture(4, 4, true);
    const source = new Uint8Array(new ArrayBuffer(144), 5, 131);
    const readback = new Uint8Array(128);
    const bitmap = new Uint32Array(32);
    const staging = new Map<WebGLTexture, unknown>();
    const allocated = owned.created;
    let calls = 0;
    uploads.texSubImage2D = function (...args) {
      const handle = gl.getParameter(
        args[0] === gl.TEXTURE_2D ? gl.TEXTURE_BINDING_2D : gl.TEXTURE_BINDING_CUBE_MAP,
      ) as WebGLTexture;
      if (!staging.has(handle)) {
        staging.set(handle, args[8]);
      }
      check(staging.get(handle) === args[8], "texture bytes replaced staging storage");
      calls++;
      upload.apply(this, args);
    };
    for (let iteration = 0; iteration < 8; iteration++) {
      for (const texture of [flat, cube]) {
        const target = texture.cube ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
        for (let face = 0; face < (texture.cube ? 6 : 1); face++) {
          for (let level = 0; level < texture.levels; level++) {
            const w = Math.max(1, texture.width >> level);
            const h = Math.max(1, texture.height >> level);
            const seed = iteration + face * 17 + level * 31;
            for (let i = 0; i < w * h; i++) {
              const at = 3 + i * 4;
              source[at] = (i + seed) * 7;
              source[at + 1] = (i + seed) * 5;
              source[at + 2] = (i + seed) * 3;
              source[at + 3] = i + seed;
            }
            texture.uploadBytes(source, 3, level, face);
            source.fill(0);
            const handle = gl.getParameter(
              texture.cube ? gl.TEXTURE_BINDING_CUBE_MAP : gl.TEXTURE_BINDING_2D,
            ) as WebGLTexture;
            const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer;
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0,
              texture.cube ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : target,
              handle,
              level,
            );
            check(
              gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
              "byte upload mip cannot be read",
            );
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readback);
            gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
            for (let i = 0; i < w * h; i++) {
              check(
                readback[i * 4] === (((i + seed) * 3) & 255) &&
                  readback[i * 4 + 1] === (((i + seed) * 5) & 255) &&
                  readback[i * 4 + 2] === (((i + seed) * 7) & 255) &&
                  readback[i * 4 + 3] === ((i + seed) & 255),
                "byte upload changed channel bits, rows, mip or cube face",
              );
            }
          }
        }
      }
      // Both upload paths must share the same storage, even after smaller mip uploads.
      flat.upload(bitmap);
      check(owned.created === allocated, "texture byte uploads allocated GPU handles");
    }
    check(staging.size === 2 && calls === 184, "missing byte texture uploads");
    for (const texture of [flat, cube]) {
      for (const offset of [-1, 0.5, Number.NaN, Infinity, source.length]) {
        rejects(() => texture.uploadBytes(source, offset));
      }
      for (const level of [-1, 0.5, Number.NaN, texture.levels]) {
        rejects(() => texture.uploadBytes(source, 0, level));
      }
      for (const face of [-1, 0.5, Number.NaN, texture.cube ? 6 : 1]) {
        rejects(() => texture.uploadBytes(source, 0, 0, face));
      }
    }
    rejects(() => flat.uploadBytes(source, 4));
    check(calls === 184, "invalid texture bytes reached the GPU");
    check(gl.getError() === gl.NO_ERROR, "texture bytes polluted GL state");
    flat.dispose();
    rejects(() => flat.uploadBytes(source, 0));
    c.dispose();
    rejects(() => cube.uploadBytes(source, 0));
    return { passed: true };
  } finally {
    uploads.texSubImage2D = upload;
    gl.deleteFramebuffer(framebuffer);
    c.dispose();
    check(live.size === 0, "byte textures retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
