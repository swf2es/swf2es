// Multi-draw run boundaries and changing row data must draw exactly as individual draws do.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage("runSwf", (evaluate) =>
  evaluate<{ frames: number; largest: number }>(`(async () => {
    const { RenderView } = await import("@swf2es/player/scene");
    const { Container, TRANSFORM } = await import("/player/display/display.js");
    const { Drawing } = await import("/player/display/drawing.js");
    const options = { width: 256, height: 144, preserveDrawingBuffer: true };
    const multi = new RenderView({ ...options, canvas: document.createElement("canvas") });
    let destroyed = false;
    const prototype = WebGL2RenderingContext.prototype;
    const getExtension = prototype.getExtension;
    let single;
    try {
      prototype.getExtension = function (name) {
        return name === "WEBGL_multi_draw" ? null : getExtension.call(this, name);
      };
      single = new RenderView(options);
    } finally {
      prototype.getExtension = getExtension;
    }
    let frames = 0, largest = 0;
    const extension = multi.gl.getExtension("WEBGL_multi_draw");
    if (!extension || !multi.backend.draws.multi || single.backend.draws.multi) {
      throw new Error("Both multi-draw and individual draws are required");
    }
    const draw = extension.multiDrawElementsWEBGL;
    extension.multiDrawElementsWEBGL = function (...args) {
      largest = Math.max(largest, args[6]);
      return draw.apply(this, args);
    };
    let uploads = 0;
    const upload = multi.gl.texSubImage2D;
    multi.gl.texSubImage2D = function (...args) {
      if (args[6] === this.RED_INTEGER) {
        uploads++;
      }
      return upload.apply(this, args);
    };
    const capture = (view, root) => {
      view.render(root);
      const gl = view.gl;
      const pixels = new Uint8Array(256 * 144 * 4);
      gl.readPixels(0, 0, 256, 144, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
        throw new Error("GL failure");
      }
      return pixels;
    };
    try {
      for (const count of [513, 1, 255, 256, 257]) {
        const root = new Container();
        for (let i = 0; i < count; i++) {
          const shape = new Container();
          const drawing = new Drawing();
          drawing.beginFill({ type: "solid", color: (0xff000000 | ((i + 1) * 8761)) >>> 0 });
          drawing.drawRect(0, 0, 6, 6);
          drawing.endFill();
          shape.drawing = drawing;
          shape.matrix.tx = (i % 32) * 8;
          shape.matrix.ty = Math.floor(i / 32) * 8;
          root.addChildAt(shape, i);
        }
        for (let frame = 0; frame < 3; frame++) {
          multi.backend.draws.runTableMost = frame === 1 ? 1 : multi.gl.getParameter(multi.gl.MAX_TEXTURE_SIZE);
          if (frame) {
            for (const shape of root.children) {
              shape.matrix.tx += 1;
              shape.invalidate(TRANSFORM);
            }
          }
          const expected = capture(single, root);
          uploads = 0;
          const actual = capture(multi, root);
          const fallback = frame === 1 && count > 256;
          if (multi.backend.draws.prepared === fallback || uploads !== (fallback ? Math.ceil(count / 256) : 1)) {
            throw new Error(count + " draws, frame " + frame + ": unexpected table uploads");
          }
          if (!expected.some((value, i) => i % 4 !== 3 && value !== 0)) {
            throw new Error("Empty reference frame");
          }
          for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expected[i]) {
              throw new Error(count + " draws, frame " + frame + ", byte " + i + " differs");
            }
          }
          frames++;
        }
      }
      const table = multi.backend.draws.runTable;
      if (!multi.gl.isTexture(table)) {
        throw new Error("Missing draw table");
      }
      multi.destroy();
      destroyed = true;
      if (multi.gl.isContextLost() || multi.gl.isTexture(table)) {
        throw new Error("Draw table survived renderer destruction");
      }
      return { frames, largest };
    } finally {
      extension.multiDrawElementsWEBGL = draw;
      multi.gl.texSubImage2D = upload;
      if (!destroyed) {
        multi.destroy();
      }
      multi.gl.getExtension("WEBGL_lose_context")?.loseContext();
      single.destroy();
    }
  })()`),
);
assert.equal(exception, null);
assert.deepEqual(value, { frames: 15, largest: 256 });
console.log("multi-draw: ok");
