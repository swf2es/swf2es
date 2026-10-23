import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { fixtureSource } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
mkdirSync(out, { recursive: true });
libraryAbcs();
const scripts = compileScripts(
  ["Composition", "StageLayout"].map((name) => ({ name, source: fixtureSource(name) })),
  out,
);
for (const name of ["Composition", "StageLayout"]) {
  const abc = scripts.get(name);
  assert.ok(abc);
  writeFileSync(`${out}${name}.swf`, bare(abc, 1, name, 96, 96));
}

interface Surface {
  slot: number;
  destroyed: boolean;
  handles: number;
  listeners: number;
  width: number;
  height: number;
  x: number;
  y: number;
}
interface Status {
  ready: boolean;
  errors: string[];
  canvases: number;
  overlayWidth: number;
  surfaces: Surface[];
}
interface Reference {
  points: number[][];
  samples: string[][];
}
interface Viewport {
  width: number;
  height: number;
  points: number[][];
  states: { scale: string; salign: string; samples: string[] }[];
}

await withPage(
  "runSwf",
  async (evaluate, send) => {
    const call = async <T>(name: string, ...args: (string | number | boolean)[]): Promise<T> => {
      const result = await evaluate<T>(
        `import("/repo/tests/context3d/host-page.ts").then(m => m.${name}(${args.map((arg) => JSON.stringify(arg)).join(",")}))`,
      );
      assert.equal(result.exception, null, JSON.stringify(result));
      return result.value as T;
    };
    const capture = async (
      name: string,
      width: number,
      height: number,
      points: number[][],
      samples: string[],
    ): Promise<void> => {
      const result = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const png = Buffer.from(result.data, "base64");
      writeFileSync(`${out}host-${name}.png`, png);
      const image = decodePng(png);
      assert.equal(image.width, width);
      assert.equal(image.height, height);
      for (let i = 0; i < points.length; i++) {
        const [x, y] = points[i];
        const pixel = image.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
        const expected = Buffer.from(samples[i], "hex");
        for (let c = 0; c < 4; c++) {
          assert.ok(
            Math.abs(pixel[c] - expected[c]) <= 1,
            `${name} (${x},${y}): ${pixel} != ${expected}`,
          );
        }
      }
    };
    const collect = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        await send("HeapProfiler.collectGarbage");
        await call("idle");
        if (await call<boolean>("collected")) {
          return;
        }
      }
      assert.fail("host retained retired objects");
    };
    const composition: Reference = JSON.parse(
      readFileSync(`${here}composition-reference.json`, "utf8"),
    );
    const viewport: Viewport = JSON.parse(readFileSync(`${here}viewport-reference.json`, "utf8"));
    await call("open", false);
    const unavailable = await call<Status>("status");
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.canvases, 1);
    assert.deepEqual(unavailable.surfaces, []);
    assert.deepEqual(unavailable.errors, []);
    await call("close");
    await collect();
    await call("open");
    try {
      await call("overlap", true);
      await capture(
        "overlap",
        96,
        96,
        [
          [12, 12],
          [52, 36],
        ],
        ["778899ff", "bbc3ccff"],
      );
      await call("overlap", false);
      for (let i = 0; i < composition.samples.length; i++) {
        await call("advance", i);
        await capture(`composition-${i}`, 96, 96, composition.points, composition.samples[i]);
      }
      assert.equal((await call<Status>("status")).canvases, 1);
      await call("reload");
      for (let i = 0; i < viewport.states.length; i++) {
        const state = viewport.states[i];
        await call("layout", state.scale, state.salign, viewport.width, viewport.height);
        await capture(
          `viewport-${i}`,
          viewport.width,
          viewport.height,
          viewport.points,
          state.samples,
        );
        for (const surface of (await call<Status>("status")).surfaces) {
          if (!surface.destroyed) {
            assert.equal(surface.width, 48);
            assert.equal(surface.height, 48);
            assert.equal(surface.listeners, 2);
          }
        }
      }
      await call("layout", "noScale", "TL", 96, 96);
      await send("Emulation.setDeviceMetricsOverride", {
        width: 400,
        height: 400,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await call("idle");
      const dense = await call<Status>("status");
      assert.equal(dense.overlayWidth, 192);
      for (const surface of dense.surfaces) {
        if (!surface.destroyed) {
          assert.equal(surface.width, 48);
          assert.equal(surface.height, 48);
          assert.equal(surface.x, surface.slot === 0 ? 8 : 24);
          assert.equal(surface.y, surface.slot === 0 ? 8 : 24);
        }
      }
      await send("Emulation.clearDeviceMetricsOverride");
      await call("layout", "noScale", "TL", 0, 0);
      await call("layout", "noScale", "TL", 96, 96);
      await call("recover");
      await capture("recovered", 96, 96, composition.points, composition.samples[0]);
      assert.deepEqual((await call<Status>("status")).errors, []);
    } finally {
      await call("close");
    }
    await collect();
    const liveLayout: {
      width: number;
      height: number;
      points: number[][];
      validation: string;
      states: { mode: string; align: string; state: string; samples: string[] }[];
    } = JSON.parse(readFileSync(`${here}stage-layout-reference.json`, "utf8"));
    await call("open", true, true, "StageLayout");
    try {
      await call("layout", "showAll", "", liveLayout.width, liveLayout.height);
      assert.equal(await call("scriptState", true), liveLayout.validation);
      const handles = (await call<Status>("status")).surfaces
        .filter((s) => !s.destroyed)
        .map((s) => s.handles);
      for (let i = 0; i < liveLayout.states.length; i++) {
        const state = liveLayout.states[i];
        assert.equal(await call("scriptLayout", state.mode, state.align), state.state);
        await call("idle");
        await capture(
          `stage-layout-${i}`,
          liveLayout.width,
          liveLayout.height,
          liveLayout.points,
          state.samples,
        );
        const active = (await call<Status>("status")).surfaces.filter((s) => !s.destroyed);
        assert.deepEqual(
          active.map((s) => s.handles),
          handles,
        );
        assert.ok(active.every((s) => s.width === 48 && s.height === 48));
      }
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 124,
        y: 104,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 124,
        y: 104,
        button: "left",
        clickCount: 1,
      });
      assert.equal(await call("pointerState"), "124,104,124,104");
      await call("scriptLayout", "noScale", "BR");
      await call("idle");
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 124,
        y: 104,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 124,
        y: 104,
        button: "left",
        clickCount: 1,
      });
      assert.equal(await call("pointerState"), "28,56,28,56");
      await call("scriptLayout", "noScale", "TL");
      await call("resize", 220, 160);
      assert.equal(await call("scriptState"), "noScale|TL|220|160|220,160,false,false,2,true;");
      await send("Emulation.setDeviceMetricsOverride", {
        width: 400,
        height: 400,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await call("idle");
      const dense = await call<Status>("status");
      assert.equal(dense.overlayWidth, 440);
      assert.ok(
        dense.surfaces.filter((s) => !s.destroyed).every((s) => s.width === 48 && s.height === 48),
      );
      assert.equal(await call("scriptState"), "noScale|TL|220|160|220,160,false,false,2,true;");
      await send("Emulation.clearDeviceMetricsOverride");
      await call("idle");
      await call("scriptLayout", "noScale", "TL");
      await call("resizeToShowAll");
      await call("resize", 240, 180);
      assert.equal(await call("scriptState"), "showAll|TL|96|96|240,180,false,false,2,true;");
      assert.equal((await call<Status>("status")).overlayWidth, 180);
      assert.deepEqual((await call<Status>("status")).errors, []);
    } finally {
      await call("close");
    }
    await collect();
    await call("open", false, true, "StageLayout");
    try {
      await call("layout", "noScale", "TL", 192, 144);
      assert.equal((await call<Status>("status")).canvases, 1);
      await capture("stage-layout-display-only", 192, 144, [[124, 104]], ["00ffffff"]);
    } finally {
      await call("close");
    }
    await collect();
    await call("queued");
    await collect();
    await call("cancelled");
    await collect();
    await call("failed");
    await collect();
    const heaps: number[] = [];
    for (let i = 0; i < 20; i++) {
      await call("open");
      if (i % 4 === 0) {
        await call("reload");
      }
      assert.deepEqual((await call<Status>("status")).errors, []);
      await call("close", i % 2 === 1);
      await collect();
      if (i === 3 || i === 19) {
        const heap = await send<{ usedSize: number; backingStorageSize: number }>(
          "Runtime.getHeapUsage",
        );
        heaps.push(heap.usedSize + heap.backingStorageSize);
      }
    }
    assert.ok(heaps[1] - heaps[0] < 1024 * 1024, `host heap growth: ${heaps}`);
    console.log(
      "context3d host: opt-in fallback, AIR composition/live Stage layout, input, resize/DPR, reentrancy, reload, loss/restoration and 20-load collection ok",
    );
  },
  false,
  {
    mounts: [
      ["/repo/", root],
      ["/context3d/", out],
    ],
    timeout: 180000,
  },
);
