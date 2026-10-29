// The web embedding in headless Chrome: a page with two <swf2es-player>s
// playing the player tests' SWFs and two Flash tags that replaceFlash
// swaps, one of them nested <object> and <embed>. It checks that each
// boots and draws, that the tags' parameters carry over, ExternalInterface
// both ways and its allowScriptAccess="never", that two players share one
// compile of codegen.wasm and one copy of the libraries and keep their
// modules in the configured IndexedDB cache, that the element
// follows its size and the device's pixels, and that destroy lets go of
// everything: 20 elements made and destroyed leave no player, codegen,
// socket or audio context alive, and the heap no larger than a bound.
// Last, Chrome's own Ctrl+C, X and V and a press reach a SWF's field and
// its Clipboard through the element's copy, cut and paste events, the
// mouse's events come in Flash's order, and touches as TouchEvents and as
// the mouse. Workers: on by default and sharing memory on this isolated
// page, off by the attribute or configure, from a script of another
// origin, and on a page that is not isolated passing messages, refusing
// to share memory, and their Web Workers let go after the last player.
//
//   node tests/web/run.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flashAssembler, script } from "../avm1-script.ts";
import { bare, cases, scripted } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compareImages, decodePng, type Image } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { importMap, importMapSource } from "../player/serve.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const site = `${out}site/`;
/** What 20 elements made and destroyed may leave on the heap, each: a tenth of a player's. */
const BOUND = 256 * 1024;
const CHURN = 20;

// This package's own copies: pnpm runs the player's tests at the same time.
libraryAbcs(`${out}libraries/`);
const abcs = compileScripts(
  [
    "Main",
    { name: "EmbedTest", source: readFileSync(`${here}scripts/EmbedTest.as`, "utf8") },
    { name: "TextLifecycle", source: readFileSync(`${here}scripts/TextLifecycle.as`, "utf8") },
    { name: "ClipboardTest", source: readFileSync(`${here}scripts/ClipboardTest.as`, "utf8") },
    { name: "TouchTest", source: readFileSync(`${here}scripts/TouchTest.as`, "utf8") },
    { name: "MarginsTest", source: readFileSync(`${here}scripts/MarginsTest.as`, "utf8") },
    { name: "ContextMenuTest", source: readFileSync(`${here}scripts/ContextMenuTest.as`, "utf8") },
    {
      name: "ActivationTest",
      source: readFileSync(`${here}scripts/ActivationTest.as`, "utf8"),
    },
    {
      name: "StageQuality",
      source: readFileSync(`${here}../player/scripts/StageQuality.as`, "utf8"),
    },
    "WorkerBasics",
    "WorkerMutex",
    {
      name: "NativeBitmapTest",
      source: readFileSync(`${here}scripts/NativeBitmapTest.as`, "utf8"),
    },
  ],
  out,
);
mkdirSync(site, { recursive: true });
writeFileSync(
  `${site}native-bitmap-as3.swf`,
  bare(abcs.get("NativeBitmapTest") as Uint8Array, 1, "NativeBitmapTest", 16, 16),
);
writeFileSync(
  `${site}native-bitmap-avm1.swf`,
  w.swf({
    version: 8,
    width: 16,
    height: 16,
    frameCount: 1,
    tags: [
      w.doAction([
        ...script(
          `
    var source = new flash.display.BitmapData(16, 16, true, 0x80305070);
    source.setPixel32(8, 8, 0xffff4020);
    var dest = new flash.display.BitmapData(16, 16, true, 0);
    var f = new flash.filters.ConvolutionFilter(3, 3, [1,1,1,1,1,1,1,1,1], 9);
    dest.applyFilter(source, source.rectangle, new flash.geom.Point(0, 0), f);
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), f);
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), new flash.filters.BlurFilter(4, 4, 1));
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), new flash.filters.GlowFilter(0xff0000, 1, 4, 4, 2, 1));
    trace(dest.getPixel32(8, 8) + " " + dest.getPixel32(0, 0));
    this.attachBitmap(dest, 1);
    stop();
  `,
          8,
        )(flashAssembler())
          .end()
          .bytes(),
      ]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(
  `${site}context-menu.swf`,
  bare(abcs.get("ContextMenuTest") as Uint8Array, 1, "ContextMenuTest", 200, 120),
);
const fillHoles = cases.find((c) => c.name === "fill-holes")?.swf as Uint8Array;
writeFileSync(`${site}shapes.swf`, fillHoles);
writeFileSync(
  `${site}fills.swf`,
  w.swf({
    width: 90,
    height: 50,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xffffff),
      ...[0xff0000, 0x00ff00, 0x0000ff].map((color, i) =>
        w.shape({
          id: i + 1,
          bounds: [0, 400, 0, 400],
          fills: [color],
          paths: [
            {
              fill1: 1,
              commands: [
                { move: [0, 0] },
                { line: [400, 0] },
                { line: [400, 400] },
                { line: [0, 400] },
                { line: [0, 0] },
              ],
            },
          ],
        }),
      ),
      ...[1, 2, 3].map((character) =>
        w.place({
          character,
          depth: character,
          matrix: { tx: ((character - 1) * 30 + 5) * 20, ty: 200 },
        }),
      ),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(`${site}avm1.swf`, cases.find((c) => c.name === "avm1-hello")?.swf as Uint8Array);
writeFileSync(`${site}scripted.swf`, scripted(abcs.get("Main") as Uint8Array));
// An AS2 SWF that calls the page, tells it what came back, and takes its calls.
const external = `var EI = flash.external.ExternalInterface;
var got = EI.call("avm1Hello", "hi", [1, {k: "v"}]);
EI.call("avm1Hello", got.got[0] + "!", got.got[1][1].k);
// An inline function, its quotes and && sent as they are.
EI.call("avm1Hello", EI.call("function(a) { return a && a + \\"'\\"; }", "q"));
EI.addCallback("triple", null, function(n) { return {n: n * 3, s: "a<b"}; });
stop();`;
writeFileSync(
  `${site}avm1-external.swf`,
  w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.doAction([...script(external, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(
  `${site}embed.swf`,
  bare(abcs.get("EmbedTest") as Uint8Array, 1, "EmbedTest", 160, 120),
);
writeFileSync(
  `${site}text.swf`,
  bare(abcs.get("TextLifecycle") as Uint8Array, 1, "TextLifecycle", 160, 120),
);
writeFileSync(
  `${site}clipboard.swf`,
  bare(abcs.get("ClipboardTest") as Uint8Array, 1, "ClipboardTest", 160, 120),
);
writeFileSync(
  `${site}quality.swf`,
  bare(abcs.get("StageQuality") as Uint8Array, 1, "StageQuality", 290, 60),
);
writeFileSync(
  `${site}touch.swf`,
  bare(abcs.get("TouchTest") as Uint8Array, 1, "TouchTest", 200, 100),
);
writeFileSync(
  `${site}margins.swf`,
  bare(abcs.get("MarginsTest") as Uint8Array, 1, "MarginsTest", 100, 100),
);
writeFileSync(
  `${site}activation.swf`,
  bare(abcs.get("ActivationTest") as Uint8Array, 1, "ActivationTest", 100, 100),
);
// The player tests' worker cases, and the traces Flash gave them.
const workerCase = (name: string, script: string) =>
  (
    (cases.find((c) => c.name === name) as (typeof cases)[number]).swf as (
      abc: Uint8Array,
    ) => Uint8Array
  )(abcs.get(script) as Uint8Array);
const reference = (name: string) =>
  readFileSync(`${here}../player/references/${name}/trace.txt`, "utf8")
    .replace(/\n$/, "")
    .split(/\r|\n/);
writeFileSync(`${site}worker-basics.swf`, workerCase("worker-basics", "WorkerBasics"));
writeFileSync(`${site}worker-mutex.swf`, workerCase("worker-mutex", "WorkerMutex"));
// Played in real time, up to its terminate: its last steps count frames from the first, which
// may pass before a Web Worker has loaded, and trace its self-channel early then.
const basicsFull = reference("worker-basics");
const workerBasicsTrace = basicsFull.slice(0, basicsFull.indexOf("terminate again false") + 1);
/** A run's own traces: without the page's other players' frames, or an early self-channel line. */
const own = (traces: string[]) =>
  traces.filter((t) => !/^frame \d/.test(t) && !t.startsWith("self events "));
const workerMutexTrace = reference("worker-mutex");
// A page of no players of its own, for the workers on a page that is not isolated.
writeFileSync(
  `${site}workers.html`,
  `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body><script type="module" src="/web-src/page.ts"></script></body>
</html>`,
);
writeFileSync(
  `${site}fills-csp.html`,
  readFileSync(`${site}workers.html`, "utf8").replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${importMapSource}; style-src 'unsafe-inline'; img-src 'self' data:">`,
  ),
);
writeFileSync(
  `${site}index.html`,
  `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
<style>body { margin: 0; background: #fff } swf2es-player, object { display: block }</style>
</head>
<body>
<swf2es-player id="shapes" src="/web-test/shapes.swf"></swf2es-player>
<swf2es-player id="scripted" src="/web-test/scripted.swf" scale="noScale" salign="TL"></swf2es-player>
<object id="movie" type="application/x-shockwave-flash" data="/web-test/embed.swf" width="160" height="120">
  <param name="FlashVars" value="greeting=hello%20there&amp;n=7">
  <param name="wmode" value="opaque">
  <param name="scale" value="exactfit">
  <param name="allowScriptAccess" value="always">
  <embed src="/web-test/embed.swf" name="movieEmbed" type="application/x-shockwave-flash" quality="low">
  <p>Get Flash Player</p>
</object>
<object id="locked" classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="160" height="120">
  <param name="movie" value="/web-test/embed.swf">
  <param name="allowScriptAccess" value="never">
  <p>Get Flash Player</p>
</object>
<script type="module" src="/web-src/page.ts"></script>
</body>
</html>`,
);

type Evaluate = <R>(expression: string) => Promise<{ value?: R; exception: string | null }>;
type Send = <R>(method: string, params?: object) => Promise<R>;

const call = async <R>(evaluate: Evaluate, expression: string): Promise<R> => {
  const { value, exception } = await evaluate<R>(expression);
  if (exception !== null || value === undefined) {
    throw new Error(`${expression}: ${exception ?? "no answer"}`);
  }

  return value;
};

interface Booted {
  id: string;
  error: string | null;
  attributes: Record<string, string>;
  rect: [number, number, number, number];
  canvas: [number, number] | null;
  canvasCss: [string, string] | null;
}

/** The colours in a CSS-pixel rectangle of a screenshot taken at `scale` device pixels a CSS pixel. */
function colours(image: Image, [x, y, w, h]: number[], scale: number): Map<number, number> {
  const found = new Map<number, number>();
  for (let py = Math.ceil(y * scale); py < Math.floor((y + h) * scale); py++) {
    for (let px = Math.ceil(x * scale); px < Math.floor((x + w) * scale); px++) {
      const i = (py * image.width + px) * 4;
      const rgb = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
      found.set(rgb, (found.get(rgb) ?? 0) + 1);
    }
  }

  return found;
}

const checks: [string, (evaluate: Evaluate, send: Send) => Promise<void>][] = [];
const boundTextureWarnings: string[] = [];
const check = (name: string, run: (evaluate: Evaluate, send: Send) => Promise<void>) =>
  checks.push([name, run]);

let booted: Booted[] = [];
const byId = (id: string) => booted.find((b) => b.id === id) as Booted;

check("file dialogs select and read real browser Files", async (evaluate, send) => {
  const filePath = `${out}chosen.txt`;
  writeFileSync(filePath, Uint8Array.of(65, 0, 255));
  await call(
    evaluate,
    `(async () => {
    window.fileDialogHost = (await import("@swf2es/player")).browserFileHost();
    window.fileDialogAbort = new AbortController();
    return true;
  })()`,
  );
  const denied = await call<unknown[]>(
    evaluate,
    "fileDialogHost.browse([], false, fileDialogAbort.signal)",
  );
  assert.deepEqual(denied, []);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const started = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
      expression: `window.fileDialogResult = fileDialogHost.browse([{description:"Text", extension:"*.txt"}], true, fileDialogAbort.signal).then(async files => ({ name: files[0].name, size: files[0].size, bytes: Array.from(await files[0].read(fileDialogAbort.signal)) }))`,
      userGesture: true,
    });
    assert.equal(started.exceptionDetails, undefined);
    const { root } = await send<{ root: { nodeId: number } }>("DOM.getDocument");
    const { nodeId } = await send<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type=file]",
    });
    assert.ok(nodeId);
    assert.equal(await call(evaluate, 'document.querySelector("input[type=file]").accept'), ".txt");
    await send("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    assert.deepEqual(await call(evaluate, "fileDialogResult"), {
      name: "chosen.txt",
      size: 3,
      bytes: [65, 0, 255],
    });
    assert.equal(await call(evaluate, 'document.querySelectorAll("input[type=file]").length'), 0);
  } finally {
    await send("Page.setInterceptFileChooserDialog", { enabled: false });
    await call(evaluate, "fileDialogAbort.abort(); true");
  }
});

check("each element boots and draws", async (evaluate, send) => {
  booted = await call<Booted[]>(evaluate, "booted()");
  assert.deepEqual(
    booted.map((b) => [b.id, b.error]),
    [
      ["shapes", null],
      ["scripted", null],
      ["movie", null],
      ["locked", null],
    ],
  );
  const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const image = decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
  const dominant = (id: string) =>
    [...colours(image, byId(id).rect, 2).entries()].sort((a, b) => b[1] - a[1])[0][0];
  // The shapes' fills, the scripted SWF's red box, and each EmbedTest's colour, edge to edge.
  assert.ok(colours(image, byId("shapes").rect, 2).size > 1, "shapes drew nothing");
  assert.ok(colours(image, byId("scripted").rect, 2).has(0xff0000), "no red box");
  assert.equal(dominant("movie").toString(16), "ff");
  assert.equal(dominant("locked").toString(16), "ff00");
  // The SWF's own stage size where the page gives none; Flash's tag's where it does.
  assert.deepEqual(byId("shapes").rect.slice(2), [200, 60]);
  assert.deepEqual(byId("scripted").rect.slice(2), [200, 100]);
  assert.deepEqual(byId("movie").rect.slice(2), [160, 120]);
  // Drawn at the device's pixels: two a CSS pixel here.
  assert.deepEqual(byId("shapes").canvas, [400, 120]);
});

interface WorkerRun {
  traces: string[];
  errors: string[];
  made: number;
}

check(
  "workers: on by default, sharing memory on this isolated page, off by attribute or configure",
  async (evaluate) => {
    // None of the page's SWFs names a worker: none was started ahead for them.
    assert.equal((await call<{ made: number }>(evaluate, "webWorkers()")).made, 0);

    const mutex = await call<WorkerRun>(
      evaluate,
      `workerRun("/web-test/worker-mutex.swf", {}, {}, "free true")`,
    );
    assert.deepEqual(mutex.errors, []);
    assert.deepEqual(own(mutex.traces), workerMutexTrace);
    assert.ok(mutex.made >= 2, `${mutex.made} Web Workers for two workers`);

    const off = `workerRun("/web-test/worker-basics.swf"`;
    for (const run of [
      `${off}, { workers: "false" }, {}, "supported false false")`,
      `${off}, {}, { workers: false }, "supported false false")`,
    ]) {
      const r = await call<WorkerRun>(evaluate, run);
      assert.equal(own(r.traces)[0], "supported false false", run);
      assert.equal(r.made, 0, run);
    }

    const on = await call<WorkerRun>(
      evaluate,
      `${off}, { workers: "true" }, { workers: false }, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
    );
    assert.deepEqual(on.errors, []);
    assert.deepEqual(own(on.traces), workerBasicsTrace);
  },
);

check(
  "a worker script from another origin, as a CDN's, starts through a module of the page's",
  async (evaluate) => {
    // The same server under another name: another origin, which serves the script with CORS.
    const r = await call<WorkerRun>(
      evaluate,
      `workerRun("/web-test/worker-basics.swf", {}, { workerUrl: "http://localhost:" + location.port + "/player-hosts/thread/player-hosts/web-worker.js" }, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(own(r.traces), workerBasicsTrace);
  },
);

check(
  "the quality attribute draws aliased and unsmoothed at low, while it plays",
  async (evaluate, send) => {
    boundTextureWarnings.length = 0;
    const shown = async (rect: number[]) => {
      const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const image = decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
      return colours(image, rect, 2).size;
    };
    const rect = await call<number[]>(evaluate, 'requality("high", "/web-test/quality.swf")');
    const high = await shown(rect);
    await call(evaluate, 'requality("low")');
    const low = await shown(rect);
    await call(evaluate, 'requality("high")');
    // Edges and smoothed bitmaps blend colours at high quality; at low, the fills' and texels' alone.
    assert.ok(low * 4 < high, `${low} colours at low, ${high} at high`);
    assert.equal(await shown(rect), high);
    // Flash's medium covers an edge with 4 samples, high with 16: high, with as many as the
    // GPU allows, shades the edges more finely where it allows more than 4.
    await call(evaluate, 'requality("medium")');
    const medium = await shown(rect);
    await call(evaluate, 'requality("high")');
    const most = await call<number>(
      evaluate,
      `(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const most = gl?.getParameter(gl.MAX_SAMPLES) ?? 0;
        // A context let go of at once, not left to count against the page's.
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        return most;
      })()`,
    );
    if (most > 4) {
      assert.ok(medium < high, `${medium} colours at medium, ${high} at high (${most} samples)`);
    }
    await call(evaluate, 'requality("high", "/web-test/shapes.swf")');
    assert.deepEqual(
      boundTextureWarnings,
      [],
      "quality changes or replacement destroyed a bound texture",
    );
  },
);

check("replaceFlash swaps each Flash tag once, its parameters carried over", async (evaluate) => {
  const r = await call<Record<string, unknown>>(evaluate, "replacement()");
  assert.deepEqual(r, { replaced: ["movie", "locked"], objects: 0, fallback: false, players: 4 });
  assert.deepEqual(byId("movie").attributes, {
    src: "/web-test/embed.swf",
    flashvars: "greeting=hello%20there&n=7",
    wmode: "opaque",
    scale: "exactfit",
    allowscriptaccess: "always",
    // What the <object> left out, its <embed> gave.
    quality: "low",
    id: "movie",
    name: "movieEmbed",
    width: "160",
    height: "120",
    tabindex: "0",
  });
  assert.equal(byId("locked").attributes.src, "/web-test/embed.swf");
  assert.equal(byId("locked").attributes.allowscriptaccess, "never");
});

check(
  "ExternalInterface both ways, safe from keys and names, none where allowScriptAccess is never",
  async (evaluate) => {
    const ei = await call<{
      calls: { hello: unknown[][]; reports: Record<string, unknown>[]; captured: unknown[] };
      shadowed: string[];
      attribute: string;
      pwned: boolean;
      echo: unknown;
      add: unknown;
      failed: string;
      lockedCallbacks: string[];
    }>(evaluate, "externalInterface()");
    // The SWF called pageHello once, the locked one never, and reported what it got.
    assert.deepEqual(ei.calls.hello, [["hi", [1, 2], { k: "v", d: "1970-01-01T00:00:00.005Z" }]]);
    assert.deepEqual(ei.calls.reports, [
      {
        objectID: "movie",
        hello: { got: ["hi", [1, 2], { k: "v", d: "1970-01-01T00:00:00.005Z" }] },
        inline: 42,
        href: ei.calls.reports[0]?.href,
        sum: 5,
        greeting: "hello there",
        n: "7",
      },
    ]);
    assert.deepEqual(ei.echo, { got: [1, { a: "b" }, "x<y"], n: 42 });
    assert.equal(ei.add, 5);
    assert.match(ei.failed, /Error calling method on NPObject: fail/);
    assert.deepEqual(ei.lockedCallbacks, []);
    assert.deepEqual(ei.shadowed, []);
    assert.equal(ei.attribute, "movie");
    assert.equal(ei.pwned, false);
    // window.location.href, through an inline function with no space before "(".
    assert.match(String(ei.calls.reports[0]?.href), /\/web-test\/index\.html(\?[a-z&]+)?$/);
    assert.deepEqual(ei.calls.captured, [
      { "a:(window.swf2esPwned=1),b": 1 },
      { "a:(window.swf2esPwned=1),b": 1 },
    ]);
  },
);

check(
  "two players share one compile of codegen.wasm and one copy of the libraries",
  async (evaluate) => {
    const counts = await call<Record<string, number>>(evaluate, "webCounts()");
    assert.equal(counts.codegenFetches, 1);
    assert.equal(counts.codegenCompiles, 1);
    // builtin.abc, and Flash Player's playerglobal where the page is given it in place of the package's.
    assert.equal(counts.libraryFetches, process.env.SWF2ES_PLAYERGLOBAL === "adobe" ? 2 : 1);
  },
);

check("with cache, the players keep their modules in IndexedDB", async (evaluate) => {
  assert.ok((await call<string[]>(evaluate, "databases()")).includes("swf2es-modules"));
});

check("the element follows its size and the device's pixels", async (evaluate) => {
  const r = await call<{ dpr: number; canvas: number[]; css: string[] }>(evaluate, "resize()");
  // exactFit to 320 by 120, twice as wide: drawn as fine as that axis needs, twice that for the device.
  assert.deepEqual(r, { dpr: 2, canvas: [640, 480], css: ["320px", "120px"] });
});

check("an embedder's fetch loads the SWF, asked for as the movie", async (evaluate) => {
  assert.deepEqual(await call(evaluate, "embedderFetch()"), {
    asked: [["/web-test/shapes.swf", "movie"]],
    played: true,
  });
});

check("watchFlash replaces the Flash tags the page adds or makes Flash later", async (evaluate) => {
  assert.deepEqual(await call(evaluate, "watched()"), {
    before: "embed",
    tag: "swf2es-player",
    playing: true,
  });
});

check("destroy takes the callbacks off and closes the socket and the audio", async (evaluate) => {
  const before = await call<Record<string, number>>(evaluate, "webCounts()");
  const r = await call<{
    callbacks: string[];
    player: boolean;
    destroyed: boolean;
    kept: boolean;
    awaited: boolean;
    counts: Record<string, number>;
  }>(evaluate, "destroyMovie()");
  assert.deepEqual(r.callbacks, []);
  assert.ok(r.awaited, "the element was a thenable");
  assert.ok(r.kept, "a callback kept past destroy still ran the SWF's code");
  assert.ok(r.player && r.destroyed);
  // Each EmbedTest opened a socket and its sound made an audio context; the movie's are gone.
  assert.equal(before.openSockets, 2);
  assert.equal(r.counts.openSockets, 1);
  assert.equal(r.counts.openAudio, before.openAudio - 1);
});

check(`${CHURN} elements made and destroyed leave nothing behind`, async (evaluate, send) => {
  const heap = async () => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    return (await send<{ usedSize: number }>("Runtime.getHeapUsage")).usedSize;
  };
  await call(evaluate, "churn(5)");
  const warm = await heap();
  const counts = await call<Record<string, number>>(evaluate, `churn(${CHURN})`);
  const after = await heap();
  const left = await call<{ players: number; codegens: number; counts: Record<string, number> }>(
    evaluate,
    "survivors()",
  );
  console.log(
    `  heap ${(warm / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB after ${CHURN} more`,
  );
  assert.equal(counts.socketsMade, 2 + 5 + CHURN);
  assert.equal(left.counts.openSockets, 1, "the locked SWF's alone");
  assert.equal(left.counts.openAudio, left.counts.audioMade - 1 - 5 - CHURN);
  assert.equal(left.players, 0, "a destroyed player is still alive");
  // The scripted and locked players' instances alone.
  assert.equal(left.codegens, 2);
  assert.ok(after - warm < BOUND * CHURN, `the heap grew by ${after - warm} bytes`);
});

check("device font measurement caches let go of destroyed players", async (evaluate, send) => {
  await call(evaluate, 'churn(5, "text.swf")');
  await send("HeapProfiler.collectGarbage");
  await send("HeapProfiler.collectGarbage");
  const left = await call<{ players: number; codegens: number; textScenes: number }>(
    evaluate,
    "survivors()",
  );
  assert.equal(left.textScenes, 0, "a text measurement retained its player's scene");
  assert.equal(left.players, 0, "a text measurement retained its player's scene");
  assert.equal(left.codegens, 2);
});

check("an AVM1 SWF's ExternalInterface calls the page and takes its calls", async (evaluate) => {
  const ei = await call<{ calls: unknown[][]; triple: unknown; never: boolean }>(
    evaluate,
    "avm1External()",
  );
  // The SWF under allowScriptAccess="never" called nothing and added no callback.
  assert.deepEqual(ei.calls, [["hi", [1, { k: "v" }]], ["hi!", "v"], ["q'"]]);
  assert.deepEqual(ei.triple, { n: 15, s: "a<b" });
  assert.equal(ei.never, false);
});

check(
  "an AVM1 SWF's actions run, and its players and compilers go with them",
  async (evaluate, send) => {
    const stopped = await call<number>(evaluate, "avm1Churn(5)");
    assert.equal(stopped, 5, "the actions' stop held the root on frame 2");
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const left = await call<{ players: number; codegens: number }>(evaluate, "survivors()");
    assert.equal(left.players, 0, "a destroyed AVM1 player is still alive");
    assert.equal(left.codegens, 2);
  },
);

/** Ctrl and a letter, as a user presses it, with the editing command Chrome runs for it, if any. */
async function ctrl(send: Send, letter: string, command?: string) {
  const key = {
    modifiers: 2,
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
  };
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...key,
    ...(command ? { commands: [command] } : {}),
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

check(
  "Ctrl+C, X and V and a press use the clipboard, as Flash Player did",
  async (evaluate, send) => {
    type State = { log: string[]; text: string; copied: string | null; seed: string };
    const state = () => call<State>(evaluate, "clipState()");
    const [left, top] = await call<[number, number]>(evaluate, "clipboardPlayer()");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });

    // The page's own copy puts two lines on the clipboard; pasted into the
    // single-line field, they lose the line break, a TextEvent and a change.
    await call(evaluate, `seedFocus("two\\nlines")`);
    await ctrl(send, "c", "copy");
    await call(evaluate, `clipFocus("Field")`);
    await ctrl(send, "v", "paste");
    assert.deepEqual(await state(), {
      log: ["textInput twolines", "change twolines"],
      text: "twolines",
      // The page's own copy, whose data the browser fills in after the event.
      copied: "",
      seed: "two\nlines",
    });

    // Ctrl+A selects the field's text, Ctrl+X cuts it to the clipboard.
    await ctrl(send, "a", "selectAll");
    await ctrl(send, "x", "cut");
    assert.deepEqual(await state(), {
      log: ["change "],
      text: "",
      copied: null,
      seed: "two\nlines",
    });
    await call(evaluate, `seedFocus("")`);
    await ctrl(send, "v", "paste");
    assert.equal((await state()).seed, "twolines");

    // The box hears copy, paste and selectAll, and writes and reads the clipboard in them.
    await call(evaluate, `clipFocus("Box")`);
    await ctrl(send, "c", "copy");
    await ctrl(send, "v", "paste");
    await ctrl(send, "a", "selectAll");
    assert.deepEqual(await state(), {
      log: ["copy", "paste copied by the box", "selectAll"],
      text: "",
      copied: "copied by the box",
      seed: "twolines",
    });

    // A press on the stage writes the clipboard with System.setClipboard, through the async API.
    const at = { x: left + 100, y: top + 100, button: "left", clickCount: 1 };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    // The write is a promise the page settles later: paste until it lands, or give up.
    let pressed = await state();
    const log = pressed.log;
    for (let i = 0; i < 20 && pressed.seed !== "set on a press"; i++) {
      await new Promise((done) => setTimeout(done, 50));
      await call(evaluate, `seedFocus("")`);
      await ctrl(send, "v", "paste");
      pressed = await state();
    }

    assert.deepEqual([log, pressed.seed], [["press"], "set on a press"]);
    await call(evaluate, "clipDestroy()");
  },
);

check(
  "the window's blur and focus and the page taking the focus deactivate and activate the SWF",
  async (evaluate, send) => {
    // A focused page, as a user's: the player starts active.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await call(evaluate, "activationPlayer()");
    const log = () => call<string[]>(evaluate, "activationLog()");
    assert.deepEqual(await log(), []);

    // The window's blur, told twice, then its focus.
    await call(evaluate, `activationWindow("blur")`);
    await call(evaluate, `activationWindow("blur")`);
    await call(evaluate, `activationWindow("focus")`);
    assert.deepEqual(await log(), [
      "deactivate root1",
      "deactivate orphan",
      "activate root1",
      "activate orphan",
    ]);

    // A blur and a focus in one call of the page's: nothing changed by its end.
    await call(evaluate, `activationWindow("blur") && activationWindow("focus")`);
    assert.deepEqual(await log(), []);

    // The page's textarea takes the focus, and the element takes it back.
    await call(evaluate, "activationFocus(false)");
    await call(evaluate, "activationFocus(true)");
    assert.deepEqual(await log(), [
      "deactivate root1",
      "deactivate orphan",
      "activate root1",
      "activate orphan",
    ]);
    await call(evaluate, "activationDestroy()");
  },
);

check(
  "showAll draws past the stage's edges in its margins, and takes the mouse there",
  async (evaluate, send) => {
    const shot = async () => {
      const data = (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
      return decodePng(new Uint8Array(Buffer.from(data, "base64")));
    };
    const only = (image: Image, rect: number[]) => [...colours(image, rect, 2).keys()];

    // Twice its size in a box three times as wide: 200 CSS pixels of margin each side, centred.
    const [left, top, width, height] = await call<number[]>(evaluate, 'marginsPlayer("")');
    // As in Flash, the stage keeps the SWF's size however large the box is.
    assert.deepEqual([width, height], [100, 100]);
    let image = await shot();
    assert.deepEqual(only(image, [left + 110, top + 10, 80, 180]), [0xff0000], "left margin");
    assert.deepEqual(only(image, [left + 210, top + 10, 180, 180]), [0xffff00], "stage");
    assert.deepEqual(only(image, [left + 410, top + 10, 80, 180]), [0x00ff00], "right margin");
    assert.deepEqual(only(image, [left + 510, top + 10, 80, 180]), [0xffffff], "past the art");

    const press = async (x: number, y: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + x,
          y: top + y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      }
    };
    // Flash (adl, 2026-10-24) hears a press in the margins at stage coordinates past its edges.
    await press(150, 100);
    await press(550, 40);
    await press(300, 100);
    assert.deepEqual(await call<string[]>(evaluate, "marginsLog()"), [
      "red -25,50 -25,50",
      "stage 175,20 175,20",
      "yellow 50,50 50,50",
    ]);

    // A right-click in a margin opens the player's menu, not the browser's.
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: left + 50,
        y: top + 100,
        button: type === "mouseMoved" ? "none" : "right",
        clickCount: 1,
      });
    }
    const menu =
      'document.getElementById("margins").shadowRoot.querySelector("[data-swf2es-context-menu]")';
    assert.equal(await call(evaluate, `!!${menu}`), true, "no player menu in the margin");
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "Escape", windowsVirtualKeyCode: 27 });
    }
    assert.equal(await call(evaluate, `!!${menu}`), false, "the menu stayed open");

    // Held to the left edge, the stage's right margin is the whole rest of the box.
    const [l, t] = await call<number[]>(evaluate, 'marginsPlayer("L")');
    image = await shot();
    assert.deepEqual(only(image, [l + 10, t + 10, 180, 180]), [0xffff00], "stage at the left");
    assert.deepEqual(only(image, [l + 210, t + 10, 80, 180]), [0x00ff00], "right margin");
    await press(250, 100);
    assert.deepEqual(await call<string[]>(evaluate, "marginsLog()"), ["green 125,50 125,50"]);
    await call(evaluate, "marginsDestroy()");
  },
);

check(
  "the mouse's events come in Flash's order, and a drag off the player keeps the mouse",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    // Test pointer routing independently of the popup, which takes the pointer while open.
    await call(
      evaluate,
      `(() => {
      const canvas = document.elementFromPoint(${left + 1}, ${top + 1}).shadowRoot.querySelector("canvas");
      canvas.addEventListener("contextmenu", e => e.preventDefault(), {capture:true});
      return true;
    })()`,
    );
    const log = () => call<string[]>(evaluate, "touchLog()");
    const mouse = async (type: string, x: number, y: number, buttons = 0, button = "left") => {
      await send("Input.dispatchMouseEvent", {
        type,
        x: left + x,
        y: top + y,
        button: type === "mouseMoved" && buttons === 0 ? "none" : button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
      return log();
    };

    // As Flash Player 32 traced it: a move first, then the hover; the empty
    // stage takes the move, but no over.
    assert.deepEqual(await mouse("mouseMoved", 150, 90), ["mouseMove stage 150,90 false null"]);
    assert.deepEqual(await mouse("mouseMoved", 30, 30), [
      "mouseMove b 10,10 false null",
      "rollOver b 10,10 false null",
      "rollOver a 30,30 false null",
      "mouseOver b 10,10 false null",
    ]);
    // A press where the mouse was not is a move there first, its button still up.
    assert.deepEqual(await mouse("mousePressed", 110, 30, 1), [
      "mouseMove c 10,30 false null",
      "mouseOut b 90,10 false c",
      "rollOut b 90,10 false c",
      "rollOut a 110,30 false c",
      "rollOver c 10,30 false b",
      "mouseOver c 10,30 false b",
      "mouseDown c 10,30 true null",
    ]);
    // Dragged off the player, the mouse stays its own: moves to the stage,
    // the release too, and the leave only at the next move after it.
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 1), [
      "mouseMove stage 300,30 true null",
      "mouseOut c 200,30 true null",
      "rollOut c 200,30 true null",
    ]);
    assert.deepEqual(await mouse("mouseReleased", 300, 30), ["mouseUp stage 300,30 false null"]);
    assert.deepEqual(await mouse("mouseMoved", 310, 30), ["mouseLeave stage"]);

    // The right button holds nothing: the pointer leaves as it goes, and its
    // release outside leaves no second time.
    await mouse("mouseMoved", 110, 30);
    await mouse("mousePressed", 110, 30, 2, "right");
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 2, "right"), [
      "mouseOut c -101,-1 false null",
      "rollOut c -101,-1 false null",
      "mouseLeave stage",
    ]);
    assert.deepEqual(await mouse("mouseReleased", 300, 30, 0, "right"), []);
    assert.deepEqual(await mouse("mouseMoved", 310, 30), []);

    // The left button let go while the right stays down is a release, which
    // the browser tells as a move: the leave after it is not held back.
    await mouse("mouseMoved", 110, 30);
    await mouse("mousePressed", 110, 30, 1);
    await mouse("mousePressed", 110, 30, 3, "right");
    assert.deepEqual(await mouse("mouseReleased", 110, 30, 2), [
      "mouseUp c 10,30 false null",
      "click c 10,30 false null",
    ]);
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 2, "right"), [
      "mouseOut c -101,-1 false null",
      "rollOut c -101,-1 false null",
      "mouseLeave stage",
    ]);
    await mouse("mouseReleased", 300, 30, 0, "right");
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "a double click in Chrome is a doubleClick where the target's doubleClickEnabled is true",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    const log = () => call<string[]>(evaluate, "touchLog()");
    // Both clicks as the browser sends a double click's, back to back: the
    // player counts a second press within half a second of the first, and a
    // read of the log between them, under a slow build, has taken longer.
    const click = async (clickCount: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + 110,
          y: top + 30,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });
      }
    };

    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left + 110, y: top + 30 });
    await log();
    await call(evaluate, `touchCall("setBox", "c", "doubleClickEnabled", true)`);
    await click(1);
    await click(2);
    assert.deepEqual(await log(), [
      "mouseDown c 10,30 true null",
      "mouseUp c 10,30 false null",
      "click c 10,30 false null",
      "mouseDown c 10,30 true null",
      "mouseUp c 10,30 false null",
      "doubleClick c 10,30 false null",
    ]);
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "the wheel scrolls the page over a SWF that does not listen for it, and only goes to one that does",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    const scrolled = () =>
      call<number>(evaluate, "(document.body.style.height = '3000px', window.scrollY)");
    // The wheel over c, the page at its top; a page that scrolls takes the
    // player from under the pointer, whose leave is logged too.
    const wheel = async (deltaY: number) => {
      await call(evaluate, "(window.scrollTo(0, 0), window.scrollY)");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left + 110, y: top + 30 });
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: left + 110,
        y: top + 30,
        deltaX: 0,
        deltaY,
      });
      // The page scrolls a moment later, unless the SWF took the wheel: its
      // listener runs in the wheel event's, which then prevents the scroll.
      const log: string[] = [];
      let moved = false;
      for (let i = 0; i < 60 && !moved && log.length === 0; i++) {
        await new Promise((done) => setTimeout(done, 50));
        const heard = await call<string[]>(evaluate, "touchLog()");
        log.push(...heard.filter((line) => line.startsWith("mouseWheel")));
        moved = (await scrolled()) > 0;
      }

      return [moved, log];
    };

    await scrolled();
    assert.deepEqual(await wheel(100), [true, []]);
    await call(evaluate, `touchCall("listenWheel")`);
    // A notch of 100 pixels is 3 lines, down negative, as Flash's delta.
    assert.deepEqual(await wheel(100), [false, ["mouseWheel c -3"]]);
    assert.deepEqual(await wheel(-100), [false, ["mouseWheel c 3"]]);
    await call(evaluate, "(document.body.style.height = '', window.scrollTo(0, 0), true)");
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "touches reach a SWF as TouchEvents and as the mouse, and a tap may write the clipboard",
  async (evaluate, send) => {
    // A touch screen the page has from here on: the players made before it saw none.
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const [left, top, touchAction] = await call<[number, number, string]>(
      evaluate,
      "touchPlayer()",
    );
    const log = () => call<string[]>(evaluate, "touchLog()");
    const touch = (type: string, points: [x: number, y: number, id: number][]) =>
      send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y, id]) => ({ x: left + x, y: top + y, id })),
      });

    // The page does not scroll or zoom under the SWF, which takes every touch as Flash's plug-in did.
    assert.equal(touchAction, "none");
    assert.deepEqual(await call(evaluate, `touchCall("touchState")`), [
      true,
      5,
      "gesture",
      "finger",
    ]);

    // In gesture mode, which recognizes no gestures here, a tap is the mouse's alone.
    await touch("touchStart", [[30, 30, 0]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "mouseMove b 10,10 false null",
      "rollOver b 10,10 false null",
      "rollOver a 30,30 false null",
      "mouseOver b 10,10 false null",
      "mouseDown b 10,10 true null",
      "mouseUp b 10,10 false null",
      "click b 10,10 false null",
    ]);

    // In touchPoint mode, each step's touch events, then the primary touch's mouse
    // events; the mouse stays over b, where the tap left it.
    assert.equal(await call(evaluate, `touchCall("setMode", "touchPoint")`), "touchPoint");
    await touch("touchStart", [[30, 30, 0]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "touchRollOver b primary 10,10 30,30 null",
      "touchRollOver a primary 30,30 30,30 null",
      "touchOver b primary 10,10 30,30 null",
      "touchBegin b primary 10,10 30,30 null",
      "mouseDown b 10,10 true null",
      "touchEnd b primary 10,10 30,30 null",
      "touchTap b primary 10,10 30,30 null",
      "touchOut b primary 10,10 30,30 null",
      "touchRollOut b primary 10,10 30,30 null",
      "touchRollOut a primary 30,30 30,30 null",
      "mouseUp b 10,10 false null",
      "click b 10,10 false null",
    ]);
    // The tap's listener wrote the clipboard, through the async API, as a click's would.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    let seed = "";
    for (let i = 0; i < 20 && seed !== "tapped b"; i++) {
      await new Promise((done) => setTimeout(done, 50));
      await call(evaluate, `seedFocus("")`);
      await ctrl(send, "v", "paste");
      seed = await call<string>(evaluate, "touchSeed()");
    }

    assert.equal(seed, "tapped b");

    // A drag from b to c: a move that may not write the clipboard, then out
    // and rolls as the point moves, in the mouse's order, and the mouse after it.
    await touch("touchStart", [[30, 30, 0]]);
    await log();
    await touch("touchMove", [[110, 30, 0]]);
    assert.deepEqual(await log(), [
      "touchMove c primary 10,30 110,30 null",
      "setClipboard in touchMove 2176",
      "touchOut b primary 90,10 110,30 c",
      "touchRollOut b primary 90,10 110,30 c",
      "touchRollOut a primary 110,30 110,30 c",
      "touchRollOver c primary 10,30 110,30 b",
      "touchOver c primary 10,30 110,30 b",
      "mouseMove c 10,30 true null",
      "mouseOut b 90,10 true c",
      "rollOut b 90,10 true c",
      "rollOut a 110,30 true c",
      "rollOver c 10,30 true b",
      "mouseOver c 10,30 true b",
    ]);

    // A second finger is touch events alone; the first, lifted over c where
    // it did not begin, is no tap and no click.
    await touch("touchStart", [
      [110, 30, 0],
      [10, 10, 1],
    ]);
    await touch("touchEnd", [[10, 10, 1]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "touchRollOver a secondary 10,10 10,10 null",
      "touchOver a secondary 10,10 10,10 null",
      "touchBegin a secondary 10,10 10,10 null",
      "touchEnd a secondary 10,10 10,10 null",
      "touchTap a secondary 10,10 10,10 null",
      "touchOut a secondary 10,10 10,10 null",
      "touchRollOut a secondary 10,10 10,10 null",
      "touchEnd c primary 10,30 110,30 null",
      "touchOut c primary 10,30 110,30 null",
      "touchRollOut c primary 10,30 110,30 null",
      "mouseUp c 10,30 false null",
    ]);
    await call(evaluate, "touchDestroy()");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  },
);

check(
  "lazy compilation is opt-in and destroyed players release their compilers",
  async (evaluate, send) => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const before = await call<{ codegens: number }>(evaluate, "survivors()");
    assert.equal(await call<number>(evaluate, "lazyChurn(5)"), 5);
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const after = await call<{ players: number; codegens: number }>(evaluate, "survivors()");
    assert.equal(after.players, 0);
    assert.equal(after.codegens, before.codegens);
  },
);

check(
  "custom context menus inherit, snapshot after menuSelect, select and release their DOM",
  async (evaluate, send) => {
    const at = await call<number[]>(
      evaluate,
      `(async () => {
    window.menuLines = [];
    window.menuTrace = line => menuLines.push(line);
    window.menuPlayer = document.createElement("swf2es-player");
    menuPlayer.style.cssText = "position:fixed;left:0;top:0;z-index:1000";
    document.body.append(menuPlayer);
    await menuPlayer.load("/web-test/context-menu.swf");
    menuPlayer.focus();
    window.menuHost = () => menuPlayer.shadowRoot.querySelector("[data-swf2es-context-menu]");
    window.menuButtons = () => Array.from(menuHost().shadowRoot.querySelectorAll("button"));
    const r = menuPlayer.getBoundingClientRect();
    return [r.x, r.y];
  })()`,
    );
    const open = async (x = 45, y = 45) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: at[0] + x,
          y: at[1] + y,
          button: type === "mouseMoved" ? "none" : "right",
          clickCount: 1,
        });
      }
    };
    const key = async (name: string, code: number) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: name, windowsVirtualKeyCode: code });
      }
    };
    try {
      await open();
      assert.deepEqual(
        await call(evaluate, `menuButtons().map(b => [b.textContent, b.disabled])`),
        [
          ["Action 1", false],
          ["Disabled", true],
          ["<b>Literal</b>", false],
          ["About swf2es", false],
        ],
      );
      assert.equal(await call(evaluate, 'menuHost().shadowRoot.querySelectorAll("b").length'), 0);
      assert.equal(
        await call(evaluate, 'menuHost().shadowRoot.querySelectorAll("[role=separator]").length'),
        2,
      );
      assert.deepEqual(await call(evaluate, "menuLines"), [
        ["menuSelect", "menu", "child", "owner", false, false, 2],
      ]);
      assert.equal(
        await call(
          evaluate,
          `(() => {
      const h = menuHost(), r = h.getBoundingClientRect();
      return h.matches(":popover-open") && r.bottom > menuPlayer.getBoundingClientRect().bottom;
    })()`,
        ),
        true,
      );
      // Opened by the pointer, no item has focus until a key moves it there.
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement?.getAttribute('role')"),
        "menu",
      );
      // Focused, the menu draws no focus ring: its items show focus, and the ring's square corners
      // stood out past the rounded border.
      assert.equal(
        await call(
          evaluate,
          'getComputedStyle(menuHost().shadowRoot.querySelector("[role=menu]")).outlineStyle',
        ),
        "none",
      );
      await key("ArrowDown", 40);
      await key("ArrowDown", 40);
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement.textContent"),
        "<b>Literal</b>",
      );
      await key("Home", 36);
      await key("Enter", 13);
      assert.equal(await call(evaluate, "menuHost() === null"), true);
      assert.deepEqual(await call(evaluate, "menuLines[1]"), [
        "menuItemSelect",
        "item",
        "child",
        "owner",
        false,
        false,
        2,
      ]);
      assert.equal(await call(evaluate, "document.activeElement === menuPlayer"), true);

      await open();
      await key("ArrowUp", 38);
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement.textContent"),
        "About swf2es",
        "ArrowUp with no item focused goes to the last",
      );
      await call(evaluate, "window.cancelledMenuButton = menuButtons()[0]; true");
      await key("Escape", 27);
      await call(evaluate, "cancelledMenuButton.click(); true");
      assert.equal(await call(evaluate, "menuHost() === null"), true);
      assert.equal(
        await call(evaluate, 'menuLines.filter(x => x[0] === "menuItemSelect").length'),
        1,
      );

      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          key: "F10",
          code: "F10",
          windowsVirtualKeyCode: 121,
          modifiers: 8,
        });
      }
      assert.equal(await call(evaluate, "menuHost() !== null"), true, "Shift+F10 opens the menu");
      assert.equal(
        await call(
          evaluate,
          "menuHost().shadowRoot.activeElement === menuButtons().find((b) => !b.disabled)",
        ),
        true,
        "a menu opened from the keyboard focuses its first item",
      );
      await key("Escape", 27);

      await call(evaluate, 'menuPlayer.menuMode("own"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuLines[menuLines.length - 1]"), [
        "menuSelect",
        "menu",
        "child",
        "child",
        false,
        false,
        2,
      ]);
      const clicked = await call<number[]>(
        evaluate,
        `(() => {
      const r = menuButtons()[0].getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: clicked[0],
          y: clicked[1],
          button: "left",
          clickCount: 1,
        });
      }
      assert.deepEqual(await call(evaluate, "menuLines[menuLines.length - 1]"), [
        "menuItemSelect",
        "item",
        "child",
        "child",
        false,
        false,
        2,
      ]);

      await open(160, 90);
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "Root action",
        "About swf2es",
      ]);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 300,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 300,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      assert.equal(await call(evaluate, "menuHost() === null"), true);

      await call(evaluate, 'menuPlayer.menuMode("defaults"); true');
      await open();
      assert.equal(
        await call(
          evaluate,
          'menuButtons().filter(b => b.textContent.startsWith("Quality:")).length',
        ),
        4,
      );
      await key("Escape", 27);
      await call(evaluate, 'menuPlayer.setAttribute("menu", "false"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "About swf2es",
      ]);
      await key("Escape", 27);
      await call(evaluate, 'menuPlayer.removeAttribute("menu"); true');
      await call(evaluate, 'menuPlayer.menuMode("noDefaults"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "About swf2es",
      ]);
      await key("Escape", 27);
      await call(
        evaluate,
        `(() => {
        window.preventMenu = e => e.preventDefault();
        menuPlayer.shadowRoot.querySelector("canvas").addEventListener("contextmenu", preventMenu, {capture:true});
        return true;
      })()`,
      );
      await open();
      assert.equal(
        await call(evaluate, "menuHost() === null"),
        true,
        "an embedder can replace the menu",
      );
      await key("ContextMenu", 93);
      assert.equal(
        await call(evaluate, "menuHost() === null"),
        true,
        "keyboard opening honors cancellation",
      );
      await call(
        evaluate,
        `menuPlayer.shadowRoot.querySelector("canvas").removeEventListener("contextmenu", preventMenu, {capture:true}); true`,
      );
      const fullscreen = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
        expression: "menuPlayer.requestFullscreen()",
        userGesture: true,
        awaitPromise: true,
      });
      assert.equal(fullscreen.exceptionDetails, undefined);
      await key("ContextMenu", 93);
      assert.equal(
        await call(
          evaluate,
          'document.fullscreenElement === menuPlayer && menuHost()?.matches(":popover-open")',
        ),
        true,
      );
      await call(evaluate, "menuPlayer.destroy(); true");
      assert.equal(await call(evaluate, "menuHost() === null"), true);
    } finally {
      await call(
        evaluate,
        "(async () => { menuPlayer.destroy(); if (document.fullscreenElement) await document.exitFullscreen(); menuPlayer.remove(); delete window.menuTrace; return true; })()",
      );
    }
  },
);

const failures = await withPage(
  "survivors",
  async (evaluate, send, fresh, listen) => {
    // What the page threw, told with a failing check: an error of its own, not a time out.
    const thrown: string[] = [];
    listen("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "warning") {
        return;
      }

      const args = params.args as { value?: unknown }[];
      const message = args.map((arg) => String(arg.value ?? "")).join(" ");
      if (message.includes("destroyed while still bound")) {
        boundTextureWarnings.push(message);
      }
    });
    listen("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        text: string;
      };
      thrown.push(details.exception?.description ?? details.text);
    });
    // Two device pixels a CSS pixel, as on a high-density display.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await fresh();
    // Under a loaded run, the browser has failed to fetch one of the
    // package's many unbundled modules, and keeps that failure for the
    // document. A fetch failure alone is tried again, in a new document,
    // twice at most; any other failure, or a third, is the checks' to report.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failure = (await evaluate<string | null>("loaded()")).value ?? null;
      if (failure === null || !/Failed to fetch dynamically imported module/.test(failure)) {
        break;
      }

      console.log(`  the page's import failed (${failure}); loading it again`);
      await fresh();
    }

    let failed = 0;
    for (const [name, run] of checks) {
      try {
        await run(evaluate, send);
        console.log(`ok ${name}`);
      } catch (e) {
        failed++;
        console.log(`not ok ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
        for (const text of thrown.splice(0)) {
          console.log(`  the page threw: ${text}`);
        }
      }
    }

    return failed;
  },
  // Software GL by default; SWF2ES_WEB_GPU=1 draws on the GPU, whose multisampling may go past 4.
  process.env.SWF2ES_WEB_GPU === "1",
  {
    page: "web-test/index.html",
    mounts: [
      ["/web-test/", site],
      ["/web-src/", here],
      ["/libraries/", `${out}libraries/`],
    ],
  },
);

// On a page that is not cross-origin isolated, workers pass messages as on
// one that is, and sharing memory with one says it needs isolation; the
// Web Workers started ahead go once the page's last player has.
const unisolated = await withPage(
  "workerRun",
  async (evaluate) => {
    try {
      const basics = await call<WorkerRun>(
        evaluate,
        `workerRun("/web-test/worker-basics.swf", {}, {}, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
      );
      assert.deepEqual(basics.errors, []);
      assert.deepEqual(own(basics.traces), workerBasicsTrace);
      const mutex = await call<WorkerRun>(
        evaluate,
        `workerRun("/web-test/worker-mutex.swf", {}, {}, "free true")`,
      );
      assert.deepEqual(mutex.traces, []);
      assert.match(
        mutex.errors.join("\n"),
        /sharing a Mutex with another worker needs shared memory, which a browser gives only a cross-origin isolated page/,
      );
      const start = Date.now();
      let live = -1;
      while (live !== 0 && Date.now() - start < 30_000) {
        await new Promise((done) => setTimeout(done, 250));
        live = (await call<{ live: number }>(evaluate, "webWorkers()")).live;
      }

      assert.equal(live, 0, "the Web Workers started ahead outlived the last player");
      console.log("ok workers on a page that is not isolated, and let go after the last player");
      return 0;
    } catch (e) {
      console.log(
        `not ok workers on a page that is not isolated\n  ${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
  },
  false,
  {
    page: "web-test/workers.html",
    isolated: false,
    mounts: [
      ["/web-test/", site],
      ["/web-src/", here],
      ["/libraries/", `${out}libraries/`],
    ],
  },
);

let fillFailures = 0;
let fillReference: Image | null = null;
// Drawn by the render module; where the page cannot compile it (blocked, a CSP without
// 'wasm-unsafe-eval'), no playback, and the element says why. The player loads the module with
// itself, so a page without it has no player at all.
for (const mode of ["default", "blocked", "csp"] as const) {
  try {
    await withPage(
      "fillRun",
      async (evaluate, send) => {
        const r = await call<{
          rect: [number, number, number, number];
          compiles: number;
          instances: number;
          error: string | null;
        }>(evaluate, `fillRun(${JSON.stringify(mode)})`);
        if (mode !== "default") {
          assert.ok(r.error, "a page that cannot run the render module played");
          assert.equal(r.instances, 0);
          assert.ok(r.compiles > 0, "the module was not compiled");

          return;
        }

        assert.equal(r.error, null);
        const [x, y, width, height] = r.rect;
        const shot = await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { x, y, width, height, scale: 1 },
        });
        const image = decodePng(Buffer.from(shot.data, "base64"));
        for (const [index, color] of [
          [15, [255, 0, 0, 255]],
          [45, [0, 255, 0, 255]],
          [75, [0, 0, 255, 255]],
        ] as const) {
          const at = (20 * image.width + index) * 4;
          assert.deepEqual(Array.from(image.data.subarray(at, at + 4)), color);
        }
        if (fillReference) {
          assert.equal(compareImages(image, fillReference, 0).outliers, 0);
        } else {
          fillReference = image;
        }

        // One compile for the page; each playback's tessellator an instance, and no line builder's,
        // as fills.swf has no lines.
        assert.equal(r.compiles, 1);
        assert.equal(r.instances, 3);

        await call(evaluate, "fillDestroy()");
        await send("HeapProfiler.collectGarbage");
        await send("HeapProfiler.collectGarbage");
        assert.equal(
          await call(evaluate, "fillSurvivors()"),
          0,
          "native memory outlived the playbacks",
        );
      },
      false,
      {
        page: mode === "csp" ? "web-test/fills-csp.html" : "web-test/workers.html",
        mounts: [
          ["/web-test/", site],
          ["/web-src/", here],
          ["/libraries/", `${out}libraries/`],
        ],
      },
    );
    console.log(`ok native fills: ${mode}`);
  } catch (error) {
    fillFailures++;
    console.log(
      `not ok native fills: ${mode}\n  ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}

let bitmapFailures = 0;
for (const vm of ["as3", "avm1"]) {
  let reference: string[] | null = null;
  let imageReference: Image | null = null;
  // Where the page cannot compile the render module, nothing plays (native fills, above).
  for (const mode of ["default", "trap"]) {
    try {
      await withPage(
        "bitmapRun",
        async (evaluate, send) => {
          const result = await call<{
            traces: string[];
            errors: string[];
            calls: number;
            instances: number;
            rect: [number, number, number, number];
          }>(evaluate, `bitmapRun(${JSON.stringify(mode)}, ${JSON.stringify(vm)})`);
          assert.deepEqual(result.errors, []);
          assert.equal(result.traces.length, 1);
          if (reference) {
            assert.deepEqual(result.traces, reference);
          } else {
            reference = result.traces;
          }

          const [x, y, width, height] = result.rect;
          const shot = await send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            clip: { x, y, width, height, scale: 1 },
          });
          const image = decodePng(Buffer.from(shot.data, "base64"));
          if (imageReference) {
            assert.equal(compareImages(image, imageReference, 0).outliers, 0);
          } else {
            imageReference = image;
          }

          // One kernel for the page's players, each of which convolves twice, blurs and glows; the
          // first call of each kind trapped and made again in a new instance.
          assert.equal(result.calls, mode === "trap" ? 15 : 12);
          assert.equal(result.instances, mode === "trap" ? 4 : 1);

          await call(evaluate, "bitmapDestroy()");
          await send("HeapProfiler.collectGarbage");
          await send("HeapProfiler.collectGarbage");
          // The page's kernel keeps its instance for the next player; the rest go with theirs.
          assert.ok((await call<number>(evaluate, "bitmapSurvivors()")) <= 1);
        },
        false,
        {
          page: "web-test/workers.html",
          mounts: [
            ["/web-test/", site],
            ["/web-src/", here],
            ["/libraries/", `${out}libraries/`],
          ],
        },
      );
      console.log(`ok native bitmaps: ${vm} ${mode}`);
    } catch (error) {
      bitmapFailures++;
      console.log(
        `not ok native bitmaps: ${vm} ${mode}\n  ${error instanceof Error ? error.stack : String(error)}`,
      );
    }
  }
}

try {
  await withPage(
    "fillRun",
    async (evaluate) => {
      const result = await call(
        evaluate,
        `import("@swf2es/native/render").then(({BitmapKernel}) => {
      try {
        new BitmapKernel();
        return false;
      } catch {
        return true;
      }
    })`,
      );
      assert.equal(
        result,
        true,
        "a CSP that refuses the module must refuse the kernel as it is made",
      );
    },
    false,
    {
      page: "web-test/fills-csp.html",
      mounts: [
        ["/web-test/", site],
        ["/web-src/", here],
        ["/libraries/", `${out}libraries/`],
      ],
    },
  );
  console.log("ok native bitmaps: CSP refusal");
} catch (error) {
  bitmapFailures++;
  console.log(
    `not ok native bitmaps: CSP refusal\n  ${error instanceof Error ? error.stack : String(error)}`,
  );
}

if (failures + unisolated + fillFailures + bitmapFailures > 0) {
  console.log(`${failures + unisolated + fillFailures + bitmapFailures} checks failed`);
  process.exitCode = 1;
}
