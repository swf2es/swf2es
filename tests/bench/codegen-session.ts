// Codegen's memory over a long session of loads, as busy real content
// plays one for hours, many SWFs loaded again and again: a main SWF of a
// large ABC that, over LOADS loads, loads item SWFs into its own
// application domain, most of them ones it has loaded before, and some
// into a shared child domain, and maps, each into a child domain of its
// own with an asset loaded into it after, and unloaded when the next
// comes, all played by the player in node (Scripting, a Player and its
// Loaders). Each new SWF is a class of its own, made from a few templates
// compiled by ASC in the oracle's image, so that it adds an ABC the
// compiler has not seen. Prints, a window of loads at a time, the size of
// codegen's memory, that of the instance compiling, what its live and dead ABCs
// weigh (Codegen.usage), and which of codegen.wasm's exports grew its
// memory and by how much.
//
//   node --expose-gc tests/bench/codegen-session.ts [--loads N] [--seed N] [--window N]
//     [--main-methods N] [--checkout DIR] [--cache] [--json FILE] [--grows]
//
// --main-methods sizes the main SWF's class, 3000 methods by default, its
// ABC some 600 KB; --checkout plays on another built checkout's player,
// codegen and libraries, to compare two; --cache gives the player a
// module cache in memory, so that each load is keyed (moduleKey) as with
// the web element's cache on; --grows prints each call that grew memory.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const LOADS = Number(option("loads") ?? 300);
const SEED = Number(option("seed") ?? 1);
const WINDOW = Number(option("window") ?? 25);
const checkout = (option("checkout") ?? `${here}../..`).replace(/\/$/, "");
const cached = args.includes("--cache");
const printGrows = args.includes("--grows");
const json = option("json");
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  throw new Error("run with node --expose-gc, so that dropped domains are collected");
}

// Every export that grows codegen's memory, by name, as calls into it.
interface Grow {
  load: number;
  call: string;
  from: number;
  to: number;
}
const grows: Grow[] = [];
let load = 0;
/** Rebuilds of the compiler's domain, and of them those done in a new instance. */
const rebuilds = { done: 0, moved: 0 };
const instantiate = WebAssembly.instantiate;
/** The exports of the codegen.wasm instance called last, the one compiling, for domainState. */
let raw: { domainState(d: number): number } | null = null;
/** How many application domains the compiler has live, evicted and dropped. */
const states = () => {
  const counts = [0, 0, 0];
  for (let d = 0; raw && raw.domainState(d) >= 0; d++) {
    counts[raw.domainState(d)]++;
  }

  return counts.join("/");
};
WebAssembly.instantiate = (async (module: WebAssembly.Module, imports?: object) => {
  const instance = (await instantiate(module, imports as never)) as unknown as WebAssembly.Instance;
  const memory = instance.exports.memory as WebAssembly.Memory | undefined;
  if (!memory) {
    return instance;
  }

  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    wrapped[name] =
      typeof value !== "function"
        ? value
        : (...a: unknown[]) => {
            raw = wrapped as typeof raw;
            const from = memory.buffer.byteLength;
            const result = (value as (...a: unknown[]) => unknown)(...a);
            const to = memory.buffer.byteLength;
            if (name === "domainRebuildStep" && result === 1) {
              rebuilds.done++;
            } else if (name === "domainLoadRebuild" && result) {
              rebuilds.moved++;
            }

            if (to > from) {
              grows.push({ load, call: name, from, to });
            }

            return result;
          };
  }

  return { exports: wrapped } as unknown as WebAssembly.Instance;
}) as typeof WebAssembly.instantiate;

const { createCodegen } = await import(
  pathToFileURL(`${checkout}/packages/codegen/dist/index.js`).href
);
const { Player } = await import(pathToFileURL(`${checkout}/packages/player/dist/player.js`).href);
const { Scripting } = await import(
  pathToFileURL(`${checkout}/packages/player/dist/scripting.js`).href
);
const { libraryAbcs } = await import(pathToFileURL(`${checkout}/tests/player/libraries.ts`).href);

/** Deterministic: the same seed plays the same session. */
let state = SEED >>> 0 || 1;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x100000000;
};

/**
 * An item's or a map's class: `methods` methods of the kind real content
 * has, which its constructor calls a few of, and a helper class of its
 * own. Named by a placeholder of fixed length, which each SWF made from
 * it renames to its own.
 */
function template(name: string, methods: number): string {
  const bodies = Array.from(
    { length: methods },
    (_, i) => `
    public function m${i}(x:Number, label:String = null):Number {
      var parts:Array = [label || "${name}", ${i}, x, helper.value];
      var sum:Number = 0;
      for (var k:int = 0; k < parts.length; k++) {
        sum += String(parts[k]).length * (k + ${i});
      }
      if (sum > ${i * 7}) {
        helper.add(sum, "m${i}");
      } else {
        helper.value = Math.max(helper.value, x) + ${i};
      }
      return sum > ${i * 3} ? sum - x : sum + helper.value;
    }`,
  ).join("\n");
  const calls = Array.from(
    { length: Math.min(methods, 8) },
    (_, i) => `total += m${i}(total, "${name}");`,
  ).join("\n      ");
  return `package {
  import flash.display.MovieClip;
  import flash.events.Event;
  public class ${name} extends MovieClip {
    public var total:Number = 0;
    private var helper:${name}Helper = new ${name}Helper();
    public function ${name}() {
      ${calls}
      addEventListener(Event.ADDED_TO_STAGE, function(e:Event):void {
        addEventListener(Event.ENTER_FRAME, frame);
      });
      addEventListener(Event.REMOVED_FROM_STAGE, function(e:Event):void {
        removeEventListener(Event.ENTER_FRAME, frame);
      });
    }
    private function frame(e:Event):void {
      total = m0(total);
    }
${bodies}
  }
}
class ${name}Helper {
  public var value:Number = 0;
  private var entries:Object = {};
  public function add(sum:Number, key:String):void {
    entries[key] = (entries[key] || 0) + sum;
    value += sum / 10;
  }
}
`;
}

/** The templates, by placeholder: small and larger items, and maps. */
const templates: [string, number][] = [
  ["SesA000", 10],
  ["SesB000", 40],
  ["SesC000", 120],
  ["SesD000", 400],
];
const MAIN_METHODS = Number(option("main-methods") ?? 3000);
const main = template("SesMain", MAIN_METHODS);
const mainLoader = readFileSync(`${here}codegen-session/SesLoads.as`, "utf8");
const out = `${here}out/codegen-session`;
const abcs = compileScripts(
  [
    ...templates.map(([name, methods]) => ({ name, source: template(name, methods) })),
    { name: "SesMain", source: main },
    { name: "SesLoads", source: mainLoader },
  ],
  out,
);

/** `abc` with each occurrence of `from` replaced by `to`, of the same length: its classes renamed. */
function renamed(abc: Uint8Array, from: string, to: string): Uint8Array {
  const a = Buffer.from(from, "latin1");
  const b = Buffer.from(to, "latin1");
  const copy = Buffer.from(abc);
  for (let at = copy.indexOf(a); at >= 0; at = copy.indexOf(a, at + a.length)) {
    b.copy(copy, at);
  }

  return new Uint8Array(copy);
}

const oneFrame = (tags: Uint8Array[]) =>
  w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [w.fileAttributes(true), ...tags, w.showFrame(), w.end()],
  });

// The plan: each load's domain (c the main SWF's, s the shared child, n a
// child of its own), its file and its class; a map's then the file and
// class of an asset it loads into its own domain once it is loaded. Two
// loads in three are of an item loaded before, into where it went first.
const files = new Map<string, Uint8Array>();
let made = 0;
const swfOf = (placeholder: string) => {
  const name = `${placeholder.slice(0, 4)}${(made++).toString(36).padStart(3, "0")}`;
  const file = `${name}.swf`;
  files.set(
    file,
    oneFrame([w.doAbc(renamed(abcs.get(placeholder) as Uint8Array, placeholder, name), name)]),
  );
  return `${file}:${name}`;
};
const plan: string[] = [];
const loaded: string[] = [];
for (let n = 0; n < LOADS; n++) {
  const r = random();
  if (loaded.length && r < 0.66) {
    plan.push(loaded[Math.floor(random() * loaded.length)]);
    continue;
  }

  if (r < 0.72) {
    plan.push(`n:${swfOf(templates[3][0])}:${swfOf(templates[1][0])}`);
    continue;
  }

  const step = `${r < 0.78 ? "s" : "c"}:${swfOf(templates[Math.floor(random() * 3)][0])}`;
  plan.push(step);
  loaded.push(step);
}

const mainSwf = oneFrame([
  w.doAbc(abcs.get("SesMain") as Uint8Array, "SesMain"),
  w.doAbc(abcs.get("SesLoads") as Uint8Array, "SesLoads"),
  w.symbolClass([[0, "SesLoads"]]),
]);

const wasm = await WebAssembly.compile(
  readFileSync(`${checkout}/packages/codegen/dist/codegen.wasm`),
);
const codegen = await createCodegen(wasm);
// How long the player's compactions block it: each call of compact or
// compactStep (a checkout from before compactStep has only compact).
const blocks: number[] = [];
for (const name of ["compact", "compactStep"]) {
  const method = codegen[name];
  if (typeof method === "function") {
    codegen[name] = (...a: unknown[]) => {
      const t0 = performance.now();
      const result = method(...a);
      blocks.push(performance.now() - t0);
      return result;
    };
  }
}
const store = new Map<string, unknown>();
let lines = 0;
const errors: string[] = [];
const scripting = new Scripting(codegen, {
  print: (line: string) => {
    if (line.startsWith("loaded ")) {
      lines++;
    } else if (line.startsWith("error")) {
      errors.push(line);
    }
  },
  url: `http://session.test/main.swf?plan=${encodeURIComponent(plan.join(","))}`,
  fetch: async ({ url }: { url: string }) => {
    const bytes = files.get(url.slice(url.lastIndexOf("/") + 1));
    return bytes
      ? { bytes, status: 200, headers: [] }
      : { bytes: new Uint8Array(0), status: 404, headers: [] };
  },
  ...(cached
    ? {
        moduleCache: {
          get: async (key: string) => store.get(key),
          put: async (key: string, entry: unknown) => {
            store.set(key, entry);
          },
          delete: async (key: string) => {
            store.delete(key);
          },
        },
      }
    : {}),
});
await scripting.loadLibraries(libraryAbcs(`${checkout}/tests/player/out/libraries/`));
const afterLibraries = codegen.memoryBytes();
const player = new Player(mainSwf, scripting);
await player.start();
const afterMain = codegen.memoryBytes();

interface Row {
  loads: number;
  memory: number;
  live: number;
  dead: number;
  heap: number;
  ms: number;
  domains: string;
}
const rows: Row[] = [];
const started = performance.now();
const settle = async () => {
  await scripting.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
for (let frames = 0; lines < LOADS && frames < LOADS * 40 && !errors.length; frames++) {
  load = lines;
  player.tick();
  await settle();
  if (frames % 8 === 0) {
    // Lets the runtime's dropped domains go, and the compiler drop them.
    gc();
    await settle();
  }

  if (lines > 0 && lines % WINDOW === 0 && rows.at(-1)?.loads !== lines) {
    gc();
    await settle();
    const usage = codegen.usage();
    rows.push({
      loads: lines,
      memory: usage.memory,
      live: usage.live,
      dead: usage.dead,
      heap: process.memoryUsage().heapUsed,
      ms: performance.now() - started,
      domains: states(),
    });
  }
}

player.destroy();
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
console.log(
  `${checkout}: ${lines} loads of ${files.size} SWFs (seed ${SEED}${cached ? ", cached" : ""}); ` +
    `codegen ${mb(afterLibraries)} MB after the libraries, ${mb(afterMain)} after the main SWF`,
);
if (errors.length) {
  console.log(errors.slice(0, 5).join("\n"));
}

console.log(
  "  loads   memory MB   live MB   dead MB   JS heap MB   s   domains live/evicted/dropped",
);
for (const r of rows) {
  console.log(
    `  ${String(r.loads).padStart(5)} ${mb(r.memory).padStart(11)} ${mb(r.live).padStart(9)} ` +
      `${mb(r.dead).padStart(9)} ${mb(r.heap).padStart(12)} ${(r.ms / 1000).toFixed(1).padStart(5)}   ${r.domains}`,
  );
}

const byCall = new Map<string, { count: number; bytes: number }>();
for (const g of grows) {
  const entry = byCall.get(g.call) ?? { count: 0, bytes: 0 };
  entry.count++;
  entry.bytes += g.to - g.from;
  byCall.set(g.call, entry);
}

console.log(`  rebuilds: ${rebuilds.done}, ${rebuilds.moved} of them in a new instance`);
blocks.sort((a, b) => b - a);
console.log(
  `  compaction calls: ${blocks.length}, ${blocks.reduce((a, b) => a + b, 0).toFixed(0)} ms in all, ` +
    `longest ${blocks
      .slice(0, 3)
      .map((ms) => ms.toFixed(1))
      .join(", ")} ms` +
    (codegen.usage().moves ? `; moves ${JSON.stringify(codegen.usage().moves)}` : ""),
);
console.log("  grown by:");
for (const [call, { count, bytes }] of [...byCall].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`    ${call}: ${count} times, ${mb(bytes)} MB`);
}

if (printGrows) {
  for (const g of grows) {
    console.log(`    load ${g.load}: ${g.call} ${mb(g.from)} → ${mb(g.to)} MB`);
  }
}

if (json) {
  writeFileSync(json, JSON.stringify({ checkout, seed: SEED, cached, rows, grows }));
}

process.exit(errors.length || lines < LOADS ? 1 : 0);
