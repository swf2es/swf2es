import { Context3DError } from "@swf2es/context3d";
import { check, create } from "./context.ts";

export function byteBudgets() {
  const owned = create({
    maxBufferBytes: 44,
    maxVertexBufferBytes: 32,
    maxIndexBufferBytes: 12,
    maxTextureBytes: 5272,
    max2DTextureBytes: 768,
    maxRectangleTextureBytes: 512,
    maxCubeTextureBytes: 4608,
  });
  const c = owned.backend;
  const limited = (operation: () => unknown): void => {
    const before = owned.created;
    let error: unknown;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    check(error instanceof Context3DError && error.reason === "limit", "wrong budget error");
    check(owned.created === before, "budget rejection allocated a handle");
  };
  try {
    const factories = [
      () => c.createBuffer(1, 4),
      () => c.createBuffer(3, 0),
      () => c.createTexture(8, 8),
      () => c.createRectangleTexture(8, 8),
      () => c.createTexture(8, 8, true),
    ];
    const resources: { dispose(): void }[] = [];
    for (let i = 0; i < factories.length; i++) {
      const make = factories[i];
      const first = make();
      resources.push(make());
      limited(make);
      first.dispose();
      first.dispose();
      resources.push(make());
      limited(make);
    }
    for (let i = 0; i < resources.length; i++) {
      resources[i].dispose();
    }
    for (let i = 0; i < factories.length; i++) {
      factories[i]().dispose();
    }
    check(owned.gl.getError() === owned.gl.NO_ERROR, "byte budgets changed GL state");
  } finally {
    c.dispose();
    check(owned.live.size === 0, "byte budgets retained GPU handles");
    owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const reserve = create({ max2DTextureBytes: 5 });
  try {
    let error: unknown;
    try {
      reserve.backend.createTexture(1, 1);
    } catch (caught) {
      error = caught;
    }
    check(error instanceof Context3DError && error.reason === "limit", "missing AIR mip reserve");
    check(reserve.live.size === 1, "mip reservation failure created a texture handle");
  } finally {
    reserve.backend.dispose();
    check(reserve.live.size === 0, "mip reservation check retained GPU handles");
    reserve.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // AIR charges DXT1 an eighth of BGRA's reservation and DXT5 a quarter: an
  // 8x8 texture 48 bytes and 96, a cube of 8 288 and 576. Storage is the
  // chain's blocks, the 4x4, 2x2 and 1x1 levels a block each, or RGBA where
  // the context decodes S3TC itself.
  for (const s3tc of [true, false]) {
    const compressed = create({
      max2DTextureBytes: 96 * 2,
      maxCubeTextureBytes: 576,
      maxTextureBytes: 1 << 20,
    });
    if (!s3tc) {
      const gl = compressed.gl as { getExtension(name: string): unknown };
      const get = gl.getExtension.bind(gl);
      gl.getExtension = (name) => (name === "WEBGL_compressed_texture_s3tc" ? null : get(name));
    }
    const c = compressed.backend;
    try {
      const held = [0, 1, 2, 3].map(() => c.createTexture(8, 8, false, "compressed"));
      let error: unknown;
      try {
        c.createTexture(8, 8, false, "compressed");
      } catch (caught) {
        error = caught;
      }
      check(error instanceof Context3DError && error.reason === "limit", "DXT1 over its quota");
      held[0].dispose();
      held[1].dispose();
      held.push(c.createTexture(8, 8, false, "compressedAlpha"));
      error = undefined;
      try {
        c.createTexture(8, 8, false, "compressedAlpha");
      } catch (caught) {
        error = caught;
      }
      check(error instanceof Context3DError && error.reason === "limit", "DXT5 over its quota");
      const cubes = [
        c.createTexture(8, 8, true, "compressed"),
        c.createTexture(8, 8, true, "compressed"),
      ];
      error = undefined;
      try {
        c.createTexture(8, 8, true, "compressed");
      } catch (caught) {
        error = caught;
      }
      check(
        error instanceof Context3DError && error.reason === "limit",
        "cube DXT1 over its quota",
      );
      // Blocks, pixels encoded to blocks over them, then blocks again.
      const t = held[2];
      t.uploadCompressed(new Uint8Array(32));
      t.upload(new Uint32Array(64));
      t.uploadCompressed(new Uint8Array(8), 1);
      for (const r of [...held.slice(2), ...cubes]) {
        r.dispose();
      }
      check(
        compressed.gl.getError() === compressed.gl.NO_ERROR,
        "compressed textures left a GL error",
      );
      // The aggregate counts S3TC's blocks whatever the storage: an 8x8 DXT1 chain is
      // 32 + 8 + 8 + 8 bytes, so one fits in 56 and a second does not, on any GPU.
      const tight = create({ maxTextureBytes: 56 });
      if (!s3tc) {
        const gl = tight.gl as { getExtension(name: string): unknown };
        const get = gl.getExtension.bind(gl);
        gl.getExtension = (name) => (name === "WEBGL_compressed_texture_s3tc" ? null : get(name));
      }
      try {
        tight.backend.createTexture(8, 8, false, "compressed");
        let over: unknown;
        try {
          tight.backend.createTexture(8, 8, false, "compressed");
        } catch (caught) {
          over = caught;
        }
        check(over instanceof Context3DError && over.reason === "limit", "aggregate counts blocks");
        over = undefined;
        try {
          tight.backend.createTexture(2, 2, false, "compressed");
        } catch (caught) {
          over = caught;
        }
        check(over instanceof Context3DError && over.reason === "compressedSize", "4x4 at least");
      } finally {
        tight.backend.dispose();
        tight.gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    } finally {
      c.dispose();
      check(compressed.live.size === 0, "compressed textures retained GPU handles");
      compressed.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  return { passed: true };
}
