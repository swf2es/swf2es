// The demo site (apps/site) in headless Chrome, built as GitHub Pages gets
// it and served under /swf2es/ as Pages serves it, without the headers its
// service worker adds to isolate it, which it is then: a first visit loads the
// browser build in a few files and shows its loading until the first frame, a
// demo by ?swf= plays and traces, a SWF's workers share a Mutex and memory, a key's uncaught
// error reaches the console, a file opened with the picker and a URL
// load play, a URL the browser may not fetch
// says why, the report link carries the SWF's facts and the errors, the
// licences are there, the home page sends the player's old links to it, the
// compatibility page shows its figures, and the guide's pages are there with
// every link within the site leading somewhere. It leaves a screenshot in
// tests/site/out/site.png.
//
//   node tests/site/run.ts            build the site, then check it
//   node tests/site/run.ts --serve    build it and serve it to look at, until ^C

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readGuide } from "../../apps/site/guide.ts";
import { cases } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compileScripts } from "../player/scripts.ts";
import { serve } from "../player/serve.ts";
import * as w from "../swf-writer.ts";
import { zip } from "../zip-writer.ts";
import { fullscreenChecks } from "./fullscreen.ts";
import { isolationChecks } from "./isolation.ts";
import { loadingChecks } from "./loading.ts";
import { stage3DChecks } from "./stage3d.ts";

/** A SWF's URL, sandbox and the shared object it saves its file name in, by what was there before. */
const PROBE = `package {
  import flash.display.Sprite;
  import flash.net.SharedObject;
  import flash.system.Security;
  public class Probe extends Sprite {
    public function Probe() {
      var so:SharedObject = SharedObject.getLocal("probe");
      var url:String = loaderInfo.url;
      var before:String = so.data.owner === undefined ? "none" : so.data.owner;
      trace("probe " + url + " " + Security.sandboxType + ", before: " + before);
      so.data.owner = url.split("/").pop();
      so.flush();
      trace("probe saved");
    }
  }
}`;

/**
 * Run in the page: every page of the site that its pages link to from
 * `base`, by its path and its title, and what they link to under `base`
 * that is not there: a page, a file, or a heading of a page.
 */
const crawl = `async (base) => {
  const queue = [base];
  const seen = new Set(queue);
  const pages = [];
  const broken = [];
  const ids = new Map();
  const anchors = [];
  const parser = new DOMParser();
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    const response = await fetch(url);
    if (!response.ok) {
      broken.push(url + ": " + response.status);
      continue;
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
      continue;
    }
    const doc = parser.parseFromString(await response.text(), "text/html");
    const path = new URL(url).pathname;
    pages.push([path, doc.querySelector("h1")?.textContent?.trim() ?? ""]);
    ids.set(path, new Set([...doc.querySelectorAll("[id]")].map((e) => e.id)));
    for (const element of doc.querySelectorAll("a[href], link[href], script[src], img[src]")) {
      const target = new URL(element.getAttribute("href") ?? element.getAttribute("src"), url);
      if (!target.href.startsWith(base)) {
        continue;
      }
      if (target.hash.length > 1) {
        anchors.push([url, target.pathname, decodeURIComponent(target.hash.slice(1))]);
      }
      target.hash = "";
      // A page with a query is the page: the player's ?swf= is for its script.
      target.search = "";
      if (!seen.has(target.href)) {
        seen.add(target.href);
        queue.push(target.href);
      }
    }
  }
  for (const [from, path, id] of anchors) {
    if (!ids.get(path)?.has(id)) {
      broken.push(from + ": " + path + "#" + id);
    }
  }
  return { pages, broken };
}`;

type WorkerSwf = (abc: Uint8Array) => Uint8Array;

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const site = `${root}apps/site/dist/site/`;
const out = `${here}out/`;
const mounts: [string, string][] = [["/swf2es/", site]];

// Under /swf2es/, as GitHub Pages serves it, whatever SITE_BASE says.
execFileSync(process.execPath, [`${root}apps/site/build.ts`], {
  stdio: "inherit",
  env: { ...process.env, SITE_BASE: "/swf2es/" },
});

if (process.argv.includes("--serve")) {
  const { url } = await serve(mounts, undefined, false);
  console.log(`the site: ${url}swf2es/`);
} else {
  await check();
}

type Evaluate = <R>(expression: string) => Promise<{ value?: R; exception: string | null }>;
type Send = <R>(method: string, params?: object) => Promise<R>;

async function check(): Promise<void> {
  mkdirSync(out, { recursive: true });
  const failures = await withPage(
    "customElements.get",
    async (evaluate: Evaluate, send: Send, _fresh, listen) => {
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `globalThis.nativeFillInstances = 0;
          WebAssembly.Instance = new Proxy(WebAssembly.Instance, {
            construct(target, args) {
              const instance = Reflect.construct(target, args);
              if (typeof instance.exports.vertexCount === "function") {
                globalThis.nativeFillInstances++;
              }
              return instance;
            }
          });`,
      });
      const thrown: string[] = [];
      listen("Runtime.exceptionThrown", (params) => {
        const details = params.exceptionDetails as {
          exception?: { description?: string };
          text: string;
        };
        thrown.push(details.exception?.description ?? details.text);
      });
      const value = async <R>(expression: string): Promise<R> => {
        const { value, exception } = await evaluate<R>(expression);
        if (exception !== null) {
          throw new Error(`${expression}: ${exception}`);
        }

        return value as R;
      };
      /** Until `expression` is true, or fail after `ms` with what the page shows. */
      const until = async (expression: string, ms = 60_000) => {
        for (const start = Date.now(); Date.now() - start < ms; ) {
          if (await value<boolean>(expression)) {
            return;
          }

          await new Promise((done) => setTimeout(done, 100));
        }

        const shown = await value<string>(
          "document.getElementById('status').textContent + ' | ' + document.getElementById('log').innerText.slice(-600)",
        );
        throw new Error(`${expression} not within ${ms} ms; the page shows: ${shown}`);
      };
      const logHas = (text: string) =>
        `document.getElementById('log').innerText.includes(${JSON.stringify(text)})`;
      const playing = (name: string) =>
        `document.getElementById('status').textContent === ${JSON.stringify(`Playing ${name}.`)}`;
      const navigate = async (path: string) => {
        const previous = await value<number>("performance.timeOrigin");
        await send("Page.navigate", { url: `${base}${path}` });
        for (const start = Date.now(); ; ) {
          const ready = await evaluate<boolean>(
            `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!customElements.get('swf2es-player')`,
          ).catch(() => null);
          if (ready?.value) {
            return;
          }

          assert.ok(Date.now() - start < 60_000, `${path} did not load a new document`);
          await new Promise((done) => setTimeout(done, 100));
        }
      };
      /**
       * Until the page that `path`'s navigation sends on to is at
       * `pathname` and loaded: asked while a page moves on, the document
       * may answer nothing, or the target navigate away mid-question.
       */
      const redirected = async (path: string, pathname: string) => {
        await send("Page.navigate", { url: `${base}${path}` });
        for (let tries = 0; ; tries++) {
          const at = await evaluate<string>("location.pathname").catch(() => null);
          if (at?.value === pathname) {
            break;
          }

          assert.ok(tries < 100, `${path} stayed at ${at?.value}`);
          await new Promise((done) => setTimeout(done, 100));
        }

        await until("document.readyState === 'complete'");
      };

      const base = (await value<string>("location.origin")).concat("/swf2es/");
      await send("Emulation.setDeviceMetricsOverride", {
        width: 1000,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });

      const checks: [string, () => Promise<void>][] = [
        [
          "its service worker makes the page cross-origin isolated, as Pages sends no headers",
          async () => {
            // Until the page is isolated, through the reloads that make it so.
            const isolation = async (step: string, previous: number | null = null) => {
              const start = Date.now();
              for (;;) {
                // A reload is acknowledged before it replaces the old, already isolated document.
                const state = await evaluate<{
                  isolated: boolean;
                  controlled: boolean;
                  timeOrigin: number;
                  ready: string;
                }>(`({ isolated: crossOriginIsolated, controlled: !!navigator.serviceWorker.controller,
                  timeOrigin: performance.timeOrigin, ready: document.readyState,
                  navigation: performance.getEntriesByType('navigation')[0]?.type,
                  retry: new URL(location.href).searchParams.get('__swf2es_isolation'),
                  loading: document.getElementById('loading')?.hidden,
                  status: document.getElementById('status')?.textContent,
                  element: !!customElements.get('swf2es-player') })`).catch(() => null);
                if (
                  state?.value?.isolated &&
                  state.value.controlled &&
                  state.value.timeOrigin !== previous
                ) {
                  return;
                }

                assert.ok(
                  Date.now() - start < 60_000,
                  `${step}: the new page is not cross-origin isolated: ${JSON.stringify(state)}`,
                );
                await new Promise((done) => setTimeout(done, 100));
              }
            };
            const bypass = async (step: string) => {
              const previous = await value<number>("performance.timeOrigin");
              await send("Page.reload", { ignoreCache: true });
              await isolation(step, previous);
            };
            // As a busy machine runs it, which CI's is: the reloads' timing is what this tests.
            await send("Emulation.setCPUThrottlingRate", { rate: 6 });
            try {
              await isolation("first visit");
              await bypass("bypass while loading");
              // Wait for this document, not an earlier navigation still being replaced.
              await until(
                "document.readyState === 'complete' && !!customElements.get('swf2es-player')",
              );
              await bypass("bypass after loading");
            } finally {
              await send("Emulation.setCPUThrottlingRate", { rate: 1 });
            }

            await until(
              "document.readyState === 'complete' && !!customElements.get('swf2es-player')",
            );
          },
        ],
        ...isolationChecks({ value, send, navigate, listen }),
        [
          "a player that fails to load says so in place of its loading state",
          async () => {
            // A first visit, as no service worker then asks for the files where the page's
            // blocked URLs would not reach it.
            await send("Storage.clearDataForOrigin", {
              origin: new URL(base).origin,
              storageTypes: "all",
            });
            await send("Network.clearBrowserCache");
            await send("Network.enable");
            await send("Network.setBlockedURLs", { urls: ["*/swf2es/player/swf2es.js"] });
            try {
              await send("Page.navigate", { url: `${base}play/` });
              await until(
                "document.getElementById('status')?.textContent === 'The player did not load. Reload the page to try again.'",
              );
              assert.equal(
                await value<string>("document.getElementById('loading-label').textContent"),
                "The player did not load. Reload the page to try again.",
              );
              assert.equal(
                await value<boolean>("document.getElementById('loading').hidden"),
                false,
              );
            } finally {
              await send("Network.setBlockedURLs", { urls: [] });
              await send("Network.disable");
            }

            // A page script that throws as it runs, which the window hears as an ErrorEvent.
            listen("Fetch.requestPaused", (params) => {
              void send("Fetch.fulfillRequest", {
                requestId: params.requestId,
                responseCode: 200,
                responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
                body: Buffer.from('throw new Error("broken on purpose");').toString("base64"),
              });
            });
            await send("Fetch.enable", { patterns: [{ urlPattern: "*/swf2es/app/main.js" }] });
            try {
              await send("Page.navigate", { url: `${base}play/` });
              await until(
                "document.getElementById('status')?.textContent === 'The player did not load. Reload the page to try again.'",
              );
            } finally {
              await send("Fetch.disable");
              listen("Fetch.requestPaused", () => {});
            }
          },
        ],
        [
          "the failure message hears only this site's player scripts, and only until it runs",
          async () => {
            // Before the page's module runs: as the document turns interactive, its deferred
            // scripts not yet run. An error elsewhere is not the player's; a chunk's is.
            const { identifier } = await send<{ identifier: string }>(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `document.addEventListener("readystatechange", () => {
                  if (document.readyState !== "interactive") return;
                  const status = () => document.getElementById("status").textContent;
                  const fail = (filename) => dispatchEvent(new ErrorEvent("error", { filename }));
                  fail("https://elsewhere.example/swf2es/app/main.js");
                  fail(location.origin + "/elsewhere/app/main.js");
                  fail(location.origin + "/swf2es/app/deeper/main.js");
                  globalThis.foreignStatus = status();
                  fail(location.origin + "/swf2es/player/chunks/0123456789abcdef.js");
                  globalThis.chunkStatus = status();
                  globalThis.chunkProgressHidden = document.getElementById("loading-progress").hidden;
                });`,
              },
            );
            try {
              await send("Page.navigate", { url: `${base}play/` });
              // Through the reload that isolates it; asked while the page goes, it may not answer.
              for (const start = Date.now(); ; ) {
                const ready = await evaluate<boolean>("globalThis.swf2esPlayerReady === true").then(
                  (r) => r.value === true,
                  () => false,
                );
                if (ready) {
                  break;
                }

                assert.ok(Date.now() - start < 60_000, "the player did not start");
                await new Promise((wait) => setTimeout(wait, 100));
              }
            } finally {
              await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
            }

            assert.equal(await value<string>("foreignStatus"), "Loading player…");
            assert.equal(
              await value<string>("chunkStatus"),
              "The player did not load. Reload the page to try again.",
            );
            assert.equal(await value<boolean>("chunkProgressHidden"), true);
            // Running, the player cleared it; an error of its own script now is a SWF's or a
            // bug, which the console shows, not a player that did not load.
            assert.equal(await value<string>("document.getElementById('status').textContent"), "");
            await value(
              `(dispatchEvent(new ErrorEvent("error", { filename: new URL("../app/main.js", location.href).href })), true)`,
            );
            assert.equal(await value<string>("document.getElementById('status').textContent"), "");
            // A SWF loading after that shows its progress, which the failure had hidden.
            await value("document.querySelector('#demos button').click()");
            await until("document.getElementById('status').textContent.startsWith('Playing ')");
            assert.equal(
              await value<boolean>("document.getElementById('loading-progress').hidden"),
              false,
            );
          },
        ],
        [
          "a cold visit fetches the player as a few files, its loading shown until the first frame",
          async () => {
            // What the stage's loading state showed, in each document, as it changed.
            const { identifier } = await send<{ identifier: string }>(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `globalThis.loadingSeen = [];
                  new MutationObserver(() => {
                    const box = document.getElementById("loading");
                    const label = document.getElementById("loading-label");
                    const seen = box && label ? (box.hidden ? "hidden" : label.textContent) : null;
                    if (seen !== null && loadingSeen.at(-1) !== seen) {
                      loadingSeen.push(seen);
                    }
                  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });`,
              },
            );
            const urls = new Set<string>();
            let requests = 0;
            listen("Network.requestWillBeSent", (params) => {
              const { url } = params.request as { url: string };
              if (/^https?:/.test(url)) {
                urls.add(url);
                requests++;
              }
            });
            await send("Network.enable");
            // As a first visit: no service worker, cached file or module kept from before.
            await send("Storage.clearDataForOrigin", {
              origin: new URL(base).origin,
              storageTypes: "all",
            });
            await send("Network.clearBrowserCache");
            try {
              await send("Page.navigate", { url: `${base}play/?swf=demos%2Fbounce.swf` });
              // Through the reload that isolates it; asked while the page goes, it may not answer.
              const start = Date.now();
              for (let done = false; !done; ) {
                assert.ok(Date.now() - start < 60_000, "the demo did not play isolated");
                await new Promise((wait) => setTimeout(wait, 100));
                done = await evaluate<boolean>(
                  `crossOriginIsolated && ${playing("bounce.swf")}`,
                ).then(
                  (r) => r.value === true,
                  () => false,
                );
              }
            } finally {
              await send("Network.disable");
              listen("Network.requestWillBeSent", () => {});
              await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
            }

            // The browser build's few files, where the packages' own modules were some 900, and
            // the requests for them, each asked again by the reload that isolates the page.
            assert.ok(urls.size <= 30, `${urls.size} files:\n${[...urls].join("\n")}`);
            assert.ok(requests <= 60, `${requests} requests for ${urls.size} files`);
            assert.ok(
              [...urls].some((u) => u.endsWith("/swf2es/player/swf2es.js")),
              "the page did not load the browser build",
            );
            assert.ok(
              ![...urls].some((u) => u.includes("/swf2es/modules/")),
              "the page loaded the packages' modules",
            );
            // A label caught before its text is parsed is empty.
            const seen = (await value<string[]>("loadingSeen")).filter((label) => label !== "");
            assert.equal(seen[0], "Loading player…", seen.join(" | "));
            assert.ok(
              seen.includes("Starting bounce.swf…"),
              `no start of the SWF shown: ${seen.join(" | ")}`,
            );
            assert.equal(seen.at(-1), "hidden", seen.join(" | "));
            assert.equal(await value<boolean>("document.getElementById('loading').hidden"), true);
            assert.equal(
              await value<string>("document.getElementById('player').hidden ? 'hidden' : 'shown'"),
              "shown",
            );
          },
        ],
        ...loadingChecks({ value, send, until, navigate, site }),
        [
          "?swf= plays a demo, which traces and draws",
          async () => {
            await navigate("play/?swf=demos%2Fbounce.swf");
            await until(playing("bounce.swf"));
            await until(logHas("Hello from ActionScript 3"));
            // The render module's own instance: its bitmap kernels are in the same binary.
            assert.equal(
              await value<boolean>("globalThis.nativeFillInstances > 0"),
              true,
              "playback did not use the native tessellator",
            );
            const facts = await value<string>("document.getElementById('facts').innerText");
            assert.match(facts, /3 \(AVM2\)/);
            assert.match(facts, /480 × 320/);
            const demos = await value<number>("document.querySelectorAll('#demos li').length");
            assert.equal(demos, 5);
            const source = await value<string>("document.querySelector('#demos a').href");
            assert.match(
              source,
              /^https:\/\/github\.com\/swf2es\/swf2es\/blob\/[0-9a-f]{40}\/apps\/site\//,
            );
            // Each demo's SWF to download beside its source; as3pb's source in its own repository.
            const links = await value<[string, string, string][]>(
              "[...document.querySelectorAll('#demos li')].map((li) => { const [source, download] = li.querySelectorAll('a'); return [source.href, download.getAttribute('download'), download.href]; })",
            );
            for (const [, name, href] of links) {
              assert.match(name, /^[\w-]+\.swf$/);
              assert.ok(href.endsWith(`/swf2es/demos/${name}`), href);
              const response = await value<number>(
                `fetch(${JSON.stringify(href)}).then((r) => r.status)`,
              );
              assert.equal(response, 200, `${href} did not download`);
            }
            assert.match(
              links[3][0],
              /^https:\/\/github\.com\/33TU\/as3pb\/blob\/[0-9a-f]{40}\/runtime\/test\/bench\/Main\.as$/,
            );
            assert.equal(links[3][1], "as3pb-bench.swf");
            assert.equal(links[4][1], "mandel.swf");
            const box = await value<number[]>(
              "(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()",
            );
            await new Promise((done) => setTimeout(done, 500));
            const shot = await send<{ data: string }>("Page.captureScreenshot", {
              format: "png",
              clip: { x: box[0], y: box[1], width: box[2], height: box[3], scale: 1 },
            });
            assert.ok(shot.data.length > 5000, "the stage drew next to nothing");
            const page = await send<{ data: string }>("Page.captureScreenshot", {
              format: "png",
            });
            writeFileSync(`${out}site.png`, Buffer.from(page.data, "base64"));

            // The performance meter is off until asked for: no listener on the player, the
            // context's own functions, nothing shown, the choice not kept.
            const gl = "document.getElementById('player').gl";
            const wrapped = `Object.hasOwn(${gl}, 'drawElements')`;
            const meterShown =
              "!document.getElementById('meter').hidden && document.getElementById('meter-toggle').checked";
            assert.equal(await value<boolean>("document.getElementById('meter').hidden"), true);
            assert.equal(
              await value<boolean>("document.getElementById('player').frameListener === null"),
              true,
            );
            assert.equal(await value<boolean>(wrapped), false);
            assert.equal(
              await value<string | null>("localStorage.getItem('swf2es.performanceMeter')"),
              null,
            );
            // Ctrl+Shift+F shows it while the player has the focus, the SWF never hearing the F.
            await value(
              "(globalThis.heardF = 0, document.getElementById('player').addEventListener('keydown', (e) => { if (e.code === 'KeyF') heardF++; }), document.getElementById('player').focus(), true)",
            );
            const shortcut = async () => {
              for (const type of ["keyDown", "keyUp"]) {
                await send("Input.dispatchKeyEvent", {
                  type,
                  key: "F",
                  code: "KeyF",
                  windowsVirtualKeyCode: 70,
                  modifiers: 2 | 8,
                });
              }
            };
            await shortcut();
            await until(meterShown);
            assert.equal(await value<number>("heardF"), 0);
            assert.equal(
              await value<string | null>("localStorage.getItem('swf2es.performanceMeter')"),
              "1",
            );
            // Its figures: the frames played a second against the SWF's rate, the player's ms in a
            // frame, and the heap and memories behind it.
            await until("/ fps$/.test(document.getElementById('fps').textContent)");
            const figures = await value<Record<string, string>>(
              "Object.fromEntries([...document.querySelectorAll('#meter dd')].map((dd) => [dd.id, dd.textContent]))",
            );
            const fps = /^(\d+\.\d) \/ (\d+(?:\.\d+)?) fps$/.exec(figures.fps);
            assert.ok(fps, figures.fps);
            assert.ok(Number(fps[1]) > 0 && Number(fps[1]) <= Number(fps[2]) * 1.5, figures.fps);
            assert.match(figures["frame-time"], /^\d+\.\d ms, max \d+\.\d$/);
            assert.match(figures.heap, /^\d+(\.\d)? MB$/);
            assert.match(figures["codegen-memory"], /^\d+(\.\d)? MB$/);
            assert.match(figures["native-memory"], /^\d+(\.\d)? MB$/);
            // Over the stage's corner, the pointer passing through it to the SWF.
            const meterBox = await value<{ inside: boolean; events: string }>(
              "(() => { const m = document.getElementById('meter').getBoundingClientRect(); const s = document.getElementById('stage').getBoundingClientRect(); return { inside: m.left >= s.left && m.top >= s.top && m.right <= s.right && m.bottom <= s.bottom, events: getComputedStyle(document.getElementById('meter')).pointerEvents }; })()",
            );
            assert.deepEqual(meterBox, { inside: true, events: "none" });
            const meterShot = await send<{ data: string }>("Page.captureScreenshot", {
              format: "png",
              clip: { x: box[0], y: box[1], width: box[2], height: box[3], scale: 1 },
            });
            writeFileSync(`${out}meter.png`, Buffer.from(meterShot.data, "base64"));

            // The meter counts the renderer's draws, and the GL calls that make them, while it
            // shows: a multi-draw is one call of many draws.
            await until("Number(document.getElementById('sub-draws').textContent) > 0");
            // Both read at once, so that they are of one showing.
            const [calls, draws] = await value<number[]>(
              "['gl-calls', 'sub-draws'].map((id) => Number(document.getElementById(id).textContent))",
            );
            assert.ok(calls > 0 && calls <= draws, `${calls} GL calls for ${draws} draws`);
            // While the context is lost, the context has its own functions back.
            assert.equal(await value<boolean>(wrapped), true);
            await value(
              `((globalThis.lose = ${gl}.getExtension('WEBGL_lose_context')).loseContext(), true)`,
            );
            await until(`!${wrapped}`);
            await value("(lose.restoreContext(), true)");
            await until(wrapped);
            await value("(document.getElementById('sub-draws').textContent = '', true)");
            await until("Number(document.getElementById('sub-draws').textContent) > 0");
            // Off again, by its box: hidden, unmeasured and unwrapped, and so kept.
            await value("(document.getElementById('meter-toggle').click(), true)");
            await until("document.getElementById('meter').hidden");
            assert.equal(
              await value<boolean>("document.getElementById('player').frameListener === null"),
              true,
            );
            await until(`!${wrapped}`);
            assert.equal(
              await value<string | null>("localStorage.getItem('swf2es.performanceMeter')"),
              null,
            );
            // Kept on, it is on as the page loads again.
            await shortcut();
            await until(meterShown);
            await navigate("play/?swf=demos%2Fbounce.swf");
            await until(playing("bounce.swf"));
            await until(meterShown);
            await until("/ fps$/.test(document.getElementById('fps').textContent)");
            await shortcut();
            await until("document.getElementById('meter').hidden");

            // The context menu's About item names the build the page was made from.
            for (const type of ["mousePressed", "mouseReleased"]) {
              await send("Input.dispatchMouseEvent", {
                type,
                x: box[0] + box[2] / 2,
                y: box[1] + box[3] / 2,
                button: "right",
                clickCount: 1,
              });
            }
            const menu =
              "document.getElementById('player').shadowRoot.querySelector('[data-swf2es-context-menu]')";
            await until(`!!${menu}`);
            const about = await value<string>(
              `[...${menu}.shadowRoot.querySelectorAll('button')].at(-1).textContent`,
            );
            const build = await value<string>(
              "document.querySelector('[data-build]').dataset.build",
            );
            assert.equal(about, build === "unknown" ? "About swf2es" : `About swf2es (${build})`);
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "Escape",
              code: "Escape",
              windowsVirtualKeyCode: 27,
            });
            await until(`!${menu}`);
          },
        ],
        [
          "a click and a key reach the SWF, and its uncaught error the console",
          async () => {
            const box = await value<number[]>(
              "(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
            );
            for (const type of ["mousePressed", "mouseReleased"]) {
              await send("Input.dispatchMouseEvent", {
                type,
                x: box[0],
                y: box[1],
                button: "left",
                clickCount: 1,
              });
            }

            await until(logHas("Click 1 at"));
            await send("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: "e",
              code: "KeyE",
              windowsVirtualKeyCode: 69,
            });
            await send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: "e",
              code: "KeyE",
              windowsVirtualKeyCode: 69,
            });
            await until(
              "[...document.querySelectorAll('#log .error')].some((e) => e.textContent.includes('thrown on purpose'))",
            );
          },
        ],
        [
          "gameplay keys reach the focused player without scrolling the page",
          async () => {
            await value(`(() => {
              document.body.style.minHeight = "3000px";
              document.body.style.minWidth = "2000px";
              document.getElementById("player").focus({ preventScroll: true });
              scrollTo({ left: 300, top: 300, behavior: "instant" });
              return true;
            })()`);
            const position = () => value<number[]>("[scrollX, scrollY]");
            assert.deepEqual(await position(), [300, 300]);
            const handled = () =>
              value<number>("document.getElementById('player').player.keyboard.handled");
            const press = async (key: string, code: string, keyCode: number) => {
              const before = await handled();
              for (const type of ["keyDown", "keyUp"]) {
                await send("Input.dispatchKeyEvent", {
                  type,
                  key,
                  code,
                  windowsVirtualKeyCode: keyCode,
                  ...(type === "keyDown" && key === " " ? { text: " " } : {}),
                });
              }

              await new Promise((done) => setTimeout(done, 200));
              return (await handled()) - before;
            };
            try {
              const keys: [string, string, number][] = [
                ["ArrowDown", "ArrowDown", 40],
                ["ArrowUp", "ArrowUp", 38],
                ["ArrowRight", "ArrowRight", 39],
                ["ArrowLeft", "ArrowLeft", 37],
                [" ", "Space", 32],
                ["PageDown", "PageDown", 34],
                ["PageUp", "PageUp", 33],
                ["End", "End", 35],
                ["Home", "Home", 36],
              ];
              for (const [key, code, keyCode] of keys) {
                assert.equal(await press(key, code, keyCode), 2, `${code} reaches the SWF`);
                assert.deepEqual(await position(), [300, 300], `${code} must not scroll`);
              }

              // Browser shortcuts keep their defaults, and Shift+Space stays a gameplay key.
              assert.deepEqual(
                await value(`(() => {
                  const player = document.getElementById("player");
                  return ["ctrlKey", "metaKey", "altKey", "shiftKey"].map(modifier => {
                    const e = new KeyboardEvent("keydown", {
                      key: " ", keyCode: 32, bubbles: true, cancelable: true, [modifier]: true
                    });
                    player.dispatchEvent(e);
                    return e.defaultPrevented;
                  });
                })()`),
                [false, false, false, true],
              );

              await value(`document.getElementById("url").focus({ preventScroll: true })`);
              assert.equal(await press("ArrowDown", "ArrowDown", 40), 0);
              await value(`document.getElementById("report").focus({ preventScroll: true })`);
              assert.equal(await press("ArrowDown", "ArrowDown", 40), 0);
              // Chrome scrolls at once, without its smooth scrolling (see withPage's args below).
              const [, y] = await position();
              assert.ok(
                y > 300,
                `ArrowDown on the report link scrolls the page, which stayed at ${y}`,
              );
            } finally {
              await value(`(() => {
                document.body.style.minHeight = "";
                document.body.style.minWidth = "";
                scrollTo({ left: 0, top: 0, behavior: "instant" });
                return true;
              })()`);
            }
          },
        ],
        [
          "Ctrl+K reaches a focused SWF, not the site's search, which it opens elsewhere",
          async () => {
            const open = "document.querySelector('site-search dialog').open";
            const handled = "document.getElementById('player').player.keyboard.handled";
            const press = async () => {
              for (const type of ["keyDown", "keyUp"]) {
                await send("Input.dispatchKeyEvent", {
                  type,
                  key: "k",
                  code: "KeyK",
                  windowsVirtualKeyCode: 75,
                  modifiers: 2,
                });
              }

              await new Promise((done) => setTimeout(done, 200));
            };
            await value("(document.getElementById('player').focus({ preventScroll: true }), true)");
            const before = await value<number>(handled);
            await press();
            assert.equal((await value<number>(handled)) - before, 2, "Ctrl+K reaches the SWF");
            assert.equal(await value<boolean>(open), false, "the search opened over the SWF");

            await value("(document.activeElement.blur(), true)");
            await press();
            assert.equal(await value<boolean>(open), true, "the search did not open");
            await value(
              "(document.querySelector('site-search dialog').close(), document.getElementById('player').focus({ preventScroll: true }), true)",
            );
          },
        ],
        [
          "the report link carries the SWF's facts and the last error",
          async () => {
            const href = await value<string>(
              "(() => { const a = document.getElementById('report'); a.dispatchEvent(new Event('focus')); return a.href; })()",
            );
            const url = new URL(href);
            assert.equal(
              `${url.origin}${url.pathname}`,
              "https://github.com/swf2es/swf2es/issues/new",
            );
            const body = url.searchParams.get("body") ?? "";
            assert.match(url.searchParams.get("title") ?? "", /AVM2/);
            assert.match(body, /SWF version: 10/);
            assert.match(body, /ActionScript: 3 \(AVM2\)/);
            assert.match(body, /File size: \d+ bytes/);
            assert.match(body, /From: the demo bounce\.swf/);
            assert.match(body, /Browser: .*Chrome/);
            assert.match(body, /thrown on purpose/);
          },
        ],
        [
          "a file opened with the picker plays, an AVM1 SWF among them",
          async () => {
            const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
              expression: "document.getElementById('file')",
            });
            await send("DOM.setFileInputFiles", {
              objectId: result.objectId,
              files: [`${site}demos/orbit.swf`],
            });
            await until(playing("orbit.swf"));
            await until(logHas("Primes: 2 3 5 7 11 13 17 19 23 29 31 37"));
            const facts = await value<string>("document.getElementById('facts').innerText");
            assert.match(facts, /1\/2 \(AVM1\)/);
            assert.equal(await value<string>("location.search"), "");
            const body = new URL(
              await value<string>(
                "(() => { const a = document.getElementById('report'); a.dispatchEvent(new Event('focus')); return a.href; })()",
              ),
            ).searchParams.get("body");
            // A local file's name stays with its owner.
            assert.match(body ?? "", /From: a local file/);
            assert.doesNotMatch(body ?? "", /orbit/);

            // Nor does one that fails to play name it among the errors.
            const broken = `${out}private-name.swf`;
            writeFileSync(
              broken,
              w.swf({
                width: 100,
                height: 100,
                frameRate: 30,
                frameCount: 1,
                tags: [
                  w.fileAttributes(true),
                  w.doAbc(new Uint8Array([16, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 99]), "X"),
                  w.showFrame(),
                  w.end(),
                ],
              }),
            );
            await send("DOM.setFileInputFiles", { objectId: result.objectId, files: [broken] });
            await until("document.getElementById('status').textContent.includes('did not play')");
            const failed = new URL(
              await value<string>(
                "(() => { const a = document.getElementById('report'); a.dispatchEvent(new Event('focus')); return a.href; })()",
              ),
            ).searchParams.get("body");
            assert.match(failed ?? "", /did not play/);
            assert.doesNotMatch(failed ?? "", /private-name/);
          },
        ],
        [
          "a ZIP of an AIR application's folder opened with the picker plays as the application",
          async () => {
            const source = `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filesystem.File;
  import flash.net.URLLoader;
  import flash.net.URLRequest;
  import flash.system.Security;
  public class SiteAir extends Sprite {
    public function SiteAir() {
      trace("site air: " + loaderInfo.url + " " + Security.sandboxType + " " + File.applicationDirectory.resolvePath("data.txt").exists);
      var loader:URLLoader = new URLLoader();
      loader.addEventListener(Event.COMPLETE, function (e:Event):void {
        trace("site air data: " + loader.data);
      });
      loader.load(new URLRequest("app:/data.txt"));
    }
  }
}`;
            const abc = compileScripts([{ name: "SiteAir", source }], `${out}scripts`).get(
              "SiteAir",
            ) as Uint8Array;
            const swf = w.swf({
              width: 100,
              height: 100,
              frameRate: 30,
              frameCount: 1,
              tags: [
                w.fileAttributes(true),
                w.doAbc(abc, "SiteAir"),
                w.symbolClass([[0, "SiteAir"]]),
                w.showFrame(),
                w.end(),
              ],
            });
            writeFileSync(
              `${out}my-app.zip`,
              zip([
                {
                  name: "MyApp/MyApp-app.xml",
                  data: `<application xmlns="http://ns.adobe.com/air/application/51.3"><id>org.example.site</id><initialWindow><content>MyApp.swf</content><width>300</width><height>200</height></initialWindow></application>`,
                },
                { name: "MyApp/MyApp.swf", data: swf },
                { name: "MyApp/data.txt", data: "from the zip", deflated: true },
              ]),
            );
            const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
              expression: "document.getElementById('file')",
            });
            await send("DOM.setFileInputFiles", {
              objectId: result.objectId,
              files: [`${out}my-app.zip`],
            });
            await until(playing("my-app.zip"));
            await until(logHas("site air data: from the zip"));
            assert.equal(
              await value<boolean>(logHas("site air: app:/MyApp.swf application true")),
              true,
            );
            assert.equal(await value<boolean>(logHas("AIR application org.example.site")), true);
          },
        ],
        [
          "a SWF's workers share a Mutex and memory, the page isolated by its service worker",
          async () => {
            const abc = compileScripts(["WorkerMutex"], `${out}scripts`).get(
              "WorkerMutex",
            ) as Uint8Array;
            const swf = (
              (cases.find((c) => c.name === "worker-mutex") as (typeof cases)[number])
                .swf as WorkerSwf
            )(abc);
            writeFileSync(`${out}worker-mutex.swf`, swf);
            await value("document.getElementById('log').replaceChildren()");
            const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
              expression: "document.getElementById('file')",
            });
            await send("DOM.setFileInputFiles", {
              objectId: result.objectId,
              files: [`${out}worker-mutex.swf`],
            });
            await until(logHas("free true"));
            const lines = await value<string[]>(
              "[...document.querySelectorAll('#log div')].map((d) => d.textContent)",
            );
            const expected = readFileSync(
              `${root}tests/player/references/worker-mutex/trace.txt`,
              "utf8",
            )
              .trim()
              .split("\n");
            assert.deepEqual(
              lines.filter((l) => expected.includes(l ?? "")),
              expected,
            );
          },
        ],
        [
          "the Crossbridge demo runs its C++ threads as workers, and a click adds one",
          async () => {
            await navigate("play/?swf=demos%2Fmandel.swf");
            await until(playing("mandel.swf"));
            // Thread 1 is main's, in a background worker, made before main listens for clicks;
            // so the stage is clicked until OpenMP makes another.
            await until(logHas("CRun::newThread: 1,"));
            const box = await value<number[]>(
              "(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()",
            );
            const added = logHas("CRun::newThread: 2,");
            for (const start = Date.now(); !(await value<boolean>(added)); ) {
              assert.ok(Date.now() - start < 60_000, "no click added a thread");
              for (const type of ["mousePressed", "mouseReleased"]) {
                await send("Input.dispatchMouseEvent", {
                  type,
                  x: box[0],
                  y: box[1],
                  button: "left",
                  clickCount: 1,
                });
              }

              await new Promise((done) => setTimeout(done, 1000));
            }
          },
        ],
        [
          "local files keep shared objects of their own, from a URL on the site",
          async () => {
            const abc = compileScripts([{ name: "Probe", source: PROBE }], `${out}scripts`).get(
              "Probe",
            ) as Uint8Array;
            const probe = w.swf({
              width: 100,
              height: 100,
              frameRate: 30,
              frameCount: 1,
              tags: [
                w.fileAttributes(true),
                w.doAbc(abc, "Probe"),
                w.symbolClass([[0, "Probe"]]),
                w.showFrame(),
                w.end(),
              ],
            });
            const { result } = await send<{ result: { objectId: string } }>("Runtime.evaluate", {
              expression: "document.getElementById('file')",
            });
            const open = async (name: string, expected: string) => {
              writeFileSync(`${out}${name}`, probe);
              await value("document.getElementById('log').replaceChildren()");
              await send("DOM.setFileInputFiles", {
                objectId: result.objectId,
                files: [`${out}${name}`],
              });
              await until(logHas("probe saved"));
              const line = await value<string>(
                "[...document.querySelectorAll('#log div')].map((d) => d.textContent).find((t) => t.startsWith('probe '))",
              );
              assert.equal(line, expected);
            };
            const local = `${base}local/`;
            await open("first one.swf", `probe ${local}first%20one.swf remote, before: none`);
            await open("second.swf", `probe ${local}second.swf remote, before: none`);
            await open(
              "first one.swf",
              `probe ${local}first%20one.swf remote, before: first%20one.swf`,
            );
          },
        ],
        [
          "a URL loads, one the browser may not fetch or a data: one says why, a link asks first",
          async () => {
            await value(
              `(() => { document.getElementById('url').value = ${JSON.stringify(`${base}demos/crowd.swf`)}; document.getElementById('url-form').requestSubmit(); })()`,
            );
            await until(playing("crowd.swf"));
            assert.match(await value<string>("location.search"), /^\?swf=http/);
            await value(
              "(() => { document.getElementById('url').value = 'http://127.0.0.1:9/movie.swf'; document.getElementById('url-form').requestSubmit(); })()",
            );
            await until("document.getElementById('status').textContent.includes('CORS')");
            // A shared link plays a SWF from a server, never one in the link itself.
            await navigate(
              `play/?swf=${encodeURIComponent("data:application/x-shockwave-flash;base64,RldT")}`,
            );
            await until("document.getElementById('status').textContent.startsWith('Only http')");

            // A link to any other SWF waits for the one who followed it to say play.
            await navigate(`play/?swf=${encodeURIComponent(`${base}demos/crowd.swf`)}`);
            await until("!document.getElementById('ask').hidden");
            assert.equal(
              await value<string>("document.getElementById('ask-file').textContent"),
              "crowd.swf",
            );
            assert.equal(
              await value<string>("document.getElementById('ask-host').textContent"),
              new URL(base).host,
            );
            await new Promise((done) => setTimeout(done, 500));
            assert.ok(await value<boolean>("document.getElementById('player').hidden"));
            assert.doesNotMatch(
              await value<string>("document.getElementById('log').innerText"),
              /Loading/,
            );
            await value("document.getElementById('ask-play').click()");
            await until(playing("crowd.swf"));
            assert.ok(await value<boolean>("document.getElementById('ask').hidden"));
          },
        ],
        ...stage3DChecks({ value, send, until, navigate, out, site }),
        ...fullscreenChecks({ value, send, until, navigate, out }),
        [
          "the file picker filters SWFs, but on iOS takes any file, where a filter greys SWFs out",
          async () => {
            await navigate("play/");
            assert.equal(
              await value<string>("document.getElementById('file').accept"),
              ".swf,.air,.zip,application/x-shockwave-flash",
            );

            const own = await value<string>("navigator.userAgent");
            const platform = await value<string>("navigator.platform");
            try {
              await send("Emulation.setUserAgentOverride", {
                userAgent:
                  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
                platform: "iPhone",
              });
              await navigate("play/");
              assert.equal(await value<string>("document.getElementById('file').accept"), "");
            } finally {
              await send("Emulation.setUserAgentOverride", { userAgent: own, platform });
              await navigate("play/");
              assert.equal(await value<string>("navigator.platform"), platform);
            }
          },
        ],
        [
          "the licences are there",
          async () => {
            const found = await value<number[]>(
              `Promise.all(['notices/', 'licenses/MPL-2.0.txt', 'licenses/ruffle-MIT.txt', 'licenses/libtess2-SGI.txt', 'licenses/jxrlib-BSD-2-Clause.txt', 'player/swf2es.js', 'player/worker.js'].map((u) => fetch(${JSON.stringify(base)} + u).then((r) => r.status)))`,
            );
            assert.deepEqual(found, [200, 200, 200, 200, 200, 200, 200]);
            const notices = await value<string>(`fetch("${base}notices/").then((r) => r.text())`);
            assert.match(notices, /Mozilla Public License/);
            assert.match(notices, /packages\/runtime\/src\/avm2\/numbers\.ts/);
            assert.match(notices, /packages\/runtime\/src\/avm2\/builtin-library\.ts/);
            // The MPL's source form at the very commit.
            assert.match(notices, /github\.com\/swf2es\/avmplus\/tree\/[0-9a-f]{40}/);
            assert.match(notices, /licenses\/libtess2-SGI\.txt/);
            assert.match(notices, /licenses\/jxrlib-BSD-2-Clause\.txt/);
            assert.doesNotMatch(notices, /\{\{/);
          },
        ],
        [
          "the home page sends the player's old links to it, and notices.html to the licences",
          async () => {
            await redirected("index.html?swf=demos%2Fbounce.swf", "/swf2es/play/");
            assert.equal(await value<string>("location.search"), "?swf=demos%2Fbounce.swf");
            await until(playing("bounce.swf"));

            // The licences' old page sends its links on too.
            await redirected("notices.html", "/swf2es/notices/");
            assert.match(
              await value<string>("document.querySelector('h1').textContent"),
              /Licences/,
            );
          },
        ],
        [
          "the compatibility page shows its figures, and its links to the repository's files are there",
          async () => {
            // A page without the player: navigate() would wait for its element.
            await send("Page.navigate", { url: `${base}compatibility/` });
            await until(
              "location.pathname.endsWith('/compatibility/') && document.readyState === 'complete'",
            );
            const page = await value<{ figures: string[]; packages: number; files: string[] }>(
              `({
                figures: [...document.querySelectorAll(".stat .figure")].map((e) => e.textContent.trim()),
                packages: document.querySelectorAll(".packages details").length,
                files: [...document.querySelectorAll("main a[href^='https://github.com/swf2es/swf2es/blob/']")]
                  .map((a) => a.getAttribute("href").replace(/^https:[/][/]github.com[/]swf2es[/]swf2es[/]blob[/][^/]+[/]/, "")),
              })`,
            );
            assert.equal(page.figures.length, 3);
            for (const figure of page.figures) {
              assert.match(figure, /^\d+(\.\d)?%$/);
              assert.ok(Number.parseFloat(figure) > 0, `${figure} is no figure`);
            }

            assert.ok(page.packages > 20, `${page.packages} packages`);
            assert.ok(page.files.length > 0);
            for (const file of page.files) {
              assert.ok(
                existsSync(`${root}${file.split("#")[0]}`),
                `${file} is not in the repository`,
              );
            }
          },
        ],
        [
          "the guide's pages are there, and every link within the site leads somewhere",
          async () => {
            const crawled = await value<{ pages: [string, string][]; broken: string[] }>(
              `(${crawl})(${JSON.stringify(base)})`,
            );
            assert.deepEqual(crawled.broken, []);
            const titles = new Map(crawled.pages);
            const guide = readGuide(root, "/swf2es/", "");
            for (const page of guide) {
              assert.equal(titles.get(`/swf2es/${page.id}/`), page.title, `${page.id} is missing`);
            }

            const first = `/swf2es/${guide[0].id}/`;
            for (const path of [
              "/swf2es/",
              "/swf2es/play/",
              "/swf2es/notices/",
              first,
              "/swf2es/compatibility/",
            ]) {
              assert.ok(titles.has(path), `${path} is not linked from the site`);
            }

            // docs/, where the guide's old links lead, sends them on to its first page.
            if (guide[0].id !== "docs") {
              const docs = await value<string>(
                `fetch(${JSON.stringify(`${base}docs/`)}).then((r) => r.text())`,
              );
              assert.match(docs, new RegExp(`http-equiv="refresh" content="0;url=${first}"`));
            }
          },
        ],
      ];

      let failed = 0;
      for (const [name, run] of checks) {
        try {
          await run();
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
      // As GitHub Pages serves it: with no headers that isolate it.
      page: "swf2es/play/",
      mounts,
      isolated: false,
      // A key's smooth scroll is an animation the compositor runs, and on a busy machine it can
      // end having moved nothing: the page fires scrollend and stays where it was, which made
      // the check that ArrowDown on a link scrolls the page fail now and then. Without it,
      // the key scrolls the page before Chrome acknowledges it.
      args: ["--disable-smooth-scrolling"],
    },
  );

  if (failures > 0) {
    console.log(`${failures} site checks failed`);
    process.exitCode = 1;
  }
}
