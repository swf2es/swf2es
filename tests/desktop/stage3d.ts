// The normal Electron player: Stage3D on by default, and turned off and on by its View menu.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { bare } from "../player/cases.ts";
import { decodePng } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { type App, display, withApp } from "./app.ts";
import { textureLimits } from "./stage3d-limits.ts";

const why = missing();
if (why) {
  console.log(`desktop Stage3D test: skipped. ${why}`);
  process.exit(0);
}

const out = fileURLToPath(new URL("out/stage3d/", import.meta.url));
mkdirSync(out, { recursive: true });
libraryAbcs();
const scripts = compileScripts(
  [
    {
      name: "StageLayout",
      source: readFileSync(new URL("../context3d/StageLayout.as", import.meta.url), "utf8"),
    },
    {
      name: "StageWorker",
      source: readFileSync(new URL("../context3d/StageWorker.as", import.meta.url), "utf8"),
    },
    {
      name: "Plain",
      source: readFileSync(new URL("./Plain.as", import.meta.url), "utf8"),
    },
  ],
  out,
);
const movie = `${out}layout.swf`;
writeFileSync(movie, bare(scripts.get("StageLayout") as Uint8Array, 1, "StageLayout", 120, 100));
// An AS3 SWF that never asks for a Context3D.
const plain = `${out}plain.swf`;
writeFileSync(plain, bare(scripts.get("Plain") as Uint8Array, 1, "Plain", 120, 100));
const replacement = `${out}replacement.swf`;
copyFileSync(movie, replacement);
const workerMovie = `${out}worker.swf`;
writeFileSync(
  workerMovie,
  bare(scripts.get("StageWorker") as Uint8Array, 1, "StageWorker", 96, 96),
);
const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const player = 'document.getElementById("player")';
const canvases = `${player}.shadowRoot.querySelectorAll("canvas")`;

async function waitFor(app: App, expression: string): Promise<void> {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    try {
      if (await app.evaluate<boolean>(expression)) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Cannot find context")) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Cannot find default execution context")
        ) {
          throw error;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`Stage3D did not settle: ${expression}\n${app.stdout.join("\n")}\n${app.stderr()}`);
}

async function menu(app: App, id: string, checked?: boolean): Promise<void> {
  await app.main(`(() => {
    const electron = process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron");
    const item = electron.Menu.getApplicationMenu().getMenuItemById(${JSON.stringify(id)});
    if (!item || !item.enabled) throw new Error("menu item unavailable");
    ${checked === undefined ? "" : `if (item.checked === ${checked}) throw new Error("menu choice already set");`}
    item.click(item, electron.BrowserWindow.getAllWindows()[0]);
    return true;
  })()`);
}

const ready = `(() => {
  const p = ${player}?.player;
  if (!p?.scripting || !p.root?.object) {
    return false;
  }

  return !!p.scripting.rt.getProperty(p.root.object, p.scripting.rt.publicName("ready"));
})()`;

/** Whether the movie playing is the SWF named `name`. */
const playing = (name: string) => `(() => {
  const p = ${player}?.player, rt = p?.scripting?.rt;
  if (!rt || !p.root?.object) {
    return false;
  }

  const info = rt.getProperty(p.root.object, rt.publicName("loaderInfo"));
  return rt.getProperty(info, rt.publicName("url")).endsWith(${JSON.stringify(`/${name}`)});
})()`;

async function layout(app: App, mode: string, align: string): Promise<string> {
  return app.evaluate<string>(`(() => {
    const p = ${player}.player, rt = p.scripting.rt, object = p.root.object;
    return rt.callValue(rt.getProperty(object, rt.publicName("configureLayout")), object,
      [${JSON.stringify(mode)}, ${JSON.stringify(align)}], null);
  })()`);
}

async function frame(app: App): Promise<void> {
  await app.evaluate(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
}

async function pixels(app: App): Promise<void> {
  await frame(app);
  const { data } = await app.devtools.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  });
  const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
  for (const [x, y, color] of [
    [12, 12, [255, 0, 0]],
    [28, 28, [0, 0, 255]],
    [36, 36, [255, 255, 255]],
    [52, 36, [127, 127, 255]],
  ] as const) {
    const offset = (y * image.width + x) * 4;
    assert.deepEqual([...image.data.subarray(offset, offset + 3)], [...color], `pixel ${x},${y}`);
  }
}

const screen = await display();
try {
  // On by default: a fresh profile, and one where the opt-in this replaced saved its `false` with
  // every other setting, play Stage3D with nothing chosen.
  for (const settings of [{}, { stage3D: false, recent: [], sockets: {} }]) {
    await withApp(screen.env, settings, [movie], async (app) => {
      await app.devtools.send("Emulation.setDeviceMetricsOverride", {
        width: 200,
        height: 160,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await waitFor(app, `${ready} && ${canvases}.length === 3`);
      assert.match(await layout(app, "noScale", "TL"), /^noScale\|TL\|200\|160\|/);
      await pixels(app);
      assert.equal(
        app.stdout.some((line) => line.startsWith("stagelayout error")),
        false,
        app.stdout.join("\n"),
      );
      assert.equal(
        "stage3DChoice" in JSON.parse(readFileSync(`${app.userData}/settings.json`, "utf8")),
        false,
      );
    });
  }

  // The backend loads at a SWF's first requestContext3D: never for one that does not ask.
  await withApp(screen.env, {}, [], async (app) => {
    const loads: string[] = [];
    app.devtools.listeners.set("Network.requestWillBeSent", (params) => {
      const url = (params.request as { url: string }).url;
      if (url.includes("/modules/context3d/webgl/")) {
        loads.push(url);
      }
    });
    await app.devtools.send("Network.enable");
    assert.equal(await app.again([plain]), 0);
    await waitFor(app, `${playing("plain.swf")} && ${ready}`);
    await frame(app);
    assert.deepEqual(loads, []);
    assert.equal(await app.evaluate(`${canvases}.length`), 1);

    assert.equal(await app.again([movie]), 0);
    await waitFor(app, `${playing("layout.swf")} && ${ready} && ${canvases}.length === 3`);
    assert.notDeepEqual(loads, []);
    await app.devtools.send("Network.disable");
    app.devtools.listeners.delete("Network.requestWillBeSent");
  });

  await withApp(screen.env, { stage3DChoice: false }, [movie, "--inspect=0"], async (app) => {
    await app.until(
      "the fallback of Stage3D turned off",
      () => app.stdout.filter((s) => s.startsWith("stagelayout error 3702")).length === 2,
    );
    assert.equal(await app.evaluate(`${canvases}.length`), 1);

    await app.devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 200,
      height: 160,
      deviceScaleFactor: 1,
      mobile: false,
    });
    let paused = "";
    let sessionPaused = "";
    // The session's module is held the first time it loads alone: a reload takes it from the cache.
    let holdSession = true;
    app.devtools.listeners.set("Fetch.requestPaused", (params) => {
      const request = params.request as { url: string };
      if (!request.url.endsWith("/modules/web/stage3d.js")) {
        paused = String(params.requestId);
      } else if (holdSession) {
        sessionPaused = String(params.requestId);
      } else {
        void app.devtools.send("Fetch.continueRequest", { requestId: params.requestId });
      }
    });
    await app.devtools.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/modules/context3d/webgl/index.js" },
        { urlPattern: "*/modules/web/stage3d.js" },
      ],
    });
    // The session's module first, then the backend, at the SWF's first request; a movie closed
    // while the module loads reports no failure.
    await menu(app, "stage3d", true);
    await app.until("the Stage3D session's module", () => sessionPaused !== "");
    holdSession = false;
    await menu(app, "close-movie");
    await waitFor(app, `${player}.hidden && ${player}.player === null`);
    await frame(app);
    assert.equal(
      await app.evaluate('document.getElementById("failure").hidden'),
      true,
      "closing a pending movie reported a failure",
    );
    assert.equal(await app.again([movie]), 0);
    await app.devtools.send("Fetch.continueRequest", { requestId: sessionPaused });
    await app.until("the backend, at the first requestContext3D", () => paused !== "");
    await app.devtools.send("Fetch.failRequest", { requestId: paused, errorReason: "Failed" });
    await app.until(
      "the fallback after the backend import fails",
      () => app.stdout.filter((s) => s.startsWith("stagelayout error 3702")).length === 4,
    );
    assert.equal(await app.evaluate(`${player}.hidden`), false, "a cancelled load hid the movie");
    assert.equal(await app.evaluate(`${canvases}.length`), 1);
    assert.equal(await app.evaluate('document.getElementById("failure").hidden'), true);
    assert.equal(
      JSON.parse(readFileSync(`${app.userData}/settings.json`, "utf8")).stage3DChoice,
      true,
    );

    // The backend is tried again on a page reload, and a movie replaced while it loads gets its
    // contexts from that load.
    paused = "";
    await app.devtools.send("Page.reload", { ignoreCache: true });
    await app.until("the backend import retry on page reload", () => paused !== "");
    assert.equal(await app.again([replacement]), 0);
    await waitFor(app, `${playing("replacement.swf")} && ${canvases}.length === 1`);
    await app.devtools.send("Fetch.continueRequest", { requestId: paused });
    await app.devtools.send("Fetch.disable");
    app.devtools.listeners.delete("Fetch.requestPaused");
    await waitFor(app, ready);
    assert.equal(await app.evaluate(`${player}.hidden`), false, "a cancelled load hid the movie");
    assert.equal(await app.evaluate('document.getElementById("failure").hidden'), true);
    assert.equal(await app.evaluate(playing("replacement.swf")), true);
    assert.equal(
      JSON.parse(readFileSync(`${app.userData}/settings.json`, "utf8")).stage3DChoice,
      true,
    );
    assert.equal(await app.evaluate(`${canvases}.length`), 3);
    assert.match(await layout(app, "noScale", "TL"), /^noScale\|TL\|200\|160\|/);
    await pixels(app);

    // CSS resize and DPR update the viewport without changing configured Stage3D buffers.
    await app.devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 240,
      height: 180,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await frame(app);
    assert.match(await layout(app, "noScale", "BR"), /^noScale\|BR\|240\|180\|/);
    assert.deepEqual(
      await app.evaluate(`Array.from(${canvases}).slice(0, 2).map(c => [c.width, c.height])`),
      [
        [48, 48],
        [48, 48],
      ],
    );
    assert.match(await layout(app, "showAll", "BR"), /^showAll\|BR\|120\|100\|/);
    assert.deepEqual(
      await app.evaluate(
        `Array.from(${canvases}).slice(0, 2).map(c => [c.style.left, c.style.top])`,
      ),
      [
        ["38.4px", "14.4px"],
        ["67.2px", "43.2px"],
      ],
    );

    // Real browser loss/recovery replaces the retired slot, with both slots still composed.
    await app.evaluate(
      `globalThis.retiredStage3D = ${canvases}[0];
       globalThis.lossExtension = retiredStage3D.getContext("webgl2").getExtension("WEBGL_lose_context");
       lossExtension.loseContext()`,
    );
    await waitFor(app, 'globalThis.retiredStage3D.getContext("webgl2").isContextLost()');
    await frame(app);
    await app.evaluate("lossExtension.restoreContext()");
    await waitFor(
      app,
      `${canvases}.length === 3 && !retiredStage3D.isConnected && Array.from(${canvases}).slice(0, 2).every(c => !c.getContext("webgl2").isContextLost())`,
    );
    await app.devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 200,
      height: 160,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await layout(app, "noScale", "TL");
    await pixels(app);

    for (let i = 0; i < 4; i++) {
      await app.evaluate(`globalThis.previousStage3D = Array.from(${canvases}).slice(0, 2)`);
      await menu(app, "reload-movie");
      await waitFor(app, `${ready} && ${canvases}[0] !== previousStage3D[0]`);
      assert.equal(
        await app.evaluate(
          'previousStage3D.every(c => !c.isConnected && c.getContext("webgl2").isContextLost())',
        ),
        true,
      );
      assert.equal(await app.evaluate(`${canvases}.length`), 3);
    }

    await app.evaluate(`globalThis.previousStage3D = Array.from(${canvases}).slice(0, 2)`);
    await menu(app, "close-movie");
    await waitFor(app, `${canvases}.length === 0 && ${player}.hidden`);
    assert.equal(
      await app.evaluate(
        'previousStage3D.every(c => !c.isConnected && c.getContext("webgl2").isContextLost())',
      ),
      true,
    );
    await textureLimits(app);
    await app.devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 96,
      height: 96,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(await app.again([workerMovie]), 0);
    await waitFor(app, `${ready} && ${canvases}.length === 2`);
    assert.equal(await app.evaluate("crossOriginIsolated"), true);
    await frame(app);
    const { data } = await app.devtools.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    const offset = (8 * image.width + 8) * 4;
    assert.deepEqual([...image.data.subarray(offset, offset + 4)], [0, 255, 0, 255]);
    await app.evaluate(`globalThis.previousWorkerStage3D = ${canvases}[0]`);
    await menu(app, "close-movie");
    await waitFor(app, `${canvases}.length === 0 && ${player}.hidden`);
    assert.equal(
      await app.evaluate(
        '!previousWorkerStage3D.isConnected && previousWorkerStage3D.getContext("webgl2").isContextLost()',
      ),
      true,
    );
    const previousPage = await app.evaluate<number>("performance.timeOrigin");
    await menu(app, "stage3d", false);
    await waitFor(
      app,
      `performance.timeOrigin !== ${previousPage} && document.getElementById("welcome")?.hidden === false && document.readyState === "complete"`,
    );
    assert.equal(
      JSON.parse(readFileSync(`${app.userData}/settings.json`, "utf8")).stage3DChoice,
      false,
    );
    await app.again([movie]);
    await app.until(
      "the fallback after disabling Stage3D",
      () => app.stdout.filter((s) => s.startsWith("stagelayout error 3702")).length === 6,
    );
    assert.equal(await app.evaluate(`${canvases}.length`), 1);
    assert.doesNotMatch(app.stderr(), /uncaught|unhandled|WebGL: INVALID|CONTEXT_LOST_WEBGL/i);
  });
  console.log("desktop Stage3D test: ok");
} finally {
  screen.stop();
}
