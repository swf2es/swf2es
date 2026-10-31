import { decodeDxt, encodeDxt } from "@swf2es/context3d";
import { DxtEncoder } from "../../../packages/native/dist/render/index.js";
import { check, create } from "./context.ts";

/** Compressed pixel uploads reach the native encoder, or the identical fallback. */
export function dxtUploads() {
  for (const s3tc of [true, false]) {
    const { backend, gl, live } = create();
    const encoder = new DxtEncoder();
    const extension = gl.getExtension.bind(gl);
    if (!s3tc) {
      gl.getExtension = (name: string) =>
        name === "WEBGL_compressed_texture_s3tc" ? null : extension(name);
    }

    const compressed = s3tc && !!extension("WEBGL_compressed_texture_s3tc");
    let uploaded = new Uint8Array(0);
    const uploads = gl as unknown as {
      compressedTexSubImage2D(...args: unknown[]): void;
      texSubImage2D(...args: unknown[]): void;
    };
    const uploadBlocks = uploads.compressedTexSubImage2D.bind(gl);
    uploads.compressedTexSubImage2D = (...args) => {
      check(args[7] instanceof Uint8Array, "missing compressed upload bytes");
      uploaded = args[7].slice();
      uploadBlocks(...args);
    };
    const uploadPixels = uploads.texSubImage2D.bind(gl);
    uploads.texSubImage2D = (...args) => {
      check(args[8] instanceof Uint8Array, "missing pixel upload bytes");
      uploaded = args[8].slice();
      uploadPixels(...args);
    };
    backend.setDxtEncoder(encoder.encode);

    try {
      for (const dxt5 of [false, true]) {
        for (const cube of [false, true]) {
          const texture = backend.createTexture(
            16,
            cube ? 16 : 8,
            cube,
            dxt5 ? "compressedAlpha" : "compressed",
          );
          for (let face = 0; face < (cube ? 6 : 1); face++) {
            for (let level = 0; level < texture.levels; level++) {
              const w = Math.max(1, texture.width >> level);
              const h = Math.max(1, texture.height >> level);
              const rgba = new Uint8Array(w * h * 4);
              const bgra = new Uint8Array(rgba.length + 3);
              const pixels = new Uint32Array(w * h);
              for (let i = 0; i < pixels.length; i++) {
                const r = (i * 31 + face * 17) & 255;
                const g = (i * 53 + level * 23) & 255;
                const b = (i * 79 + 37) & 255;
                const a = (i * 97 + 101) & 255;
                rgba.set([r, g, b, a], i * 4);
                bgra.set([b, g, r, a], 3 + i * 4);
                pixels[i] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
              }

              const blocks = encodeDxt(rgba, dxt5, w, h).slice();
              const expected = compressed ? blocks : new Uint8Array(rgba.length);
              if (!compressed) {
                decodeDxt(blocks, dxt5, w, h, expected);
              }

              for (const bytes of [false, true]) {
                const before: number = encoder.encoded;
                if (bytes) {
                  texture.uploadBytes(bgra, 3, level, face);
                } else {
                  texture.upload(pixels, level, face);
                }

                check(
                  encoder.encoded === before + 1,
                  "compressed upload skipped the native encoder",
                );
                check(
                  expected.every((byte, i) => uploaded[i] === byte),
                  "native compressed upload differs from TypeScript",
                );
              }

              let refused = false;
              backend.setDxtEncoder(() => {
                refused = true;
                return null;
              });
              texture.uploadBytes(bgra, 3, level, face);
              check(refused, "compressed upload skipped its supplied encoder");
              check(
                expected.every((byte, i) => uploaded[i] === byte),
                "refused encoder changed the upload",
              );
              backend.setDxtEncoder(encoder.encode);
            }
          }

          texture.dispose();
        }
      }

      check(gl.getError() === gl.NO_ERROR, "GL error after native DXT uploads");
    } finally {
      encoder.release();
      backend.dispose();
      check(live.size === 0, "native DXT uploads retained GPU handles");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  return { passed: true };
}
