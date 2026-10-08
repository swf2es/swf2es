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
//
//   node tests/web/run.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare, cases, scripted } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng, type Image } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { importMap } from "../player/serve.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const site = `${out}site/`;
/** What 20 elements made and destroyed may leave on the heap, each: a tenth of a player's. */
const BOUND = 256 * 1024;
const CHURN = 20;

// This package's own copies: pnpm runs the player's tests at the same time.
libraryAbcs(`${out}libraries/`);
const abcs = compileScripts(
  ["Main", { name: "EmbedTest", source: readFileSync(`${here}scripts/EmbedTest.as`, "utf8") }],
  out,
);
mkdirSync(site, { recursive: true });
const fillHoles = cases.find((c) => c.name === "fill-holes")?.swf as Uint8Array;
writeFileSync(`${site}shapes.swf`, fillHoles);
writeFileSync(`${site}scripted.swf`, scripted(abcs.get("Main") as Uint8Array));
writeFileSync(
  `${site}embed.swf`,
  bare(abcs.get("EmbedTest") as Uint8Array, 1, "EmbedTest", 160, 120),
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
const check = (name: string, run: (evaluate: Evaluate, send: Send) => Promise<void>) =>
  checks.push([name, run]);

let booted: Booted[] = [];
const byId = (id: string) => booted.find((b) => b.id === id) as Booted;

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
    assert.match(String(ei.calls.reports[0]?.href), /\/web-test\/index\.html$/);
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
    assert.equal(counts.libraryFetches, 2);
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

const failures = await withPage(
  "survivors",
  async (evaluate, send, fresh, listen) => {
    // What the page threw, told with a failing check: an error of its own, not a time out.
    const thrown: string[] = [];
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
  false,
  {
    page: "web-test/index.html",
    mounts: [
      ["/web-test/", site],
      ["/web-src/", here],
      ["/libraries/", `${out}libraries/`],
    ],
  },
);

if (failures > 0) {
  console.log(`${failures} of ${checks.length} checks failed`);
  process.exitCode = 1;
}
