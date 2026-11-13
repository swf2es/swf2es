// A still stage in the browser build's element, in headless Chrome: once
// nothing has been drawn for a moment the player ticks by a timer, asking
// the page for no animation frames but one now and then and making no GL
// call, its frames as far apart as before; a change is drawn in the tick
// that made it, and shows; four ticks late in a row, as a busy thread makes
// them, do not give the timers up, and most of nine do, for 5 s; and a page
// that says it is hidden gets its ticks by animation frames again, which a
// hidden page has none of. Run after `pnpm build`, which builds the bundle.
//
//   node tests/web/still.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { decodePng } from "../player/image.ts";
import { compileScripts } from "../player/scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = fileURLToPath(new URL("../../packages/swf2es/dist/", import.meta.url));
const out = `${here}out/still/`;
const site = `${out}site/`;

if (!existsSync(`${dist}swf2es.js`)) {
  throw new Error("packages/swf2es is not built: run pnpm build first");
}

const abc = compileScripts(
  [{ name: "StillTest", source: readFileSync(`${here}scripts/StillTest.as`, "utf8") }],
  out,
).get("StillTest") as Uint8Array;
mkdirSync(site, { recursive: true });
writeFileSync(`${site}still.swf`, bare(abc, 1, "StillTest", 200, 100));
// What the page asks of the browser, counted from before the bundle loads:
// animation frames, short timers and the GL calls that draw or clear, and
// their counts as each line is traced. And the times the page's thread was
// kept from its timers, as on a loaded machine, which the SWF's frames and the
// timers' count are allowed for: the timers that came half a display frame
// late or more (stalls), and the display frames they came late by (lost).
writeFileSync(
  `${site}index.html`,
  `<!doctype html>
<html>
<head><meta charset="utf-8">
<script>
  window.counts = { frames: 0, timers: 0, draws: 0, stalls: 0, lost: 0 };
  window.marks = [];
  const frame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    counts.frames++;
    return frame(callback);
  };
  const timer = window.setTimeout.bind(window);
  const kept = { ticks: 0, ms: 0 };
  window.busy = (ticks, ms) => Object.assign(kept, { ticks, ms });
  window.setTimeout = (callback, ms, ...rest) => {
    if (!(ms < 50)) {
      return timer(callback, ms, ...rest);
    }

    counts.timers++;
    const due = performance.now() + ms;
    return timer((...args) => {
      // A thread kept busy, as a loaded machine keeps it: the tick made that late.
      if (kept.ticks > 0) {
        kept.ticks--;
        const until = performance.now() + kept.ms;
        while (performance.now() < until) {}
      }
      const late = performance.now() - due;
      if (late >= 8) {
        counts.stalls++;
        counts.lost += Math.floor(late / 16);
      }
      callback(...args);
    }, ms, ...rest);
  };
  for (const name of ["clear", "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "blitFramebuffer"]) {
    const call = WebGL2RenderingContext.prototype[name];
    WebGL2RenderingContext.prototype[name] = function (...args) {
      counts.draws++;
      return call.apply(this, args);
    };
  }
  const log = console.log;
  console.log = (...args) => {
    marks.push({ line: args.join(" "), at: performance.now(), ...counts });
    log.apply(console, args);
  };
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { get: () => visibility });
  window.show = (state) => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  };
</script>
<script type="module" src="/swf2es/swf2es.js"></script>
</head>
<body style="margin: 0">
<swf2es-player src="still.swf" width="200" height="100"></swf2es-player>
</body>
</html>`,
);

interface Counts {
  frames: number;
  timers: number;
  draws: number;
  stalls: number;
  lost: number;
}
interface Mark extends Counts {
  line: string;
  at: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await withPage(
  "customElements.get('swf2es-player')",
  async (evaluate, send) => {
    const value = async <R>(expression: string): Promise<R> => {
      const { value, exception } = await evaluate<R>(expression);
      assert.equal(exception, null);
      return value as R;
    };
    const marks = async () => JSON.parse(await value<string>("JSON.stringify(marks)")) as Mark[];
    const counts = async () => JSON.parse(await value<string>("JSON.stringify(counts)")) as Counts;
    /** The mark of the line that starts with `line`, once it is traced. */
    const mark = async (line: string): Promise<Mark> => {
      for (let i = 0; i < 600; i++) {
        const found = (await marks()).find((m) => m.line.startsWith(line));
        if (found) {
          return found;
        }

        await sleep(50);
      }

      throw new Error(`"${line}" was not traced: ${JSON.stringify(await marks())}`);
    };
    /** The colour shown at a point of the page, 0xRRGGBB. */
    const shown = async (x: number, y: number): Promise<number> => {
      const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const image = decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
      const scale = image.width / (await value<number>("innerWidth"));
      const i = (Math.round(y * scale) * image.width + Math.round(x * scale)) * 4;
      return (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    };

    const begin = await mark("still begin");
    // Left alone, the canvas shows what was last drawn on it.
    assert.equal((await shown(30, 30)).toString(16), "ff0000");
    assert.equal((await shown(130, 30)).toString(16), "ffffff");
    const end = await mark("still end");
    // Two seconds still: an animation frame asked each second, not 60, and nothing drawn.
    assert.equal(end.draws - begin.draws, 0, "a still stage drew");
    assert.ok(
      end.frames - begin.frames <= 4,
      `${end.frames - begin.frames} animation frames asked in two still seconds`,
    );
    // Its ticks came by the timer at the display's interval, 60 a second here, but for those
    // a stall took.
    const stalls = end.stalls - begin.stalls;
    const lost = end.lost - begin.lost;
    const ticks = end.timers - begin.timers;
    assert.ok(
      ticks >= 110 - lost && ticks <= 130,
      `${ticks} timers set in two still seconds, ${lost} display frames lost to stalls`,
    );
    // Its 120 frames took their two seconds, none run right after another, none skipped: a
    // few of either are a busy machine's, and each stall makes one of each, a frame late and
    // the next on its time.
    const elapsed = end.at - begin.at;
    assert.ok(
      elapsed > 1950 && elapsed < 2300 + 17 * lost,
      `120 frames took ${elapsed} ms, ${lost} display frames lost to stalls`,
    );
    const [early, late] = end.line.split(" ").slice(2).map(Number);
    assert.ok(
      early <= 3 + stalls && late <= 3 + stalls,
      `${early} frames came early, ${late} late, in ${stalls} stalls`,
    );

    // The box moved in the frame that ended the still: drawn before the next frame played.
    const moved = await mark("moved");
    assert.ok(moved.draws > end.draws, "the change was not drawn in its tick");
    const again = await mark("again begin");
    assert.equal((await shown(130, 30)).toString(16), "ff0000");
    assert.equal((await shown(30, 30)).toString(16), "ffffff");
    const done = await mark("again end");
    assert.equal(done.draws - again.draws, 0, "the stage drew after the change was shown");
    assert.ok(
      done.frames - again.frames <= 3,
      `${done.frames - again.frames} animation frames asked in a second still again`,
    );

    // At the display's interval again, not at the time between the first animation frames
    // after the still, which come out of step.
    const after = done.timers - again.timers;
    const lostAfter = done.lost - again.lost;
    assert.ok(
      after >= 50 - lostAfter && after <= 70,
      `${after} timers set in a second still again, ${lostAfter} display frames lost to stalls`,
    );

    // A thread busy for four ticks in a row, each late by more than half a frame, is no
    // reason to give the timers up, as it was: most ticks come on time.
    await value("busy(4, 12)");
    await sleep(500);
    const busied = await counts();
    await sleep(1000);
    const calm = await counts();
    assert.ok(
      calm.frames - busied.frames <= 2,
      `${calm.frames - busied.frames} animation frames asked in the second after four late ticks`,
    );

    // Most of nine ticks late is timers too coarse to keep the display's interval, by which the
    // player would run frames in batches: animation frames for a while, then timers again.
    await value("busy(9, 12)");
    await sleep(500);
    const coarse = await counts();
    await sleep(1000);
    const framed = await counts();
    assert.ok(
      framed.frames - coarse.frames >= 30,
      `${framed.frames - coarse.frames} animation frames asked in a second after nine late ticks`,
    );
    await sleep(5000);
    const retried = await counts();
    await sleep(1000);
    const timed = await counts();
    assert.ok(
      timed.frames - retried.frames <= 2,
      `${timed.frames - retried.frames} animation frames asked in a second, 5 s after the timers were late`,
    );

    // A page that is hidden has no animation frames, and the player waits for them: here
    // the page only says so, and they come, each one's tick asking for the next.
    await value("show('hidden')");
    await sleep(500);
    const hidden = await counts();
    await sleep(1000);
    const later = await counts();
    assert.ok(
      later.frames - hidden.frames >= 30,
      `${later.frames - hidden.frames} animation frames asked in a second hidden`,
    );
    assert.ok(
      later.timers - hidden.timers <= 3,
      `${later.timers - hidden.timers} timers set in a second hidden`,
    );

    // Shown again it is drawn anew, and is then still as before.
    await value("show('visible')");
    await sleep(500);
    const visible = await counts();
    assert.ok(visible.draws > later.draws, "not drawn when shown again");
    await sleep(1000);
    const still = await counts();
    assert.equal(still.draws - visible.draws, 0, "the stage drew after it was shown again");
    assert.ok(
      still.frames - visible.frames <= 3,
      `${still.frames - visible.frames} animation frames asked in a second still, shown again`,
    );
  },
  false,
  {
    page: "still-test/index.html",
    mounts: [
      ["/still-test/", site],
      ["/swf2es/", dist],
    ],
  },
);
console.log("still: ok");
