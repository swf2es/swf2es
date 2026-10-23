import assert from "node:assert/strict";
import type { App } from "./app.ts";

/** Exercise the desktop's actual surface factory, including its unchanged byte budget. */
export async function textureLimits(app: App): Promise<void> {
  const result = await app.evaluate(`(async () => {
    const { createStage3D } = await import("/renderer/stage3d.js");
    const surface = createStage3D(0);
    const c = surface.context, gl = surface.canvas.getContext("webgl2");
    const live = new Set();
    let created = 0;
    const make = gl.createTexture.bind(gl), drop = gl.deleteTexture.bind(gl);
    gl.createTexture = () => {
      const handle = make();
      if (handle) { live.add(handle); created++; }
      return handle;
    };
    gl.deleteTexture = handle => { live.delete(handle); drop(handle); };
    function check(value, message) { if (!value) throw new Error(message); }
    function rejected(operation) {
      const before = created;
      let threw = false;
      try { operation(); } catch { threw = true; }
      check(threw, "texture limit was not enforced");
      check(created === before, "rejected texture allocated a GPU handle");
    }

    let peak = 0, error;
    try {
      const textures = [];
      for (let i = 0; i < 1024; i++) {
        switch (i % 3) {
          case 0: textures.push(c.createTexture(8, 8)); break;
          case 1: textures.push(c.createRectangleTexture(8, 8)); break;
          case 2: textures.push(c.createTexture(8, 8, true)); break;
        }
      }
      peak = live.size;
      rejected(() => c.createTexture(8, 8));
      rejected(() => c.createRectangleTexture(8, 8));
      rejected(() => c.createTexture(8, 8, true));
      textures[0].dispose();
      const replacement = c.createTexture(8, 8);
      check(live.size === peak, "disposal did not release the texture count");
      rejected(() => c.createTexture(8, 8));
      for (let i = 0; i < textures.length; i++) {
        textures[i].dispose();
      }
      replacement.dispose();
      check(live.size === 0, "explicit disposal retained GPU textures");

      // Twelve full 1024-square mip chains leave exactly 16 bytes of the 64 MiB budget.
      for (let i = 0; i < 12; i++) {
        c.createTexture(1024, 1024);
      }
      rejected(() => c.createTexture(2, 2));
      for (let i = 0; i < 4; i++) {
        c.createTexture(1, 1);
      }
      rejected(() => c.createTexture(1, 1));
      check(live.size === 16, "byte-limit rejection changed existing textures");
      error = gl.getError();
    } finally {
      c.dispose();
      surface.destroy();
    }
    return { peak, live: live.size, error, lost: gl.isContextLost() };
  })()`);
  assert.deepEqual(result, { peak: 1024, live: 0, error: 0, lost: true });
}
