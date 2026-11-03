// Reusing a larger multisampled framebuffer must resolve only the requested rectangle,
// clear old pixels, and release it when idle or destroyed.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<{ checks: number; created: number; error: number }>(`(async () => {
    const { GlState } = await import("@swf2es/context3d/device");
    const { TargetPool } = await import("/render/webgl/targets.js");
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl || gl.getParameter(gl.MAX_SAMPLES) < 4) { throw new Error("Four samples required"); }
    const state = new GlState(gl);
    const pool = new TargetPool(gl, state);
    let checks = 0, created = 0;
    const check = (ok, why) => { if (!ok) { throw new Error(why); } checks++; };
    const make = gl.checkFramebufferStatus.bind(gl);
    gl.checkFramebufferStatus = (...args) => { created++; return make(...args); };
    const paint = (msaa, color) => {
      state.bindFramebuffer(msaa.framebuffer);
      state.scissor(null);
      gl.clearColor(...color);
      gl.clearStencil(0);
      gl.stencilMask(255);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    };
    const resolve = (layer, msaa) => pool.resolve({layer, msaa}, layer.width, layer.height);
    const big = pool.takeLayer(96, 64, true);
    const small = pool.takeLayer(80, 48, true);
    const tiny = pool.takeLayer(16, 16, true);
    const original = pool.layerMsaa(big, 4);
    check(!!original, "initial target");
    paint(original, [1, 0, 1, 1]);
    resolve(big, original);
    try {
      for (let frame = 0; frame < 120; frame++) {
        const layer = frame % 2 ? big : small;
        const msaa = pool.layerMsaa(layer, 4);
        check(msaa === original, "size changes must reuse the same buffer");
        paint(msaa, [0, 0, 1, 1]);
        state.scissor([0, 0, layer.width / 2, layer.height]);
        gl.clearColor(0, 1, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        state.scissor(null);
        resolve(layer, msaa);
        state.bindFramebuffer(layer.framebuffer);
        const pixels = new Uint8Array(layer.width * layer.height * 4);
        gl.readPixels(0, 0, layer.width, layer.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let y = 0; y < layer.height; y++) {
          for (let x = 0; x < layer.width; x++) {
            const at = (y * layer.width + x) * 4;
            const left = x < layer.width / 2;
            check(pixels[at] === 0 && pixels[at + 1] === (left ? 255 : 0) &&
              pixels[at + 2] === (left ? 0 : 255) && pixels[at + 3] === 255,
              "resolve changed pixels or retained old content");
          }
        }
        pool.endFrame();
      }
      check(created === 1, "warm reuse must not allocate or query the driver again");
      const active = pool.layerMsaa(big, 4);
      const other = pool.layerMsaa(small, 4);
      check(active !== other, "active targets cannot be shared");
      resolve(big, active);
      resolve(small, other);
      const bounded = pool.layerMsaa(tiny, 4);
      check(bounded !== original && bounded !== other, "small layers must not take huge buffers");
      resolve(tiny, bounded);
      pool.giveLayer(big);
      pool.giveLayer(small);
      pool.giveLayer(tiny);
      for (let i = 0; i < 62; i++) { pool.endFrame(); }
      check(!gl.isFramebuffer(original.framebuffer), "idle framebuffer must be deleted");
      check(!gl.isRenderbuffer(original.color), "idle color buffer must be deleted");
      check(!gl.isRenderbuffer(original.depthStencil), "idle stencil buffer must be deleted");
      const wide = pool.takeLayer(128, 64, true);
      pool.giveLayer(wide);
      const fitted = pool.takeLayer(64, 64);
      check(fitted === wide, "ordinary layers may reuse up to twice their rounded area");
      pool.giveLayer(fitted);
      const undersized = pool.takeLayer(16, 16);
      check(undersized !== wide, "tiny layers must not inherit oversized textures and MSAA");
      pool.giveLayer(undersized);
      const exact = pool.takeLayer(64, 64, true);
      check(exact !== wide && exact.width === 64, "exact requests must not take fitting textures");
      pool.giveLayer(exact);
      check(pool.takeLayer(128, 64) === wide, "rejected oversized textures remain reusable");
      pool.giveLayer(wide);
      const layer = pool.takeLayer(96, 64, true);
      const last = pool.layerMsaa(layer, 4);
      resolve(layer, last);
      pool.giveLayer(layer);
      pool.destroy();
      check(!gl.isFramebuffer(last.framebuffer), "destroy must release recycled targets");
      return {checks, created, error: gl.getError()};
    } finally {
      pool.destroy();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  })()`),
  process.argv.includes("--gpu"),
);
assert.equal(exception, null);
assert.ok(value);
assert.equal(value.error, 0);
assert.equal(value.created, 4);
console.log(`render-targets: ${value.checks} pixel/reuse checks, bounded allocation and cleanup`);
