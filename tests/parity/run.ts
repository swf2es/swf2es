// The parity harness (docs/zig-codegen.md, section 5): the compiler in
// AssemblyScript, the oracle until it is deleted, and the compiler in Zig
// fed the same calls, their results compared byte for byte; and Zig's
// poison build, which fills freed memory with 0xAA, against Zig's own,
// which differ only where output reads memory nothing wrote. A suite runs
// on the release builds, or on the test builds for the dumps each stage
// ports. Each names the exports it calls: one that calls an export Zig's
// does not have yet is reported as not ported, and skipped. A case that
// throws is recorded as its result, so one failure stops nothing.
//
// expected.json lists the suites that must be the same: one that differs,
// or is no longer ported, fails, and so does one the same but not listed. Each compiler's results go to out/, and
// where a case's large result (a module) differs, both, with the first
// line they differ at.
//
//   node tests/parity/run.ts [suite...]
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIR_API_VERSION, API_VERSION } from "@swf2es/codegen";
import { airLibrary, builtinLibrary, playerglobalLibrary } from "@swf2es/player/libraries";
import { instantiate as instantiateAs } from "../../packages/codegen/dist/codegen.js";
import {
  type CodegenExports,
  instantiate as instantiateZig,
  SIGNATURES,
} from "../../packages/codegen/dist/zig.js";
import { isAs3, readActions, readDoAbc, readSwf } from "../../packages/format/dist/index.js";
import { type Avm1Swf, avm1Swfs, testBlocks } from "../conformance/determinism-avm1.ts";
import { bindTesting, zigTestingModule } from "../unit/codegen/zig-testing.ts";
import { richAbc } from "./rich-abc.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("out/", import.meta.url));
const expected: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("expected.json", import.meta.url)), "utf8"),
);

/**
 * A suite's results: a line a case, large results by their digests. The
 * bytes of a large result are kept only for the cases named in `capture`,
 * which a second run asks for where the digests differ, so that a suite
 * of a corpus does not hold every module of three compilers.
 */
class Results {
  readonly lines: string[] = [];
  /** Each line's case name, which a large result's bytes are kept by. */
  readonly names: string[] = [];
  readonly blobs = new Map<string, Uint8Array>();

  readonly capture: ReadonlySet<string>;
  /** Which compiler's: as, zig or poison. */
  readonly compiler: string;

  constructor(compiler: string, capture: ReadonlySet<string> = new Set()) {
    this.compiler = compiler;
    this.capture = capture;
  }

  /** Case `name`'s result, or what it threw. */
  case(name: string, run: () => string | number | boolean): void {
    this.names.push(name);
    try {
      this.lines.push(`${name}: ${run()}`);
    } catch (error) {
      const e = error as Error;
      this.lines.push(`${name}: threw ${e?.name}: ${e?.message}`);
    }
  }

  /** A large result, as its length and digest; its bytes too where they are asked for. */
  blob(name: string, bytes: Uint8Array): string {
    if (this.capture.has(name)) {
      this.blobs.set(name, bytes.slice());
    }

    return `${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`;
  }
}

/** asc's glue for either build; the test build's exports beyond are reached by name. */
// biome-ignore lint/suspicious/noExplicitAny: the test builds' exports are untyped, as asc's bindings
type Compiler = CodegenExports & Record<string, any>;

interface Suite {
  name: string;
  /** The release builds, or the test builds with their dumps. */
  build: "release" | "testing";
  /** The exports it calls. */
  needs: string[];
  run(compiler: Compiler, results: Results): void;
}

/** The ABCs there are without the oracle: the libraries the player ships, and the tests' own. */
function abcs(): [string, Uint8Array][] {
  const found: [string, Uint8Array][] = [
    ["builtin", builtinLibrary],
    ["playerglobal", playerglobalLibrary],
    ["air", airLibrary],
  ];
  for (const dir of ["tests/player/fixtures", "tests/unit/codegen/fixtures"]) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".abc"))) {
      found.push([`${dir}/${file}`, new Uint8Array(readFileSync(join(root, dir, file)))]);
    }
  }

  return found;
}

/** Byte strings no ABC starts with: every length to five, and seeded random ones. */
function odd(): [string, Uint8Array][] {
  const found: [string, Uint8Array][] = [];
  for (let length = 0; length <= 5; length++) {
    found.push([`length ${length}`, Uint8Array.of(16, 0, 46, 0, 1).subarray(0, length)]);
  }

  let state = 1;
  for (let i = 0; i < 1000; i++) {
    const bytes = new Uint8Array(4);
    for (let k = 0; k < 4; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[k] = state & 0xff;
    }

    found.push([`random ${i}`, bytes]);
  }

  return found;
}

/** What a call handed out. */
const handed = (c: Compiler, address: number) =>
  new Uint8Array(c.memory.buffer, address >>> 0, c.outputLength());

/** The libraries added as the player adds them, each one's module, source map and entries. */
function libraries(c: Compiler, r: Results, version: number, list: [string, Uint8Array][]): void {
  r.case(`reset ${version}`, () => {
    c.domainReset(version);
    return "done";
  });
  for (const [name, abc] of list) {
    r.case(`add ${name} at ${version}`, () => c.domainAdd(abc, true, 0));
  }

  for (const [index, [name]] of list.entries()) {
    r.case(`module ${name} at ${version}`, () => {
      const parts = [handed(c, c.domainModuleBytes("", index, true, false))];
      while (!c.domainModuleDone()) {
        parts[parts.length - 1] = parts[parts.length - 1].slice();
        c.__collect();
        parts.push(handed(c, c.domainModuleMoreBytes()));
      }

      return r.blob(`module ${name} at ${version}`, Buffer.concat(parts));
    });
    r.case(`source map ${name} at ${version}`, () =>
      r.blob(`source map ${name} at ${version}`, Buffer.from(c.domainSourceMap())),
    );
    r.case(`entries ${name} at ${version}`, () =>
      r.blob(`entries ${name} at ${version}`, Buffer.from(c.domainModuleEntries())),
    );
    c.__collect();
  }
}

const AVM1_EXPORTS = [
  "actionsModuleBytes",
  "actionsModuleEntries",
  "actionsModuleUnits",
  "actionsEmitEachBytes",
  "actionsUnitBytes",
  "actionsUnitLimits",
  "actionsHold",
  "actionsHeldEmitEachBytes",
  "actionsHeldUnitBytes",
  "actionsHeldCount",
  "actionsRelease",
];

/**
 * Everything the AVM1 compiler gives for a SWF: its module kept, its
 * entries and units, every block alone (one emitter and one each), every
 * unit alone with its limits, and the same from the SWF held.
 */
function avm1(c: Compiler, r: Results, swf: Avm1Swf): void {
  const { name, bytes, offsets, lengths, version } = swf;
  // AssemblyScript's runtime collects only when asked, as the wrapper asks
  // after its calls: unasked, a corpus's garbage takes its memory past
  // 2 GiB, where asc's glue cannot take a pointer back.
  c.__collect();
  const all = Array.from(offsets, (_, k) => k).join(",");
  r.case(`${name}: module`, () =>
    r.blob(
      `${name}: module`,
      handed(c, c.actionsModuleBytes(bytes, offsets, lengths, version, true)),
    ),
  );
  r.case(`${name}: entries`, () =>
    r.blob(`${name}: entries`, Buffer.from(c.actionsModuleEntries())),
  );
  let units = "";
  r.case(`${name}: units`, () => {
    units = c.actionsModuleUnits();
    return r.blob(`${name}: units`, Buffer.from(units));
  });
  for (const reuse of [true, false]) {
    r.case(`${name}: each block, reuse ${reuse}`, () =>
      r.blob(
        `${name}: each block, reuse ${reuse}`,
        handed(c, c.actionsEmitEachBytes(bytes, offsets, lengths, version, all, reuse)),
      ),
    );
  }

  const keys = units
    .split("\u0002")
    .map((item) => item.split("\u0001"))
    .filter((parts) => parts.length === 4)
    .map(([key, numbers]) => [key, numbers.split(",").map(Number)] as const);
  for (const [i, [key, [at, end, bound, five]]] of keys.entries()) {
    if (i % 64 === 63) {
      c.__collect();
    }

    r.case(`${name}: unit ${key}`, () => {
      const code = r.blob(
        `${name}: unit ${key}`,
        handed(c, c.actionsUnitBytes(bytes, offsets, lengths, version, at, end, bound, five !== 0)),
      );
      // The code stays readable after the limits are read, as asc's does.
      return `${code} ${c.actionsUnitLimits().join(",")} ${c.outputLength()}`;
    });
  }

  r.case(`${name}: held`, () => {
    c.actionsHold(7, bytes, offsets, lengths);
    return c.actionsHeldCount();
  });
  r.case(`${name}: held blocks`, () =>
    r.blob(`${name}: held blocks`, handed(c, c.actionsHeldEmitEachBytes(7, version, all))),
  );
  for (const [i, [key, [at, end, bound, five]]] of keys.entries()) {
    if (i % 64 === 63) {
      c.__collect();
    }

    r.case(`${name}: held unit ${key}`, () => {
      const code = r.blob(
        `${name}: held unit ${key}`,
        handed(c, c.actionsHeldUnitBytes(7, version, at, end, bound, five !== 0)),
      );
      return `${code} ${c.actionsUnitLimits().join(",")}`;
    });
  }

  c.__collect();
  r.case(`${name}: released`, () => {
    c.actionsRelease(7);
    return `${c.actionsHeldCount()} ${c.actionsHeldUnitBytes(7, version, 0, 0, 0, false)}`;
  });
}

/** SWFs named by SWF2ES_PRIVATE, space-separated: reported only as "private", never by name. */
function privateSwfs(): Avm1Swf[] {
  return (process.env.SWF2ES_PRIVATE ?? "")
    .split(" ")
    .filter(Boolean)
    .flatMap((file, i) => {
      const swf = readSwf(new Uint8Array(readFileSync(file)));
      const { version, blocks } = readActions(swf);
      return isAs3(swf) || blocks.length === 0
        ? []
        : [
            {
              name: `private ${i}`,
              bytes: swf.bytes,
              version,
              offsets: Int32Array.from(blocks, (b) => b.offset),
              lengths: Int32Array.from(blocks, (b) => b.length),
            },
          ];
    });
}

/** A seeded xorshift: the same numbers on every host. */
function random(seed: number): { below: (n: number) => number; next: () => number } {
  let state = seed | 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return { next, below: (n) => next() % n };
}

/**
 * Random AVM1 actions, most well formed, some cut short or of lengths
 * that lie: every kind the decoder reads, jumps and Ifs back and forth,
 * functions, Withs, Trys, pools, Pushes of every type.
 */
function actions(rng: ReturnType<typeof random>, max: number): number[] {
  const { below, next } = rng;
  const out: number[] = [];
  const str = () => {
    const s: number[] = [];
    for (let i = below(5); i > 0; i--) {
      s.push(below(6) ? 97 + below(26) : below(256));
    }

    if (below(20)) {
      s.push(0);
    }

    return s;
  };
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const near = () => (below(4) ? (below(40) - 30) & 0xffff : next() & 0xffff);
  const simple = [
    0x04, 0x06, 0x07, 0x0a, 0x0b, 0x12, 0x17, 0x1c, 0x1d, 0x3c, 0x3d, 0x3e, 0x40, 0x47, 0x4e, 0x4f,
    0x52, 0x2a, 0x00, 0x26,
  ];
  for (let i = 1 + below(max); i > 0; i--) {
    let op: number;
    let body: number[] = [];
    switch (below(22)) {
      case 0:
      case 1:
      case 2:
        out.push(simple[below(simple.length)]);
        continue;
      case 3:
        out.push(below(0x80));
        continue;
      case 4:
      case 5:
        op = 0x99;
        body = u16(near());
        break;
      case 6:
      case 7:
        op = 0x9d;
        body = u16(near());
        break;
      case 8:
      case 9:
        op = 0x96;
        for (let j = below(4); j >= 0; j--) {
          const type = below(11);
          body.push(type);
          if (type === 0) {
            body.push(...str());
          } else if (type === 1 || type === 7) {
            body.push(below(256), below(256), below(256), below(256));
          } else if (type === 6) {
            for (let q = 0; q < 8; q++) {
              body.push(below(256));
            }
          } else if (type === 4 || type === 5 || type === 8) {
            body.push(below(256));
          } else if (type === 9) {
            body.push(below(256), below(256));
          }
        }
        break;
      case 10: {
        op = 0x9b;
        const params = below(3);
        body = [...str(), ...u16(params)];
        for (let j = 0; j < params; j++) {
          body.push(...str());
        }
        body.push(...u16(below(12)));
        break;
      }
      case 11: {
        op = 0x8e;
        const params = below(3);
        body = [...str(), ...u16(params), below(6), ...u16(next() & 0xffff)];
        for (let j = 0; j < params; j++) {
          body.push(below(6), ...str());
        }
        body.push(...u16(below(12)));
        break;
      }
      case 12:
        op = 0x94;
        body = u16(below(10));
        break;
      case 13: {
        op = 0x8f;
        const flags = below(8);
        body = [flags, ...u16(below(8)), ...u16(below(8)), ...u16(below(8))];
        body.push(...(flags & 4 ? [below(6)] : str()));
        break;
      }
      case 14:
        op = 0x8a;
        body = [...u16(below(4)), below(5)];
        break;
      case 15:
        op = 0x8d;
        body = [below(5)];
        break;
      case 16: {
        op = 0x88;
        const count = below(4);
        body = u16(count + below(2));
        for (let j = 0; j < count; j++) {
          body.push(...str());
        }
        break;
      }
      case 17:
        op = 0x87;
        body = [below(8)];
        break;
      case 18:
        op = [0x81, 0x83, 0x8b, 0x8c, 0x9a, 0x9f][below(6)];
        body =
          op === 0x83
            ? [...str(), ...str()]
            : op === 0x81
              ? u16(below(9))
              : op === 0x9a
                ? [below(256)]
                : op === 0x9f
                  ? [below(4), ...u16(below(5))]
                  : str();
        break;
      default:
        op = 0x80 + below(0x80);
        for (let j = below(6); j > 0; j--) {
          body.push(below(256));
        }
        break;
    }

    let length = body.length;
    if (!below(25)) {
      length = below(3) ? length + below(5) - 2 : next() & 0xffff;
    }

    out.push(op, ...u16(length & 0xffff), ...body);
  }

  if (below(4)) {
    out.push(0);
  }

  return out;
}

/**
 * Generated SWFs: bytes before the first block and between blocks, two or
 * three blocks, now and then a range outside the SWF or one more offset
 * than lengths, an odd SWF version; and with each, block lists with
 * repeats, garbage and indices out of range, and unit keys the module did
 * not list, some far outside the SWF. The calls of `avm1` beside: the
 * module not kept, actionsEmitEach's string.
 */
function generated(c: Compiler, r: Results, count: number): void {
  const rng = random(1);
  const { below, next } = rng;
  for (let k = 0; k < count; k++) {
    const bytes: number[] = [];
    for (let i = below(3); i > 0; i--) {
      bytes.push(below(256));
    }

    const offsets: number[] = [];
    const lengths: number[] = [];
    const blocks = 1 + below(3);
    for (let b = 0; b < blocks; b++) {
      const block = actions(rng, 12);
      offsets.push(bytes.length);
      lengths.push(block.length);
      bytes.push(...block);
      if (below(2)) {
        bytes.push(...actions(rng, 4));
      }
    }

    if (!below(10)) {
      offsets.push(below(3) ? below(bytes.length + 5) - 2 : -below(1 << 30));
      lengths.push(below(3) ? below(bytes.length + 5) - 2 : next() | 0);
    }

    if (!below(15)) {
      lengths.pop();
    }

    const swf = Uint8Array.from(bytes);
    const off = Int32Array.from(offsets);
    const len = Int32Array.from(lengths);
    const version = below(12) ? 4 + below(8) : next() | 0;
    const name = `generated ${k}`;
    r.case(`${name}: module`, () =>
      r.blob(
        `${name}: module`,
        handed(c, c.actionsModuleBytes(swf, off, len, version, below(8) !== 0)),
      ),
    );
    r.case(`${name}: entries`, () => c.actionsModuleEntries());
    let units = "";
    r.case(`${name}: units`, () => {
      units = c.actionsModuleUnits();
      return units;
    });
    const lists = [
      Array.from(off, (_, i) => i).join(","),
      "0,0",
      `${blocks - 1},0, 1,-1,x,0x1,+0,99999999999,,${below(5)},\u00a01,\u30001`,
      "",
    ];
    for (const list of lists) {
      for (const reuse of [true, false]) {
        r.case(
          `${name}: each ${list} ${reuse}`,
          () => handed(c, c.actionsEmitEachBytes(swf, off, len, version, list, reuse)).length,
        );
      }
    }

    r.case(`${name}: each as a string`, () =>
      c.actionsEmitEach(swf, off, len, version, lists[2], true),
    );
    const keys = units
      .split("\u0002")
      .map((item) => item.split("\u0001"))
      .filter((parts) => parts.length === 4)
      .map(([, numbers]) => numbers.split(",").map(Number));
    for (let i = 0; i < 4; i++) {
      const at = below(bytes.length + 4) - 2;
      const end = below(3) ? at + below(bytes.length + 3) : below(bytes.length + 9) - 3;
      keys.push([at, end, below(3) ? swf.length : end + below(6) - 1, below(2)]);
    }

    if (!below(5)) {
      keys.push(
        [next() | 0, next() | 0, next() | 0, 1],
        [0, 2147483647, 2147483647, 0],
        [-2147483648, 0, 0, 0],
      );
    }

    const handle = k & 3;
    r.case(`${name}: hold`, () => {
      c.actionsHold(handle, swf, off, len);
      return c.actionsHeldCount();
    });
    for (const [at, end, bound, five] of keys) {
      r.case(`${name}: unit ${at},${end},${bound},${five}`, () => {
        const code = handed(
          c,
          c.actionsUnitBytes(swf, off, len, version, at, end, bound, five !== 0),
        );
        return `${Buffer.from(code).toString("latin1")} ${c.actionsUnitLimits().join(",")} ${c.outputLength()}`;
      });
      r.case(`${name}: held unit ${at},${end},${bound},${five}`, () => {
        const address = c.actionsHeldUnitBytes(handle, version, at, end, bound, five !== 0);
        return address >>> 0 === 0
          ? "none"
          : `${Buffer.from(handed(c, address)).toString("latin1")} ${c.actionsUnitLimits().join(",")}`;
      });
    }

    r.case(`${name}: held blocks`, () =>
      Buffer.from(handed(c, c.actionsHeldEmitEachBytes(handle, version, lists[0]))).toString(
        "latin1",
      ),
    );
    if (!below(3)) {
      r.case(`${name}: release`, () => {
        c.actionsRelease(handle);
        c.actionsRelease(99);
        return `${c.actionsHeldCount()} ${c.actionsHeldEmitEachBytes(handle, version, "0")}`;
      });
    }

    if (k % 20 === 19) {
      c.__collect();
    }
  }
}

/** Pushes of 100 numbers each, floats and doubles of every kind, as dtoa writes them. */
function doubles(c: Compiler, r: Results, count: number): void {
  const { below, next } = random(1);
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const f32 = new Float32Array(1);
  const u8 = new Uint8Array(f32.buffer);
  for (let k = 0; k < count; k++) {
    const body: number[] = [];
    for (let j = 0; j < 100; j++) {
      const how = below(8);
      if (how === 0) {
        u8.set([below(256), below(256), below(256), below(256)]);
        body.push(1, ...u8);
        continue;
      }

      if (how === 1) {
        f64[0] = (below(2000000) - 1000000) / 10 ** below(12);
      } else if (how === 2) {
        f64[0] = (next() * 4294967296 + next()) * 10 ** (below(60) - 30);
      } else if (how === 3) {
        f64[0] = Number(`${below(1000000)}e${below(640) - 330}`);
      } else if (how === 4) {
        u32[0] = next();
        u32[1] = below(0x00200000);
      } else if (how === 5) {
        f64[0] = 2 ** (below(2100) - 1075) * below(3);
      } else {
        u32[0] = next();
        u32[1] = next();
      }

      const b = new Uint8Array(f64.buffer);
      body.push(6, b[4], b[5], b[6], b[7], b[0], b[1], b[2], b[3]);
    }

    const block = Uint8Array.from([0x96, body.length & 255, body.length >> 8, ...body, 0]);
    r.case(`doubles ${k}`, () =>
      Buffer.from(
        handed(
          c,
          c.actionsEmitEachBytes(
            block,
            Int32Array.of(0),
            Int32Array.of(block.length),
            6,
            "0",
            true,
          ),
        ),
      ).toString("latin1"),
    );
    if (k % 50 === 49) {
      c.__collect();
    }
  }
}

/** The tests' blocks mutated, seeded: each a SWF of one block, of SWF 5 or 10 by turns. */
function mutatedBlocks(count: number): Avm1Swf[] {
  const seeds = testBlocks();
  let state = 1;
  const below = (n: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
  const swfs: Avm1Swf[] = [];
  for (let k = 0; k < count; k++) {
    const bytes = [...seeds[below(seeds.length)]];
    for (let edits = 1 + below(4); edits > 0; edits--) {
      const at = below(bytes.length + 1);
      switch (below(3)) {
        case 0:
          bytes.splice(at, 0, below(256));
          break;
        case 1:
          bytes.splice(at, 1);
          break;
        default:
          bytes[at] = below(256);
          break;
      }
    }

    const block = Uint8Array.from(bytes);
    swfs.push({
      name: `mutated ${k}`,
      bytes: block,
      version: k % 2 ? 5 : 10,
      offsets: Int32Array.of(0),
      lengths: Int32Array.of(block.length),
    });
  }

  return swfs;
}

let corpusCounted = false;

/** DoABC and DoABC2 tags' codes. */
const DO_ABC = [72, 82];

/** The ABCs of the corpus's AS3 SWFs (where it was fetched) and of SWF2ES_PRIVATE's, the latter reported only as private. */
function swfAbcs(): [string, Uint8Array][] {
  const corpus = new URL("../player/corpus/ruffle/tests/tests/swfs/", import.meta.url);
  const files: [string, string][] = [];
  try {
    for (const name of readdirSync(corpus, { recursive: true, encoding: "utf8" }).sort()) {
      if (name.endsWith(".swf")) {
        files.push([name, fileURLToPath(new URL(name, corpus))]);
      }
    }
  } catch {
    // Not fetched.
  }

  for (const [i, file] of (process.env.SWF2ES_PRIVATE ?? "").split(" ").filter(Boolean).entries()) {
    files.push([`private ${i}`, file]);
  }

  const found: [string, Uint8Array][] = [];
  for (const [name, file] of files) {
    let swf: ReturnType<typeof readSwf>;
    try {
      swf = readSwf(new Uint8Array(readFileSync(file)));
    } catch {
      continue;
    }

    for (const [k, tag] of swf.tags.filter((t) => DO_ABC.includes(t.code)).entries()) {
      found.push([`${name} abc ${k}`, readDoAbc(swf.bytes, tag).abc]);
    }
  }

  return found;
}

/** Every ABC there is: the libraries and the tests' (abcs), and the SWFs'. */
let allAbcs: [string, Uint8Array][] | null = null;
const everyAbc = () => {
  allAbcs ??= [...abcs(), ...swfAbcs()];
  return allAbcs;
};

/** The tests' ABCs mutated, seeded: bytes flipped, inserted, removed, the block cut short. */
function mutatedAbcs(count: number): [string, Uint8Array][] {
  const seeds = abcs().filter(([, bytes]) => bytes.length < 64 * 1024);
  const { below } = random(7);
  const found: [string, Uint8Array][] = [];
  for (let k = 0; k < count; k++) {
    const [name, seed] = seeds[below(seeds.length)];
    const bytes = [...seed];
    for (let edits = 1 + below(6); edits > 0; edits--) {
      const at = below(bytes.length + 1);
      switch (below(4)) {
        case 0:
          bytes.splice(at, 0, below(256));
          break;
        case 1:
          bytes.splice(at, 1);
          break;
        case 2:
          bytes.length = Math.min(bytes.length, at + 4);
          break;
        default:
          bytes[at] = below(256);
          break;
      }
    }

    found.push([`${name} mutated ${k}`, Uint8Array.from(bytes)]);
  }

  return found;
}

/** Reads of every kind from a prefix of the ABC, as reader.test.ts reads. */
const KINDS = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 8);

/**
 * The pool dumps whose sets AssemblyScript's leaves unspecified: a pool
 * that failed among its namespace sets has no table of members, and
 * AssemblyScript's dump read the sets before past its end, whatever memory
 * followed, where Zig's writes them empty. Zig's dump decides (it runs
 * first): an error, sets all empty, and no multinames.
 */
const unspecifiedSets = new Set<string>();

function poolDumped(r: Results, name: string, text: string): string {
  if (r.compiler === "zig") {
    const sets = text.match(/^nsset .*$/gm) ?? [];
    if (
      text.includes("\nerror ") &&
      !text.includes("\nmn ") &&
      sets.length > 0 &&
      sets.every((line) => /^nsset \d+ $/.test(line))
    ) {
      unspecifiedSets.add(name);
    }
  }

  return unspecifiedSets.has(name) ? text.replace(/^nsset (\d+) .*$/gm, "nsset $1 *") : text;
}

/** An ABC's dumps: its pool, its tables as a SWF's and as a library's, and reads of every kind. */
function abcDumps(c: Compiler, r: Results, name: string, bytes: Uint8Array): void {
  r.case(`${name}: pool`, () =>
    r.blob(`${name}: pool`, Buffer.from(poolDumped(r, name, c.poolDump(bytes)))),
  );
  for (const builtin of [false, true]) {
    r.case(`${name}: tables, builtin ${builtin}`, () =>
      r.blob(`${name}: tables, builtin ${builtin}`, Buffer.from(c.abcDump(bytes, builtin))),
    );
  }

  r.case(`${name}: reads`, () => Array.from(c.readAll(bytes.subarray(0, 96), KINDS)).join(","));
}

const SUITES: Suite[] = [
  {
    name: "version",
    build: "release",
    needs: ["compilerVersion"],
    run: (c, r) => r.case("compilerVersion", () => c.compilerVersion()),
  },
  {
    name: "abcVersion",
    build: "release",
    needs: ["abcVersion"],
    run: (c, r) => {
      for (const [name, bytes] of [...abcs(), ...odd()]) {
        r.case(name, () => c.abcVersion(bytes));
      }
    },
  },
  {
    name: "avm1",
    build: "release",
    needs: AVM1_EXPORTS,
    run: (c, r) => {
      const swfs = avm1Swfs();
      const corpus = swfs.filter((swf) => swf.name.endsWith(".swf")).length;
      if (!corpusCounted) {
        console.log(`  avm1: ${swfs.length} SWFs, ${corpus} of them the corpus's`);
        corpusCounted = true;
      }

      r.case("corpus SWFs", () => {
        // Without the corpus the suite is the tests' few SWFs: fetched in CI, it must be there.
        if (corpus === 0 && process.env.CI) {
          throw new Error("no corpus SWFs: node tests/player/corpus/fetch-ruffle.ts");
        }

        return corpus;
      });
      for (const swf of [...swfs, ...privateSwfs()]) {
        avm1(c, r, swf);
      }
    },
  },
  {
    name: "avm1-generated",
    build: "release",
    needs: [...AVM1_EXPORTS, "actionsEmitEach"],
    run: (c, r) => generated(c, r, 2000),
  },
  {
    name: "avm1-doubles",
    build: "release",
    needs: ["actionsEmitEachBytes"],
    run: (c, r) => doubles(c, r, 2000),
  },
  {
    name: "avm1-mutated",
    build: "release",
    needs: AVM1_EXPORTS,
    run: (c, r) => {
      for (const swf of mutatedBlocks(2000)) {
        avm1(c, r, swf);
      }
    },
  },
  {
    name: "avm1-dumps",
    build: "testing",
    needs: ["avm1Opcodes", "avm1Dump", "avm1Check", "avm1Action"],
    run: (c, r) => {
      r.case("opcodes", () => c.avm1Opcodes());
      const blocks = [
        ...testBlocks(),
        ...mutatedBlocks(2000).map((swf) => swf.bytes),
        ...avm1Swfs().flatMap((swf) =>
          Array.from(swf.offsets, (offset, k) =>
            swf.bytes.subarray(offset, offset + swf.lengths[k]),
          ),
        ),
      ];
      for (const [k, block] of blocks.entries()) {
        r.case(`block ${k}: dump`, () =>
          r.blob(`block ${k}: dump`, Buffer.from(c.avm1Dump(block))),
        );
        r.case(`block ${k}: check`, () => c.avm1Check(block));
        for (const offset of [0, 1, 3, block.length >> 1]) {
          if (offset < block.length) {
            r.case(`block ${k}: action at ${offset}`, () => c.avm1Action(block, offset));
          }
        }
      }
    },
  },
  {
    name: "abc-dumps",
    build: "testing",
    needs: ["poolDump", "abcDump", "readAll", "opcodeTable"],
    run: (c, r) => {
      r.case("opcodes", () => c.opcodeTable());
      for (const [i, [name, bytes]] of everyAbc().entries()) {
        abcDumps(c, r, name, bytes);
        if (i % 32 === 31) {
          c.__collect();
        }
      }
    },
  },
  {
    name: "abc-sweep",
    build: "testing",
    needs: ["poolDump", "abcDump", "readAll"],
    run: (c, r) => {
      // The rich ABC at 46.16 and 47.16, cut at every length and every byte set to edge values.
      let k = 0;
      for (const floats of [false, true]) {
        const seed = richAbc(floats);
        const name = floats ? "rich 47.16" : "rich 46.16";
        for (let n = 0; n <= seed.length; n++) {
          abcDumps(c, r, `${name} cut ${n}`, seed.subarray(0, n));
          if (++k % 64 === 0) {
            c.__collect();
          }
        }

        for (let at = 0; at < seed.length; at++) {
          const b = seed[at];
          const values = [0, 1, 2, 3, 0x7f, 0x80, 0xff, b ^ 1, (b + 1) & 255, (b - 1) & 255];
          for (const v of new Set([...values, b ^ 0x80, b ^ 0x40, b ^ 0x08, 0x1d, 0x09, 0x07])) {
            if (v !== b) {
              const bytes = seed.slice();
              bytes[at] = v;
              abcDumps(c, r, `${name} set ${at}=${v}`, bytes);
              if (++k % 64 === 0) {
                c.__collect();
              }
            }
          }
        }
      }
    },
  },
  {
    name: "abc-mutated",
    build: "testing",
    needs: ["poolDump", "abcDump", "readAll"],
    run: (c, r) => {
      for (const [i, [name, bytes]] of mutatedAbcs(4000).entries()) {
        abcDumps(c, r, name, bytes);
        if (i % 32 === 31) {
          c.__collect();
        }
      }
    },
  },
  {
    name: "libraries",
    build: "release",
    needs: [
      "domainReset",
      "domainAdd",
      "domainModuleBytes",
      "domainModuleMoreBytes",
      "domainModuleDone",
      "domainSourceMap",
      "domainModuleEntries",
    ],
    run: (c, r) => {
      const fp: [string, Uint8Array][] = [
        ["builtin", builtinLibrary],
        ["playerglobal", playerglobalLibrary],
      ];
      libraries(c, r, API_VERSION, fp);
      libraries(c, r, AIR_API_VERSION, [...fp, ["air", airLibrary]]);
    },
  },
];

const compile = (path: string) => WebAssembly.compile(readFileSync(join(root, path)));
const modules = {
  as: await compile("packages/codegen/dist/codegen.wasm"),
  asTesting: await compile("packages/codegen/dist-test/testing.wasm"),
  zig: await compile("packages/codegen/dist/codegen-zig.wasm"),
  zigTesting: await zigTestingModule(false),
  poison: await zigTestingModule(true),
};
const { instantiate: instantiateAsTesting } = await import(
  new URL("../../packages/codegen/dist-test/testing.js", import.meta.url).href
);
const exported = (module: WebAssembly.Module) =>
  new Set(WebAssembly.Module.exports(module).map((e) => e.name));
const has = { release: exported(modules.zig), testing: exported(modules.zigTesting) };

/** Fresh instances of the three, as a host makes one, for each suite. */
async function instances(build: Suite["build"]): Promise<Record<string, Compiler>> {
  // Zig's first: what it writes decides how the others' unspecified parts are compared (poolDumped).
  return build === "release"
    ? {
        zig: await instantiateZig(modules.zig),
        poison: await bindTesting(modules.poison),
        as: await instantiateAs(modules.as, { env: {} }),
      }
    : {
        zig: await bindTesting(modules.zigTesting),
        poison: await bindTesting(modules.poison),
        as: await instantiateAsTesting(modules.asTesting, { env: {} }),
      };
}

let failed = 0;
for (const [name, module] of Object.entries(modules)) {
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  if (name !== "as" && name !== "asTesting" && imports.join() !== "env.abort") {
    console.log(`${name} imports ${imports.join(", ")}, not env.abort alone`);
    failed++;
  }
}

const exports = Object.keys(SIGNATURES);
const ported = exports.filter((name) => has.release.has(name));
console.log(
  `parity: Zig's compiler has ${ported.length} of codegen.wasm's ${exports.length} exports`,
);

/** The first line two lists differ at, or -1. */
function differs(a: string[], b: string[]): number {
  const at = a.findIndex((line, i) => line !== b[i]);
  return at >= 0 ? at : a.length === b.length ? -1 : Math.min(a.length, b.length);
}

/**
 * Two compilers' large result of case `key`, run again with its bytes
 * kept: their first differing line, both written to out/ beside each other.
 */
async function showBlobs(suite: Suite, key: string, aName: string, bName: string): Promise<string> {
  const fresh = await instances(suite.build);
  const [a, b] = [new Results(aName, new Set([key])), new Results(bName, new Set([key]))];
  suite.run(fresh[aName], a);
  suite.run(fresh[bName], b);
  const [aBytes, bBytes] = [a.blobs.get(key), b.blobs.get(key)];
  if (!aBytes || !bBytes) {
    return "";
  }

  const dir = join(out, suite.name);
  mkdirSync(dir, { recursive: true });
  const file = key.replace(/[^\w.-]+/g, "-");
  writeFileSync(join(dir, `${file}.${aName}`), aBytes);
  writeFileSync(join(dir, `${file}.${bName}`), bBytes);
  const aLines = Buffer.from(aBytes).toString("latin1").split("\n");
  const bLines = Buffer.from(bBytes).toString("latin1").split("\n");
  const at = differs(aLines, bLines);
  return `\n    ${key}, line ${at + 1} (out/${suite.name}/${file}.*):\n      ${aName}: ${aLines[at]?.slice(0, 200)}\n      ${bName}: ${bLines[at]?.slice(0, 200)}`;
}

const wanted = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const report: Record<string, string> = {};
for (const suite of SUITES.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
  const missing = suite.needs.filter((name) => !has[suite.build].has(name));
  if (missing.length > 0) {
    report[suite.name] = `not ported: ${missing.join(", ")}`;
    console.log(`  ${suite.name}: not ported (${missing.join(", ")})`);
    if (expected.includes(suite.name)) {
      console.log(`  ${suite.name} is in expected.json, but not ported`);
      failed++;
    }

    continue;
  }

  const results: Record<string, Results> = {};
  for (const [compiler, instance] of Object.entries(await instances(suite.build))) {
    results[compiler] = new Results(compiler);
    suite.run(instance, results[compiler]);
    writeFileSync(join(out, `${suite.name}.${compiler}.txt`), results[compiler].lines.join("\n"));
  }

  const mismatches: string[] = [];
  for (const [a, b] of [
    ["as", "zig"],
    ["zig", "poison"],
  ] as const) {
    const [la, lb] = [results[a].lines, results[b].lines];
    const at = differs(la, lb);
    if (at >= 0) {
      const key = results[a].names[at];
      mismatches.push(
        `${b} differs from ${a} at case ${at + 1} of ${la.length}:\n    ${a}: ${la[at]}\n    ${b}: ${lb[at]}` +
          (key ? await showBlobs(suite, key, a, b) : ""),
      );
    }
  }

  report[suite.name] = mismatches.length ? "differs" : `same, ${results.as.lines.length} cases`;
  console.log(
    `  ${suite.name}: ${mismatches.length ? mismatches.join("\n  ") : report[suite.name]}`,
  );
  if (mismatches.length && expected.includes(suite.name)) {
    failed++;
  } else if (!mismatches.length && !expected.includes(suite.name)) {
    // A ratchet: what is the same is held so.
    console.log(`  ${suite.name} is the same now: add it to tests/parity/expected.json`);
    failed++;
  }
}

writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed > 0) {
  process.exitCode = 1;
}
