// Multi-draw run boundaries and changing row data must draw exactly as individual draws do.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<{ frames: number; largest: number }>(`(async () => {
    const { RenderView } = await import("@swf2es/player/scene");
    const { Container, TRANSFORM } = await import("/player/display/display.js");
    const { Drawing } = await import("/player/display/drawing.js");
    const { BitmapStore } = await import("/player/bitmap/bitmap.js");
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
    let uploads = 0, bufferUploads = 0;
    const bufferUpload = multi.gl.bufferSubData;
    multi.gl.bufferSubData = function (...args) {
      bufferUploads++;
      return bufferUpload.apply(this, args);
    };
    let copies = 0;
    const copyBuffer = multi.gl.copyBufferSubData;
    multi.gl.copyBufferSubData = function (...args) {
      copies++;
      return copyBuffer.apply(this, args);
    };
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
      for (const count of [513, 1, 31, 32, 255, 256, 257]) {
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
        for (let frame = 0; frame < 6; frame++) {
          multi.backend.draws.runTableMost = frame === 1 ? 1 : multi.gl.getParameter(multi.gl.MAX_TEXTURE_SIZE);
          if (frame) {
            for (const shape of root.children) {
              shape.matrix.tx += 1;
              shape.invalidate(TRANSFORM);
            }
          }
          if (frame === 4) {
            // Reordering changes the cached stream even when no geometry changed.
            root.addChildAt(root.children[0], root.children.length - 1);
          }
          if (frame === 5) {
            const drawing = root.children[0].drawing;
            drawing.clear();
            drawing.beginFill({ type: "solid", color: 0xff42ab73 });
            drawing.drawRect(0, 0, 3, 5);
            drawing.endFill();
          }
          const expected = capture(single, root);
          uploads = 0;
          bufferUploads = 0;
          const actual = capture(multi, root);
          const fallback = frame === 1 && count > 256;
          if (multi.backend.draws.prepared === fallback || uploads !== (fallback ? Math.ceil(count / 256) : 1)) {
            throw new Error(count + " draws, frame " + frame + ": unexpected table uploads");
          }
          if (frame === 2 && count >= 32 && multi.backend.draws.batches.indexTop === 0) {
            throw new Error("Stable small geometries were not merged");
          }
          if (frame === 3 && bufferUploads !== 0) {
            throw new Error("Moving unchanged geometry uploaded the batch again");
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
      // Slot churn, sampling changes and meshes split runs; masks and cached groups
      // make commands execute in a different order from their preparation.
      for (const compact of [false, true]) {
        const root = new Container();
        const images = Array.from({ length: compact ? 4 : 24 }, (_, i) => {
          const image = new BitmapStore(2, 2, true, (0xff000000 | ((i + 1) * 65171)) >>> 0);
          image.setPixel32(0, 0, 0xffffffff);
          return image;
        });
        const shapes = [];
        for (let group = 0; group < 6; group++) {
          const held = new Container();
          held.setCachedAsBitmap(true);
          root.addChildAt(held, root.children.length);
          for (let n = 0; n < 48; n++) {
            const i = group * 48 + n;
            const shape = new Container();
            const drawing = new Drawing();
            drawing.beginFill({
              type: "image", image: images[i % images.length],
              matrix: { a: 1.5, b: 0, c: 0, d: 1.5, tx: 0.25, ty: 0.25 },
              repeat: !!(i & 1), smooth: !!(i & 2),
            });
            if (!compact && n % 13 === 0) {
              drawing.drawTriangles([0, 0, 6, 0, 0, 6], null, [0, 0, 1, 0, 0, 1], 0);
            } else {
              drawing.drawRect(0, 0, 6, 6);
            }
            drawing.endFill();
            shape.drawing = drawing;
            shape.matrix.tx = (i % 32) * (compact ? 5 : 8);
            shape.matrix.ty = Math.floor(i / 32) * (compact ? 5 : 8);
            if (compact) {
              shape.colorTransform = {
                rMul: 0.7, gMul: 1, bMul: 0.5, aMul: 0.6,
                rAdd: i % 32, gAdd: 0, bAdd: 0, aAdd: 0,
              };
            }
            held.addChildAt(shape, n);
            shapes.push(shape);
          }
          const mask = new Container();
          const drawing = new Drawing();
          drawing.beginFill({ type: "solid", color: 0xffffffff });
          drawing.drawRect(2, 0, 250, 144);
          drawing.endFill();
          mask.drawing = drawing;
          root.addChildAt(mask, root.children.length);
          held.setMask(mask);
        }
        for (let frame = 0; frame < 3; frame++) {
          multi.backend.draws.runTableMost = frame === 1 ? 1 : multi.gl.getParameter(multi.gl.MAX_TEXTURE_SIZE);
          for (const shape of shapes) {
            shape.matrix.tx += 0.25;
            shape.invalidate(TRANSFORM);
          }
          images[frame].setPixel32(1, 1, 0xffff0080);
          const expected = capture(single, root);
          const actual = capture(multi, root);
          if (compact && frame === 2 && multi.backend.draws.batches.indexTop === 0) {
            throw new Error("Textured runs in held layers were not merged");
          }
          if (!expected.some((value, i) => i % 4 !== 3 && value !== 0)) {
            throw new Error("Empty textured reference frame");
          }
          for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expected[i]) {
              throw new Error("Textured frame " + frame + ", byte " + i + " differs");
            }
          }
          frames++;
        }
      }
      // A merged stream that grows past its buffers keeps its unchanged start on the GPU alone, and
      // one that then uses far less gives its room back: both draw as individual draws do.
      {
        const merged = multi.backend.draws.batches;
        multi.backend.draws.runTableMost = multi.gl.getParameter(multi.gl.MAX_TEXTURE_SIZE);
        const make = (i) => {
          const shape = new Container();
          const drawing = new Drawing();
          drawing.beginFill({ type: "solid", color: (0xff000000 | ((i + 7) * 40503)) >>> 0 });
          drawing.drawRect(0, 0, 5, 5);
          drawing.endFill();
          shape.drawing = drawing;
          shape.matrix.tx = (i * 7) % 250;
          shape.matrix.ty = (i * 11) % 138;
          return shape;
        };
        const root = new Container();
        // Past a run of 256, which stays as it was while the stream grows after it.
        for (let i = 0; i < 300; i++) {
          root.addChildAt(make(i), i);
        }
        const compare = (label) => {
          const expected = capture(single, root);
          const actual = capture(multi, root);
          for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expected[i]) {
              throw new Error(label + ", byte " + i + " differs");
            }
          }
          frames++;
        };
        for (let frame = 0; frame < 3; frame++) {
          compare("small stream, frame " + frame);
        }
        const small = merged.vertexCapacity;
        copies = 0;
        for (let i = 300; i < 10300; i++) {
          root.addChildAt(make(i), i);
        }
        for (let frame = 0; frame < 3; frame++) {
          compare("grown stream, frame " + frame);
        }
        const grown = merged.vertexCapacity;
        const grownStaging = merged.words.length;
        if (!(small > 0 && grown > small) || merged.indexTop === 0 || copies === 0) {
          throw new Error("The merged stream did not grow, keeping its start");
        }
        copies = 0;
        while (root.children.length > 300) {
          root.removeChild(root.children[root.children.length - 1]);
        }
        // Past two watches of 240 frames, one of them wholly after the large stream.
        for (let frame = 0; frame < 490; frame++) {
          compare("shrunk stream, frame " + frame);
        }
        if (!(merged.vertexCapacity < grown && merged.words.length < grownStaging) || copies === 0) {
          throw new Error("The merged stream kept its room");
        }
        bufferUploads = 0;
        compare("still stream");
        if (bufferUploads !== 0) {
          throw new Error("An unchanged stream uploaded again after shrinking");
        }
      }
      const table = multi.backend.draws.runTable;
      const batches = multi.backend.draws.batches;
      if (!multi.gl.isTexture(table)) {
        throw new Error("Missing draw table");
      }
      multi.destroy();
      destroyed = true;
      if (multi.gl.isContextLost() || multi.gl.isTexture(table) ||
          multi.gl.isVertexArray(batches.vertexArray) ||
          multi.gl.isBuffer(batches.vertexBuffer) || multi.gl.isBuffer(batches.indexBuffer)) {
        throw new Error("Draw table survived renderer destruction");
      }
      return { frames, largest };
    } finally {
      extension.multiDrawElementsWEBGL = draw;
      multi.gl.texSubImage2D = upload;
      multi.gl.bufferSubData = bufferUpload;
      multi.gl.copyBufferSubData = copyBuffer;
      if (!destroyed) {
        multi.destroy();
      }
      multi.gl.getExtension("WEBGL_lose_context")?.loseContext();
      single.destroy();
    }
  })()`),
  process.argv.includes("--gpu"),
);
assert.equal(exception, null);
assert.deepEqual(value, { frames: 48 + 3 + 3 + 490 + 1, largest: 256 });
console.log("multi-draw: ok");
