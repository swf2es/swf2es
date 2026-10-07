// Loads SWFs over and over in one page of headless Chrome and checks that
// the code compiled for those let go of is collected: the JS heap after a
// full collection must not keep growing with the loads.
//
// - loader: one player whose main SWF loads a child SWF with a Loader,
//   unloads it and loads the next, KINDS different children in turn;
// - same: the same, the one child every time;
// - fresh: each child played whole in a player of its own, in turn, as
//   the corpus's runner plays its tests in one document.
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
// player loads them all, also if codegen's memory grew, which wasm never
// gives back: the compiler must reuse what each load's ABC took.
//
// --snapshots DIR writes a heap snapshot at each measure,
// for DevTools' Memory panel to compare and find what keeps a load's objects.
// --cache plays with an IndexedDB module cache, which the loads share.
//
//   node tests/player/leak.ts [--loads N] [--snapshots DIR] [--cache] [mode...]
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const main = `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.net.URLRequest;
  public class LeakMain extends Sprite {
    private var count:int = 0;
    private var loading:Boolean = false;
    public function LeakMain() {
      addEventListener(Event.ENTER_FRAME, next);
    }
    private function next(e:Event):void {
      if (loading) {
        return;
      }
      loading = true;
      var params:Object = loaderInfo.parameters;
      var kinds:int = int(params.kinds);
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        loader.unloadAndStop();
        loading = false;
        count++;
        trace("loaded " + count);
      });
      loader.load(new URLRequest("child-" + (count % kinds) + ".swf"));
    }
  }
}
`;

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
const kept = `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.net.URLRequest;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  import flash.text.Font;
  import flash.text.TextField;
  import flash.text.TextFormat;
  public class LeakKept extends Sprite {
    private var field:TextField;
    private var frames:int = 0;
    public function LeakKept() {
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        var child:Object = loader.contentLoaderInfo.applicationDomain.getDefinition("LeakKeptChild");
        field = child.field();
        addChild(field);
        loader.unloadAndStop();
        trace("kept");
        addEventListener(Event.ENTER_FRAME, register);
      });
      loader.load(new URLRequest("kept-child.swf"));
    }
    private function register(e:Event):void {
      if (++frames < 2) {
        return;
      }
      removeEventListener(Event.ENTER_FRAME, register);
      var loader:Loader = new Loader();
      loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function (e:Event):void {
        Font.registerFont(loader.contentLoaderInfo.applicationDomain.getDefinition("LeakProbe") as Class);
        field.text = "ab";
        var fresh:TextField = new TextField();
        fresh.embedFonts = true;
        fresh.defaultTextFormat = new TextFormat("Probe", 20);
        fresh.text = "ab";
        trace(field.textWidth + " " + fresh.textWidth);
      });
      loader.load(new URLRequest("kept-font.swf"), new LoaderContext(false, new ApplicationDomain()));
    }
  }
}
`;

const names = Array.from({ length: KINDS }, (_, i) => `LeakChild${i}`);
const abcs = compileScripts([
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

    for (const mode of ["loader", "same", "fresh"]) {
      if (modes.length && !modes.includes(mode)) {
        continue;
      }

      // The heap after WARM loads and after LOADS, codegen's memory then
      // where one player loads them all, and when the warm loads ended.
      const heaps: number[] = [];
      const codegen: number[] = [];
      let warmed = 0;
      let error: string | null = null;
      const measure = async (n: number) => {
        heaps.push(await page.heap());
        warmed ||= performance.now();
        if (snapshots) {
          await page.snapshot(`${snapshots}/${mode}-${n}.heapsnapshot`);
        }
      };
      if (mode === "fresh") {
        for (let n = 1; n <= LOADS && !error; n++) {
          const kind = (n - 1) % KINDS;
          error = await page.run(children[kind], `/leak/child-${kind}.swf`);
          if (n === WARM || n === LOADS) {
            await measure(n);
          }
        }
      } else {
        error = await page.open(
          mainSwf,
          `/leak/main.swf?kinds=${mode === "same" ? 1 : KINDS}`,
          cached,
        );
        for (const n of [WARM, LOADS]) {
          if (error) {
            break;
          }

          const stepped = await page.step(n, n * 20);
          error = stepped.error ?? (stepped.lines < n ? `only ${stepped.lines} loads` : null);
          codegen.push(stepped.codegen);
          await measure(n);
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
      const codegenOk = codegen.length < 2 || codegen[1] <= codegen[0];
      failed ||= !ok || !codegenOk;
      console.log(
        `${mode}: heap ${mb(heaps[0])} after ${WARM} loads, ${mb(heaps[1])} after ${LOADS}, ` +
          `${(perLoad / 1024).toFixed(1)} KB a load${ok ? "" : ` (more than ${BOUND / 1024} KB)`}; ` +
          (codegen.length
            ? `codegen ${mb(codegen[0])} to ${mb(codegen[1])}${codegenOk ? "" : " (grew)"}; `
            : "") +
          `${ms.toFixed(1)} ms a load`,
      );
    }
  },
  { mounts: [["/leak/", served]] },
);

process.exitCode = failed ? 1 : 0;
