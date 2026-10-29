// The demo site (apps/site) in headless Chrome, built as GitHub Pages gets
// it and served under /swf2es/ as Pages serves it, without the headers its
// service worker adds to isolate it, which it is then: a demo by ?swf= plays
// and traces, a SWF's workers share a Mutex and memory, a key's uncaught
// error reaches the console, a file opened with the picker and a URL
// load play, a URL the browser may not fetch
// says why, the report link carries the SWF's facts and the errors, and the
// licences are there. It leaves a screenshot in tests/site/out/site.png.
//
//   node tests/site/run.ts            build the site, then check it
//   node tests/site/run.ts --serve    build it and serve it to look at, until ^C
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compileScripts } from "../player/scripts.ts";
import { serve } from "../player/serve.ts";
import * as w from "../swf-writer.ts";
import { fullscreenChecks } from "./fullscreen.ts";
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

type WorkerSwf = (abc: Uint8Array) => Uint8Array;

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const site = `${root}apps/site/dist/site/`;
const out = `${here}out/`;
const mounts: [string, string][] = [["/swf2es/", site]];

execFileSync(process.execPath, [`${root}apps/site/build.ts`], { stdio: "inherit" });

if (process.argv.includes("--serve")) {
  const { url } = await serve(mounts, undefined, false);
  console.log(`the site: ${url}swf2es/index.html`);
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
        await send("Page.navigate", { url: `${base}${path}` });
        await until("document.readyState === 'complete' && !!customElements.get('swf2es-player')");
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
            const isolation = async (ms: number) => {
              const start = Date.now();
              for (let isolated = false; !isolated; ) {
                assert.ok(Date.now() - start < ms, "the page is not cross-origin isolated");
                await new Promise((done) => setTimeout(done, 100));
                // A document the page leaves while it is asked answers nothing.
                isolated = await evaluate<boolean>(
                  "crossOriginIsolated && !!navigator.serviceWorker.controller",
                ).then(
                  (r) => r.value === true,
                  () => false,
                );
              }
            };
            // As a busy machine runs it, which CI's is: the reloads' timing is what this tests.
            await send("Emulation.setCPUThrottlingRate", { rate: 6 });
            try {
              // The first visit loads the page again once the worker serves it.
              await isolation(30_000);
              // A reload that bypasses the worker, as Shift-reload does, loads it again too:
              // at once, while the isolated page still loads, and once it has loaded.
              await send("Page.reload", { ignoreCache: true });
              await isolation(20_000);
              await navigate("index.html");
              assert.equal(await value<boolean>("crossOriginIsolated"), true);
              await send("Page.reload", { ignoreCache: true });
              await isolation(20_000);
            } finally {
              await send("Emulation.setCPUThrottlingRate", { rate: 1 });
            }

            await until(
              "document.readyState === 'complete' && !!customElements.get('swf2es-player')",
            );
          },
        ],
        [
          "?swf= plays a demo, which traces and draws",
          async () => {
            await navigate("index.html?swf=demos%2Fbounce.swf");
            await until(playing("bounce.swf"));
            await until(logHas("Hello from ActionScript 3"));
            assert.equal(
              await value<boolean>("globalThis.nativeFillInstances > 0"),
              true,
              "playback did not use the native tessellator",
            );
            // Native bitmap kernels are on by default too. The page loads more modules
            // than resource timing keeps, so the frame's resources tell.
            const { frameTree } = await send<{ frameTree: { resources: { url: string }[] } }>(
              "Page.getResourceTree",
            );
            assert.ok(
              frameTree.resources.some((r) => r.url.endsWith("/modules/native/render/index.js")),
              "playback did not load the native bitmap kernels",
            );
            const facts = await value<string>("document.getElementById('facts').innerText");
            assert.match(facts, /3 \(AVM2\)/);
            assert.match(facts, /480 × 320/);
            const demos = await value<number>("document.querySelectorAll('#demos li').length");
            assert.equal(demos, 3);
            const source = await value<string>("document.querySelector('#demos a').href");
            assert.match(
              source,
              /^https:\/\/github\.com\/swf2es\/swf2es\/blob\/[0-9a-f]{40}\/apps\/site\//,
            );
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

            // The stats count the renderer's draw calls while they are on screen.
            await until("Number(document.getElementById('draws').textContent) > 0");
            // Off screen, and while the context is lost, the context has its own functions back.
            const gl = "document.getElementById('player').gl";
            const wrapped = `Object.hasOwn(${gl}, 'drawElements')`;
            assert.equal(await value<boolean>(wrapped), true);
            await value("(document.querySelector('.stats').style.display = 'none', true)");
            await until(`!${wrapped}`);
            await value("(document.querySelector('.stats').style.display = '', true)");
            await until(wrapped);
            await value(
              `((globalThis.lose = ${gl}.getExtension('WEBGL_lose_context')).loseContext(), true)`,
            );
            await until(`!${wrapped}`);
            await value("(lose.restoreContext(), true)");
            await until(wrapped);
            await value("(document.getElementById('draws').textContent = '', true)");
            await until("Number(document.getElementById('draws').textContent) > 0");

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
            const build = await value<string>("document.documentElement.dataset.build");
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
              await until("scrollY > 300", 5000);
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
              `index.html?swf=${encodeURIComponent("data:application/x-shockwave-flash;base64,RldT")}`,
            );
            await until("document.getElementById('status').textContent.startsWith('Only http')");

            // A link to any other SWF waits for the one who followed it to say play.
            await navigate(`index.html?swf=${encodeURIComponent(`${base}demos/crowd.swf`)}`);
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
          "the licences are there",
          async () => {
            const found = await value<number[]>(
              "Promise.all(['notices.html', 'licenses/MPL-2.0.txt', 'licenses/ruffle-MIT.txt', 'licenses/libtess2-SGI.txt', 'modules/native/render/index.js', 'modules/native/render/index.js', 'libraries/builtin.abc'].map((u) => fetch(u).then((r) => r.status)))",
            );
            assert.deepEqual(found, [200, 200, 200, 200, 200, 200, 200]);
            const notices = await value<string>("fetch('notices.html').then((r) => r.text())");
            assert.match(notices, /Mozilla Public License/);
            assert.match(notices, /packages\/runtime\/src\/avm2\/numbers\.ts/);
            // The MPL's source form at the very commit.
            assert.match(notices, /github\.com\/swf2es\/avmplus\/tree\/[0-9a-f]{40}/);
            assert.match(notices, /licenses\/libtess2-SGI\.txt/);
            assert.doesNotMatch(notices, /\{\{/);
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
    // As GitHub Pages serves it: with no headers that isolate it.
    { page: "swf2es/index.html", mounts, isolated: false },
  );

  if (failures > 0) {
    console.log(`${failures} site checks failed`);
    process.exitCode = 1;
  }
}
