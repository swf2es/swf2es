import { check, create, rejects } from "./context.ts";

export function bitmapUploads() {
  const owned = create();
  const { backend: c, gl, live } = owned;
  const uploads = gl as unknown as { texSubImage2D(...args: unknown[]): void };
  const upload = uploads.texSubImage2D.bind(gl);
  let staging: Uint8Array | null = null;
  let uploadCount = 0;
  uploads.texSubImage2D = (...args) => {
    const bytes = args[8];
    check(bytes instanceof Uint8Array, "bitmap upload did not use typed staging");
    check(!staging || staging === bytes, "bitmap upload replaced staging storage");
    staging = bytes;
    uploadCount++;
    upload(...args);
  };

  try {
    const texture = c.createTexture(16, 8);
    const large = new Uint32Array(32 * 16).fill(0xff4488cc);
    large[7 * 32 + 15] = 0xff112233;
    const odd = new Uint32Array(19 * 11).fill(0xff667788);
    odd[7 * 19 + 15] = 0xffaabbcc;
    const small = new Uint32Array([0x80402010]);
    texture.upload(large, 0, 0, 32, 16);
    check(staging, "no bitmap staging storage");
    const bytes: Uint8Array = staging;
    check(bytes.length === 16 * 8 * 4, "bitmap upload grew staging to the source size");
    const allocated = owned.created;

    for (let pass = 0; pass < 8; pass++) {
      for (let level = 0; level < texture.levels; level++) {
        const width = Math.max(1, 16 >> level);
        const height = Math.max(1, 8 >> level);
        const length = width * height * 4;
        const bitmap = pass % 2 ? odd : large;
        const stride = pass % 2 ? 19 : 32;
        const rows = pass % 2 ? 11 : 16;
        texture.upload(bitmap, level, 0, stride, rows);
        const source = bitmap[(height - 1) * stride + width - 1];
        const offset = length - 4;
        check(
          bytes[offset] === ((source >>> 16) & 255) &&
            bytes[offset + 1] === ((source >>> 8) & 255) &&
            bytes[offset + 2] === (source & 255) &&
            bytes[offset + 3] === 255,
          "bitmap upload ignored the source row stride",
        );
        bytes.fill(109, length);
        texture.upload(small, level, 0, 1, 1);
        check(
          bytes[0] === 64 && bytes[1] === 32 && bytes[2] === 16 && bytes[3] === 128,
          "bitmap upload changed premultiplied channels",
        );
        for (let i = 4; i < length; i++) {
          check(bytes[i] === 0, "small bitmap upload retained uncovered pixels");
        }

        for (let i = length; i < bytes.length; i++) {
          check(bytes[i] === 109, "small mip upload cleared unused staging storage");
        }

        check(owned.created === allocated, "warm bitmap uploads allocated GPU handles");
      }
    }

    const before = uploadCount;
    rejects(() => texture.upload(small, 0, 0, NaN, 1));
    rejects(() => texture.upload(small, 0, 0, 0, 1));
    rejects(() => texture.upload(small, 0, 0, 1, -1));
    rejects(() => texture.upload(small, 0, 0, 2, 1));
    rejects(() => texture.upload(large, texture.levels, 0, 32, 16));
    rejects(() => texture.upload(large, 0, 1, 32, 16));
    check(uploadCount === before && before === 81, "invalid bitmap upload reached WebGL");

    const cube = c.createTexture(8, 8, true);
    rejects(() => cube.upload(large, 1, 0, 32, 16));
    check(gl.getError() === gl.NO_ERROR, "GL error after bitmap uploads");

    return { passed: true };
  } finally {
    c.dispose();
    check(live.size === 0, "bitmap upload checks retained GPU handles");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
