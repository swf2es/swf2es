// Repacking filtered content onto smaller pages must preserve the large-page output.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

interface Result {
  software: boolean;
  frame: number;
  samples: number;
  resolution: number;
  different: number;
  worst: number;
  pages: number;
  rebuilds: number;
}

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<Result[]>(`(async () => {
  const { RenderView } = await import("@swf2es/player/scene");
  const { Container, CONTENT } = await import("/player/display/display.js");
  const { ShapeObject } = await import("/player/display/shapeobject.js");
  const { Drawing } = await import("/player/display/drawing.js");
  const { filterDefaults } = await import("/player/display/filters.js");
  const results = [];
  const probe = document.createElement("canvas").getContext("webgl2", { antialias: false });
  if (!probe) {
    throw new Error("WebGL2 unavailable");
  }
  const color = probe.getInternalformatParameter(probe.RENDERBUFFER, probe.RGBA8, probe.SAMPLES);
  const depth = probe.getInternalformatParameter(
    probe.RENDERBUFFER,
    probe.DEPTH24_STENCIL8,
    probe.SAMPLES,
  );
  const supported = [1, 4, 8, 16].filter(
    (n) => n === 1 || (color.includes(n) && depth.includes(n)),
  );
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  for (const samples of supported) {
    for (const resolution of [1, 2]) {
      const images = [];
      let pages = 0,
        rebuilds = 0;
      for (const packed of [false, true]) {
        const view = new RenderView({
          width: 512,
          height: 384,
          resolution,
          samples,
          preserveDrawingBuffer: true,
        });
        const gl = view.gl;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const software = /SwiftShader/.test(
          gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        );
        const held = view.backend.holds;
        const level = held.drawHoldLevel;
        held.drawHoldLevel = function (from, to, ...args) {
          if (packed) {
            rebuilds++;
            return level.call(this, from, to, ...args);
          }
          // Retain the previous 256 MiB layout as a pixel reference. Only the first
          // reset packs content; subsequent resets pack filter outputs.
          const shelves = this.shelves,
            reset = shelves.reset;
          const samples = this.pool.frameSamples,
            most = this.textureMost;
          let content = true;
          shelves.reset = function (width, height) {
            if (content && samples > 1) {
              height = Math.min(
                most,
                Math.floor((256 * 1024 * 1024) / (width * samples * 8) / 128) * 128,
              );
            }
            content = false;
            return reset.call(this, width, height);
          };
          try {
            return level.call(this, from, to, ...args);
          } finally {
            shelves.reset = reset;
          }
        };
        const takePage = held.takePage;
        held.takePage = function (...args) {
          pages++;
          return takePage.apply(this, args);
        };
        const root = new Container();
        const drawing = new Drawing();
        drawing.beginFill({ type: "solid", color: 0xff30a0e0 });
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            drawing.drawRect(x * 6, y * 6, 3, 3);
          }
        }
        drawing.endFill();
        // Keep total content area dense at both resolutions, without duplicating geometry.
        const count = resolution === 1 ? 2048 : 512;
        for (let i = 0; i < count; i++) {
          const branch = new Container();
          const shape = new ShapeObject(null);
          shape.drawing = drawing;
          branch.addChildAt(shape, 0);
          branch.filters = [{ ...filterDefaults("blur"), blurX: 4, blurY: 4, quality: 1 }];
          branch.matrix.tx = (i % 8) * 60;
          branch.matrix.ty = (Math.floor(i / 8) % 6) * 60;
          root.addChildAt(branch, i);
        }
        try {
          for (let frame = 0; frame < 3; frame++) {
            for (const branch of root.children) {
              branch.matrix.tx += frame === 1 ? 2 : -1;
              branch.invalidate(CONTENT);
            }
            view.render(root);
            if ((view.backend.stage.stageMsaa?.samples ?? 1) !== samples) {
              throw new Error("Sample count changed");
            }
            const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(
              0,
              0,
              gl.drawingBufferWidth,
              gl.drawingBufferHeight,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              pixels,
            );
            if (!pixels.some((value) => value !== 0)) {
              throw new Error("Empty capture");
            }
            if (!packed) {
              images.push(pixels);
            } else {
              let different = 0,
                worst = 0;
              for (let i = 0; i < pixels.length; i++) {
                if (pixels[i] !== images[frame][i]) {
                  different++;
                  worst = Math.max(worst, Math.abs(pixels[i] - images[frame][i]));
                }
              }
              results.push({
                software,
                frame,
                samples,
                resolution,
                different,
                worst,
                pages,
                rebuilds,
              });
            }
            if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) {
              throw new Error("GL failure");
            }
          }
        } finally {
          view.destroy();
        }
      }
    }
  }
  return results;
})()`),
  process.argv.includes("--gpu"),
  { timeout: 180_000 },
);
assert.equal(exception, null);
assert.ok(value?.length);
for (const row of value) {
  // SwiftShader differs by up to three channel levels when this dense 2x blur is
  // repacked. Hardware captures match exactly, including 8x and 16x MSAA.
  const tolerance = row.software && row.resolution === 2 && row.samples === 4 ? 3 : 0;
  assert.ok(row.worst <= tolerance, JSON.stringify(row));
  assert.ok(
    row.frame < 2 || (row.pages > 1 && row.rebuilds > 0),
    `packed content must actually rebuild: ${JSON.stringify(row)}`,
  );
}
console.log(`packed-filters: ${value.length} pixel comparisons against large pages`);
