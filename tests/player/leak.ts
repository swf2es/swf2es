// Loads SWFs over and over in one page of headless Chrome and checks that
// the code compiled for those let go of is collected: the JS heap after a
// full collection must not keep growing with the loads.
//
// - loader: one player whose main SWF loads a child SWF with a Loader,
//   unloads it and loads the next, KINDS different children in turn;
// - same: the same, the one child every time;
// - fresh: each child played whole in a player of its own, in turn, as
//   the corpus's runner plays its tests in one document;
// - avm1: the same with AVM1 SWFs, each of frames of DoAction blocks; nor
//   may the WebAssembly memories the page holds, codegen's, grow with them;
// - avm1movie: loader's, AVM1 movies in its Loader, each kept a few frames
//   with what an AVM1 movie leaves running, Key, Mouse and Stage
//   listeners, a LocalConnection, a sound, a SharedObject, a clip it draws
//   and, one kind in three, an interval, then let go of by unload() and
//   unloadAndStop() in turn, in ENTER_FRAME or EXIT_FRAME, which must take
//   all of it. Each has an onUnload, which Flash lets a movie go by: one
//   without keeps what listens running after it is unloaded.
//
// And what an online game does with each player's gear, never unloading
// it: KINDS gear SWFs, each a symbol of a class with shapes and a bitmap
// on its timeline, a few on the stage at once, each kept some frames and
// then let go of, a load each:
//
// - dropped: each in a Loader of its own, the Loader on the stage, then
//   off it and forgotten, the Loader neither unloaded nor stopped;
// - shared: all into one application domain by a few Loaders, each
//   loading the next into itself, the domain's instance of the gear's
//   class on the stage instead, so that the same SWFs load into it over
//   and over: its first load's classes are the domain's, as in Flash, and
//   those after must go once let go of;
// - churn: each gear loaded once into that domain and kept, instances of
//   its class made and dropped every frame, each a load.
//
// And that what lives on still works once the rest is collected:
//
// - kept: a main SWF keeps a text field a child's code made in an
//   embedded font, unloads the child, and after a full collection
//   registers that font from another SWF; the field must lay its text out
//   in it as a new one does, whatever went of the child.
//
// Each child is a class of METHODS methods its constructor calls, so that
// its compiled code is tens of kilobytes, and run, not just loaded. The
// heap is measured after WARM loads and again after LOADS, and each mode
// fails if it grew by more than BOUND bytes a load in between; where one
// player loads them all, also if what codegen's live ABCs hold of its
// memory grew by more than BOUND bytes a load, or its memory grew past
// what it took after WARM loads, or 32 MiB if that was less, which wasm
// never gives back: the compiler must reuse what each load's ABC took.
//
// --snapshots DIR writes a heap snapshot at each measure,
// for DevTools' Memory panel to compare and find what keeps a load's objects.
// --cache plays with an IndexedDB module cache, which the loads share.
//
//   node tests/player/leak.ts [--loads N] [--snapshots DIR] [--cache] [mode...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Avm1Assembler } from "../avm1-assembler.ts";
import { flashAssembler, script } from "../avm1-script.ts";
import { CODEGEN_WASM } from "../compiler.ts";
import * as w from "../swf-writer.ts";
import { bare, probeFont } from "./cases.ts";
import { withSteppedPage } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compileScripts } from "./scripts.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapshots = option("snapshots");
const cached = args.includes("--cache");
const LOADS = Number(option("loads") ?? 300);
const valued = new Set(["--loads", "--snapshots"]);
const modes = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const KINDS = 20;
const METHODS = 150;
const WARM = 10;
/**
 * What a load may leave behind on average: a fifth of what a child's code
 * and objects took when its code was kept, some 300 KB.
 */
const BOUND = 64 * 1024;
/**
 * What codegen's memory may grow to over the loads without failing, if it
 * was smaller after the warm ones. Wasm memory is a high-water mark. On
 * this page, the libraries compiled a part of each module at a time and
 * the warm loads after them, it is at 16 MiB; read from a module cache
 * (--cache), the libraries are not compiled and it starts at 8. Uncached,
 * it then stays at 16 in every mode but the shared gear's, so 16 MiB is
 * the ceiling: a leak outside the domain's tables of a few tens of KB a
 * load crosses it over 300 loads. The live ABCs' weight, held to BOUND a
 * load, sees one in the tables.
 */
// Zig grows by individual pages and reached 16.4–16.9 MiB on the 300-load
// workloads. Inspect the served binary so the same check covers a physical swap.
const compiler = await WebAssembly.compile(
  readFileSync(new URL(`../../packages/codegen/dist/${CODEGEN_WASM}`, import.meta.url)),
);
const zig = WebAssembly.Module.exports(compiler).some((entry) => entry.name === "input");
const CODEGEN_CEILING = (zig ? 18 : 16) * 1024 * 1024;
/**
 * The ceiling where compactions raise the high-water mark: the shared gear
 * uncached, whose dead domains building up before a compaction take it
 * from 16 to some 20 MiB within 300 loads, a compaction moving the domain
 * to a new instance of the size its live ABCs need; and with the cache,
 * where it starts at 8. A compaction in place, before there was a new
 * instance to move to, took it to 32.
 */
const COMPACTING_CEILING = 32 * 1024 * 1024;

function child(name: string): string {
  const methods = Array.from(
    { length: METHODS },
    (_, i) => `
    public function m${i}(x:Number):Number {
      var parts:Array = ["${name}", ${i}, x];
      var sum:Number = 0;
      for (var k:int = 0; k < parts.length; k++) {
        sum += String(parts[k]).length * (k + ${i});
      }
      return sum > ${i * 7} ? sum - x : sum + x;
    }`,
  ).join("\n");
  const calls = Array.from({ length: METHODS }, (_, i) => `total += m${i}(total);`).join(
    "\n      ",
  );
  return `package {
  import flash.display.Sprite;
  public class ${name} extends Sprite {
    public var total:Number = 0;
    public function ${name}() {
      ${calls}
    }
${methods}
  }
}
`;
}

const main = readFileSync(new URL("./scripts/LeakMain.as", import.meta.url), "utf8");

const keptChild = `package {
  import flash.display.Sprite;
  import flash.text.TextField;
  import flash.text.TextFormat;
  public class LeakKeptChild extends Sprite {
    public static function field():TextField {
      var field:TextField = new TextField();
      field.embedFonts = true;
      field.defaultTextFormat = new TextFormat("Probe", 20);
      field.text = "ab";
      return field;
    }
  }
}
`;

// Traces "kept" once the child is let go, and the widths once the page
// has collected the garbage between and the font is registered.
const kept = readFileSync(new URL("./scripts/LeakKept.as", import.meta.url), "utf8");

/** A gear's class: a symbol whose constructor runs METHODS / 5 methods of its own. */
function gear(name: string): string {
  return child(name)
    .replace("flash.display.Sprite", "flash.display.MovieClip")
    .replace("extends Sprite", "extends MovieClip")
    .replace(/total \+= m(\d+)\(total\);\s*/g, (call, i) => (i % 5 === 0 ? call : ""));
}

const names = Array.from({ length: KINDS }, (_, i) => `LeakChild${i}`);
const gearNames = Array.from({ length: KINDS }, (_, i) => `LeakGear${i}`);
const abcs = compileScripts([
  "LeakGear",
  ...gearNames.map((name) => ({ name, source: gear(name) })),
  { name: "LeakMain", source: main },
  { name: "LeakKept", source: kept },
  { name: "LeakKeptChild", source: keptChild },
  {
    name: "LeakProbe",
    source: "package { import flash.text.Font; public class LeakProbe extends Font {} }",
  },
  ...names.map((name) => ({ name, source: child(name) })),
]);
libraryAbcs();
const served = `${here}out/leak/`;
mkdirSync(served, { recursive: true });
const children = names.map((name, i) => {
  const swf = bare(abcs.get(name) as Uint8Array, 1, name);
  writeFileSync(`${served}child-${i}.swf`, swf);
  return swf;
});
const oneFrame = (tags: Uint8Array[]) =>
  w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [w.fileAttributes(true), ...tags, w.showFrame(), w.end()],
  });
const mainSwf = oneFrame([
  w.doAbc(abcs.get("LeakMain") as Uint8Array, "LeakMain"),
  w.symbolClass([[0, "LeakMain"]]),
]);
const keptSwf = oneFrame([
  w.doAbc(abcs.get("LeakKept") as Uint8Array, "LeakKept"),
  w.symbolClass([[0, "LeakKept"]]),
]);
writeFileSync(
  `${served}kept-child.swf`,
  oneFrame([w.doAbc(abcs.get("LeakKeptChild") as Uint8Array, "LeakKeptChild")]),
);
writeFileSync(
  `${served}kept-font.swf`,
  oneFrame([
    probeFont(1),
    w.doAbc(abcs.get("LeakProbe") as Uint8Array, "LeakProbe"),
    w.symbolClass([[1, "LeakProbe"]]),
  ]),
);

// Gear SWFs: a 16 by 16 bitmap of the kind's own colours, a shape it
// fills and an outlined one, in the symbol of the gear's class, which the
// SWF's timeline places too.
gearNames.forEach((name, i) => {
  const argb = new Uint8Array(16 * 16 * 4);
  for (let p = 0; p < 256; p++) {
    argb.set([255, (p * 7 + i * 40) & 0xff, (p * 13) & 0xff, (p * 29 + i) & 0xff], p * 4);
  }

  const square: w.PathCommand[] = [
    { move: [0, 0] },
    { line: [600, 0] },
    { line: [600, 600] },
    { line: [0, 600] },
    { line: [0, 0] },
  ];
  writeFileSync(
    `${served}gear-${i}.swf`,
    oneFrame([
      w.tag(36, Uint8Array.from([1, 0, 5, 16, 0, 16, 0, ...deflateSync(argb)]), true),
      w.shape({
        id: 2,
        bounds: [0, 600, 0, 600],
        fills: [{ type: 0x41, bitmap: 1, matrix: { a: 37.5, d: 37.5 } }],
        paths: [{ fill1: 1, commands: square }],
      }),
      w.shape({
        id: 3,
        version: 3,
        bounds: [-20, 620, -20, 620],
        fills: [0x80000000 + i * 0x0b0d07],
        lines: [{ width: 40, color: 0xff000000 + i * 0x070b0d }],
        paths: [{ fill1: 1, line: 1, commands: square }],
      }),
      w.doAbc(abcs.get(name) as Uint8Array, name),
      w.sprite(4, 1, [
        w.place({ depth: 1, character: 2 }),
        w.place({ depth: 2, character: 3, matrix: { tx: 300, ty: 300 } }),
        w.showFrame(),
      ]),
      w.symbolClass([[4, name]]),
      w.place({ depth: 1, character: 4 }),
    ]),
  );
});
const gearSwf = oneFrame([
  w.doAbc(abcs.get("LeakGear") as Uint8Array, "LeakGear"),
  w.symbolClass([[0, "LeakGear"]]),
]);

// AVM1 SWFs of KINDS kinds, each of frames whose DoAction blocks trace.
const avm1Children = names.map((name, i) =>
  w.swf({
    version: 6 + (i % 4),
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [0, 1]
      .flatMap((frame) => [
        ...Array.from({ length: METHODS / 10 }, (_, k) =>
          w.doAction([
            ...new Avm1Assembler()
              .constantPool(name, `${frame}`)
              .push(`${name} ${frame} ${k}`, k * 0.1, k + i)
              .trace()
              .trace()
              .trace()
              .end()
              .bytes(),
          ]),
        ),
        w.showFrame(),
      ])
      .concat([w.end()]),
  }),
);

// AVM1 movies of KINDS kinds for an AS3 Loader, each starting what a movie
// leaves running, with METHODS / 5 functions of its kind to compile.
names.forEach((name, i) => {
  const functions = Array.from(
    { length: METHODS / 5 },
    (_, k) => `function f${k}(x) { return x * ${k} + "${name}".length; }`,
  ).join("\n");
  const calls = Array.from({ length: METHODS / 5 }, (_, k) => `total += f${k}(total);`).join("\n");
  const source = `${functions}
var total = 0;
${calls}
var ef = 0;
var data = [];
for (var n = 0; n < 10000; n++) { data.push({ n: n, s: "${name}" + n }); }
${i % 3 === 0 ? "setInterval(function () { ef++; }, 5);" : ""}
this.onUnload = function () { ef = 0; };
var keys = {}; keys.onKeyDown = function () { ef++; }; Key.addListener(keys);
var mouse = {}; mouse.onMouseMove = function () { ef++; }; Mouse.addListener(mouse);
var stage = {}; stage.onResize = function () { ef++; }; Stage.addListener(stage);
var lc = new LocalConnection(); lc.connect("leak${i}");
var sound = new Sound(this); sound.attachSound("tone"); sound.start(0, 100);
var so = SharedObject.getLocal("leak"); so.data.total = total;
this.createEmptyMovieClip("c", 1);
c.beginFill(0xff0000); c.moveTo(0, 0); c.lineTo(10, 0); c.lineTo(10, 10); c.endFill();
c.onEnterFrame = function () { this._x++; };
this.onEnterFrame = function () { ef++; };
stop();`;
  writeFileSync(
    `${served}avm1-movie-${i}.swf`,
    w.swf({
      version: 8,
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.defineSound(1, { rate: 0, samples: 551 }, new Uint8Array(551).fill(128)),
        w.exportAssets([[1, "tone"]]),
        w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
        w.end(),
      ],
    }),
  );
});

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
let failed = false;

await withSteppedPage(
  async (page) => {
    if (!modes.length || modes.includes("kept")) {
      let error = await page.open(keptSwf, "/leak/kept.swf", cached);
      if (!error) {
        error = (await page.step(1, 40)).error;
        await page.heap();
        error ??= (await page.step(2, 40)).error;
      }

      const [field, fresh] = (await page.trace())[1]?.split(" ").map(Number) ?? [];
      await page.close();
      const ok = !error && fresh > 0 && field === fresh;
      failed ||= !ok;
      console.log(
        `kept: ${error ?? `the kept field ${field} wide, a new one ${fresh}`}${ok ? "" : " (not the same)"}`,
      );
    }

    for (const mode of [
      "loader",
      "same",
      "fresh",
      "avm1",
      "avm1movie",
      "dropped",
      "shared",
      "churn",
    ]) {
      if (modes.length && !modes.includes(mode)) {
        continue;
      }

      // The heap after WARM loads and after LOADS, codegen's memory then
      // where one player loads them all, and when the warm loads ended.
      const heaps: number[] = [];
      const codegen: number[] = [];
      const live: number[] = [];
      const memories: number[] = [];
      let warmed = 0;
      let error: string | null = null;
      const measure = async (n: number) => {
        heaps.push(await page.heap());
        if (mode === "avm1") {
          memories.push(await page.memories());
        }

        warmed ||= performance.now();
        if (snapshots) {
          await page.snapshot(`${snapshots}/${mode}-${n}.heapsnapshot`);
        }
      };
      if (mode === "fresh" || mode === "avm1") {
        for (let n = 1; n <= LOADS && !error; n++) {
          const kind = (n - 1) % KINDS;
          error = await page.run(
            (mode === "avm1" ? avm1Children : children)[kind],
            `/leak/child-${kind}.swf`,
          );
          if (n === WARM || n === LOADS) {
            await measure(n);
          }
        }
      } else {
        error =
          mode === "loader" || mode === "same" || mode === "avm1movie"
            ? await page.open(
                mainSwf,
                mode === "avm1movie"
                  ? `/leak/main.swf?kinds=${KINDS}&prefix=avm1-movie-&keep=3&vary=1`
                  : `/leak/main.swf?kinds=${mode === "same" ? 1 : KINDS}`,
                cached,
              )
            : await page.open(gearSwf, `/leak/gear.swf?mode=${mode}&kinds=${KINDS}`, cached);
        for (const n of [WARM, LOADS]) {
          if (error) {
            break;
          }

          const stepped = await page.step(n, n * 20);
          error = stepped.error ?? (stepped.lines < n ? `only ${stepped.lines} loads` : null);
          codegen.push(stepped.codegen);
          await measure(n);
          // After the collection measure made, as what codegen keeps of a
          // domain it has not evicted goes only with the domain.
          live.push((await page.step(0, 0)).live);
        }

        await page.close();
      }

      if (error || heaps.length < 2) {
        console.log(`${mode}: ${error ?? "no measure"}`);
        failed = true;
        continue;
      }

      const loads = LOADS - WARM;
      const perLoad = (heaps[1] - heaps[0]) / loads;
      const ms = (performance.now() - warmed) / loads;
      const ok = perLoad <= BOUND;
      const liveOk = live.length < 2 || (live[1] - live[0]) / loads <= BOUND;
      const ceiling = cached || mode === "shared" ? COMPACTING_CEILING : CODEGEN_CEILING;
      const codegenOk =
        liveOk && (codegen.length < 2 || codegen[1] <= Math.max(codegen[0], ceiling));
      const memoriesOk = memories.length < 2 || memories[1] <= memories[0];
      failed ||= !ok || !codegenOk || !memoriesOk;
      console.log(
        `${mode}: heap ${mb(heaps[0])} after ${WARM} loads, ${mb(heaps[1])} after ${LOADS}, ` +
          `${(perLoad / 1024).toFixed(1)} KB a load${ok ? "" : ` (more than ${BOUND / 1024} KB)`}; ` +
          (codegen.length
            ? `codegen ${mb(codegen[0])} to ${mb(codegen[1])}, its live ABCs' ` +
              `${mb(live[0])} to ${mb(live[1])}${codegenOk ? "" : " (grew)"}; `
            : "") +
          (memories.length
            ? `wasm memories ${memories[0]} to ${memories[1]}${memoriesOk ? "" : " (grew)"}; `
            : "") +
          `${ms.toFixed(1)} ms a load`,
      );
    }
  },
  { mounts: [["/leak/", served]] },
);

process.exitCode = failed ? 1 : 0;
