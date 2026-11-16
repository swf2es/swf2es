// The desktop app as a server or a CI runner runs it: in a window on an
// Xvfb, whose only GL is Mesa's llvmpipe, which Chromium's blocklist
// refuses, and with no switch of the test's for the GPU. The app falls back
// to SwiftShader, says so, and the SWF plays and draws; --software-gl does
// the same by choice. Skipped, saying why, where Electron was not downloaded
// or there is no Xvfb.
//
//   node tests/desktop/xvfb.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { decodePng } from "../player/image.ts";
import * as w from "../swf-writer.ts";
import { type App, display, withApp } from "./app.ts";

const why = missing();
if (why) {
  console.log(`desktop Xvfb test: skipped. ${why}`);
  process.exit(0);
}

const screen = await display();
if (!screen.xvfb) {
  screen.stop();
  console.log("desktop Xvfb test: skipped. There is no Xvfb.");
  process.exit(0);
}

const out = fileURLToPath(new URL("out/xvfb/", import.meta.url));
mkdirSync(out, { recursive: true });
// An AVM1 SWF, so no compiler is needed: the stage red all over, and a trace.
const text = "xvfb: started";
const movie = `${out}red.swf`;
writeFileSync(
  movie,
  w.swf({
    version: 8,
    width: 100,
    height: 50,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xffffff),
      w.shape({
        id: 1,
        bounds: [0, 2000, 0, 1000],
        fills: [0xff0000],
        paths: [
          {
            fill1: 1,
            commands: [
              { move: [0, 0] },
              { line: [2000, 0] },
              { line: [2000, 1000] },
              { line: [0, 1000] },
              { line: [0, 0] },
            ],
          },
        ],
      }),
      w.place({ depth: 1, character: 1 }),
      // ActionPush the string, ActionTrace, ActionEnd.
      w.doAction([0x96, text.length + 2, 0, 0, ...Buffer.from(text), 0, 0x26, 0]),
      w.showFrame(),
      w.end(),
    ],
  }),
);

/** The SWF traced, its stage fills the window red, and WebGL 2 is SwiftShader's. */
async function plays({ stdout, until, evaluate, devtools }: App): Promise<void> {
  await until("the SWF's trace", () => stdout.includes(text));

  // The trace comes as the first frame is built, before it is drawn.
  let centre: number[] = [];
  const red = "255,0,0";
  for (let tries = 0; centre.join() !== red && tries < 100; tries++) {
    const { data } = await devtools.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    const at = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
    centre = [...image.data.subarray(at, at + 3)];
    await new Promise((done) => setTimeout(done, 100));
  }

  assert.equal(centre.join(), red);

  const renderer = await evaluate<string>(`(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  })()`);
  assert.match(renderer, /SwiftShader/);
}

try {
  await withApp(
    screen.env,
    { recent: [] },
    [movie],
    async (app) => {
      await plays(app);
      await app.until("the fallback said", () =>
        app.stderr().includes("drawing with SwiftShader, on the CPU"),
      );
      assert.match(app.stderr(), /swf2es: no GPU Chromium takes here/);
    },
    { plain: true },
  );

  await withApp(
    screen.env,
    { recent: [] },
    ["--software-gl", movie],
    async (app) => {
      await plays(app);
      assert.match(app.stderr(), /swf2es: --software-gl: drawing with SwiftShader, on the CPU\n/);
      assert.doesNotMatch(app.stderr(), /no GPU Chromium takes here/);
    },
    { plain: true },
  );

  console.log("desktop Xvfb test: ok");
} finally {
  screen.stop();
}
