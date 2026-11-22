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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIR_API_VERSION, API_VERSION } from "@swf2es/codegen";
import { airLibrary, builtinLibrary, playerglobalLibrary } from "@swf2es/player/libraries";
import { shellToplevelLibrary } from "../../packages/cli/dist/shell-toplevel-library.js";
import { instantiate as instantiateAs } from "../../packages/codegen/dist/codegen.js";
import {
  type CodegenExports,
  instantiate as instantiateZig,
  SIGNATURES,
} from "../../packages/codegen/dist/zig.js";
import { isAs3, readActions, readDoAbc, readSwf } from "../../packages/format/dist/index.js";
import { type Avm1Swf, avm1Swfs, testBlocks } from "../conformance/determinism-avm1.ts";
import { abc as abcOf, tables, u30 } from "../unit/codegen/abc-builder.ts";
import { linkCases, resolveCases } from "../unit/codegen/link-cases.ts";
import { bindTesting, zigTestingModule } from "../unit/codegen/zig-testing.ts";
import { structuredAbcs } from "./body-fuzz.ts";
import { linkAbcs } from "./link-abc.ts";
import { richAbc } from "./rich-abc.ts";
import { verifyErrorAbcs } from "./verify-errors.ts";

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
  /** Why the suite cannot run here, if it cannot: one of what only some hosts have, which the ratchet leaves out. */
  unavailable?: () => string | null;
  /** The release builds, or the test builds with their dumps. */
  build: "release" | "testing";
  /** The exports it calls. */
  needs: string[];
  /** Its cases on `compiler`; `fresh` makes another instance of the same compiler, for a case that may kill one. */
  run(compiler: Compiler, results: Results, fresh: () => Promise<Compiler>): void | Promise<void>;
  /**
   * Cases where AssemblyScript's stack ran out (asc's instance traps where
   * Zig's, whose linker keeps its own stacks, goes on) are reported rather
   * than compared.
   */
  asStackLimit?: boolean;
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
      // Each part copied as it is handed out: any call may grow memory.
      const parts = [handed(c, c.domainModuleBytes("", index, true, false)).slice()];
      while (!c.domainModuleDone()) {
        c.__collect();
        parts.push(handed(c, c.domainModuleMoreBytes()).slice());
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

const MODULE_EXPORTS = [
  "domainModule",
  "domainModuleBytes",
  "domainModuleMoreBytes",
  "domainModuleDone",
  "domainSourceMap",
  "domainModuleEntries",
  "domainEmitEach",
  "domainPartBudget",
];

const KEY_EXPORTS = [
  "domainModule",
  "domainLogMark",
  "domainLogSince",
  "domainReplay",
  "domainContext",
  "domainKeyHeaderBytes",
  "domainKeyLogBytes",
  "domainKeyFork",
  "domainRevision",
];

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

/**
 * The link cases whose results AssemblyScript leaves unspecified: an empty
 * last namespace set read past its end for a name's first namespace, where
 * AssemblyScript's unchecked read takes whatever memory follows and Zig's
 * takes namespace 0, counting it (unspecifiedReads). Zig's decides (it
 * runs first); the case is then compared as unspecified.
 */
const unspecifiedLinks = new Set<string>();

/** A link case: unspecified where Zig's read past a set. */
function linked(c: Compiler, r: Results, name: string, run: () => string | number | boolean): void {
  r.case(name, () => {
    const result = run();
    if (r.compiler !== "as" && c.unspecifiedReads() > 0 && r.compiler === "zig") {
      unspecifiedLinks.add(name);
    }

    return unspecifiedLinks.has(name) ? "unspecified" : result;
  });
}

/** Libraries to link against: the player's, or avmshell's builtin and shell_toplevel. */
type Base = { version: number; libraries: Uint8Array[] };
const PLAYER: Base = { version: API_VERSION, libraries: [builtinLibrary, playerglobalLibrary] };
const AIR: Base = {
  version: AIR_API_VERSION,
  libraries: [builtinLibrary, playerglobalLibrary, airLibrary],
};
const SHELL: Base = { version: API_VERSION, libraries: [builtinLibrary, shellToplevelLibrary] };

/** A domain being linked into, and how many ABCs it holds, the next one's index. */
class Linking {
  readonly c: Compiler;
  readonly r: Results;
  count = 0;

  constructor(c: Compiler, r: Results) {
    this.c = c;
    this.r = r;
  }

  reset(name: string, base: Base): void {
    this.count = 0;
    this.r.case(`${name}: reset`, () => {
      this.c.domainReset(base.version);
      return base.libraries.map((lib) => this.add(lib, true, 0)).join(",");
    });
  }

  add(bytes: Uint8Array, builtin: boolean, domain: number): number {
    const error = this.c.domainAdd(bytes, builtin, domain);
    if (error === 0) {
      this.count++;
    }

    return error;
  }

  /**
   * ABC `bytes` added to application domain `domain`, and what linking
   * made of it: the error, its traits, their resolution, and its classes'
   * slot types, which resolve them in their order.
   */
  link(name: string, bytes: Uint8Array, domain: number, builtin = false): boolean {
    const { c, r } = this;
    let first = 0;
    let error = -2;
    linked(c, r, `${name}: add`, () => {
      first = c.domainTraitsCount();
      error = this.add(bytes, builtin, domain);
      return error;
    });
    if (error !== 0) {
      return false;
    }

    const index = this.count - 1;
    linked(c, r, `${name}: traits`, () =>
      r.blob(`${name}: traits`, Buffer.from(c.domainTraits(first))),
    );
    linked(c, r, `${name}: linked`, () => c.domainLinked(index));
    linked(c, r, `${name}: slot types`, () => {
      const all: string[] = [];
      for (let cls = 0; cls < 4096; cls++) {
        const types = c.domainSlotTypes(index, cls);
        if (types === "none") {
          break;
        }

        all.push(types);
      }

      return r.blob(`${name}: slot types`, Buffer.from(all.join("\n")));
    });
    linked(c, r, `${name}: resolve`, () => c.domainResolve(first));
    linked(c, r, `${name}: after`, () =>
      r.blob(`${name}: after`, Buffer.from(c.domainTraits(first))),
    );
    return true;
  }

  /** The domain's counts and versioned URIs, its builtins, and what its ABCs weigh. */
  summary(name: string): void {
    const { c, r } = this;
    linked(c, r, `${name}: summary`, () =>
      r.blob(`${name}: summary`, Buffer.from(c.domainSummary())),
    );
    linked(c, r, `${name}: builtins`, () => c.domainBuiltins());
    // Live and dead weights count rows alike; the memory after them is each compiler's own.
    linked(c, r, `${name}: usage`, () => c.domainUsage().split(" ").slice(0, 2).join(" "));
  }

  /** Lookups of names the libraries define, from `domain`. */
  finds(name: string, domain: number): void {
    const { c, r } = this;
    for (const [type, uri, local] of FINDS) {
      for (const version of [0, 50, 52]) {
        linked(c, r, `${name}: find ${type} ${uri}::${local} at ${version}`, () =>
          c.domainFind(type, uri, local, version, domain),
        );
      }
    }
  }
}

/** Names to look up: the libraries', the tests', and some no ABC has. */
const FINDS: [number, string, string][] = [
  [0, "", "Object"],
  [0, "", "trace"],
  [0, "", "Vector"],
  [0, "__AS3__.vec", "Vector"],
  [0, "flash.display", "Sprite"],
  [0, "flash.display", "MovieClip"],
  [0, "flash.utils", "getTimer"],
  [0, "avmplus", "System"],
  [0, "", "print"],
  [0, "", "Main"],
  [0, "", "Test"],
  [1, "", "Object"],
  [0, "", "nowhere"],
];

/** The SWFs' ABCs (swfAbcs) by SWF, in their order. */
function bySwf(list: [string, Uint8Array][]): [string, [string, Uint8Array][]][] {
  const swfs = new Map<string, [string, Uint8Array][]>();
  for (const [name, bytes] of list) {
    const swf = name.replace(/ abc \d+$/, "");
    swfs.set(swf, [...(swfs.get(swf) ?? []), [name, bytes]]);
  }

  return [...swfs];
}

/**
 * Each SWF's ABCs added as the player adds a loaded SWF's, into a child
 * of the root, which is dropped after; the domain is made again every few
 * dozen SWFs, so a case does not depend on every SWF before it.
 */
function linkSwfs(
  c: Compiler,
  r: Results,
  base: Base,
  swfs: [string, [string, Uint8Array][]][],
): void {
  const linking = new Linking(c, r);
  for (const [k, [swf, list]] of swfs.entries()) {
    if (k % 40 === 0) {
      linking.reset(`batch ${k}`, base);
      linking.summary(`batch ${k}`);
      c.__collect();
    }

    let child = -1;
    r.case(`${swf}: child`, () => {
      child = c.domainChild(0);
      return child;
    });
    for (const [name, bytes] of list) {
      linking.link(name, bytes, child);
    }

    linking.summary(swf);
    linking.finds(swf, child);
    r.case(`${swf}: drop`, () => {
      c.domainDrop(child);
      return c.domainState(child);
    });
  }
}

/** ABCs that link against the player's libraries, or fail to as avmplus does: the tests', the link cases' and the link ABCs'. */
function linkSeeds(): [string, Uint8Array][] {
  return [
    ...abcs().slice(3),
    ...[...linkCases, ...resolveCases].map((c): [string, Uint8Array] => [`case ${c.name}`, c.abc]),
    ["link user", linkAbcs().user],
    ...verifyErrorAbcs(),
    ["rich 47.16", richAbc(true)],
  ];
}

/**
 * The link seeds mutated, seeded: mostly a byte or two set past the pool,
 * where a mutation still parses and links differently, else anywhere.
 */
function mutatedLinks(count: number): [string, Uint8Array][] {
  const seeds = linkSeeds();
  const { below } = random(13);
  const found: [string, Uint8Array][] = [];
  for (let k = 0; k < count; k++) {
    const [name, seed] = seeds[below(seeds.length)];
    const bytes = seed.slice();
    for (let edits = 1 + below(2); edits > 0; edits--) {
      const from = below(10) < 7 ? bytes.length >> 1 : 0;
      bytes[from + below(bytes.length - from)] = below(4) === 0 ? below(256) : below(8);
    }

    found.push([`${name} mutated ${k}`, bytes]);
  }

  return found;
}

/** The ABCs ASC compiled for the oracle (Tamarin's tests, the conformance cases), where this host keeps them. */
function oracleDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return process.env.SWF2ES_ORACLE_CACHE ?? join(cache, "swf2es", "oracle");
}

function oracleAbcs(): [string, [string, Uint8Array][]][] {
  const found: [string, [string, Uint8Array][]][] = [];
  const dir = oracleDir();
  for (const sub of readdirSync(dir).sort()) {
    for (const file of readdirSync(join(dir, sub))
      .filter((f) => f.endsWith(".abc"))
      .sort()) {
      found.push([
        file.slice(0, 16),
        [[file.slice(0, 16), new Uint8Array(readFileSync(join(dir, sub, file)))]],
      ]);
    }
  }

  return found;
}

/**
 * A domain's lifetimes in random steps: child domains made, ABCs added to
 * them, findings reported, domains dropped, evicted and revived, and after
 * each step what every domain sees.
 */
function lifetimes(c: Compiler, r: Results, sequences: number): void {
  const seeds = linkSeeds().map(([, bytes]) => bytes);
  const { below } = random(11);
  const linking = new Linking(c, r);
  for (let s = 0; s < sequences; s++) {
    linking.reset(`sequence ${s}`, PLAYER);
    let domains = 1;
    for (let step = 0; step < 40; step++) {
      const name = `sequence ${s} step ${step}`;
      const d = below(domains + 1) % Math.max(domains, 1);
      switch (below(8)) {
        case 0:
        case 1:
          r.case(`${name}: child of ${d}`, () => {
            const child = c.domainChild(d);
            if (child >= 0) {
              domains = child + 1;
            }

            return child;
          });
          break;
        case 2:
        case 3: {
          const k = below(seeds.length);
          linking.link(`${name}: abc ${k} into ${d}`, seeds[k], d);
          break;
        }
        case 4:
          r.case(`${name}: drop ${d}`, () => {
            c.domainDrop(d);
            return "done";
          });
          break;
        case 5:
          r.case(`${name}: evict ${d}`, () => {
            c.domainEvict(d);
            return "done";
          });
          break;
        case 6:
          r.case(`${name}: revive ${d}`, () => c.domainRevive(d, false));
          break;
        default: {
          const [type, uri, local] = FINDS[below(FINDS.length)];
          const abc = below(linking.count + 1);
          const asType = below(2) === 1;
          r.case(
            `${name}: found ${type} ${uri}::${local} in ${abc} by ${d} as type ${asType}`,
            () => {
              c.domainFound(d, type, uri, local, abc, asType);
              return "done";
            },
          );
          break;
        }
      }

      r.case(`${name}: domains`, () =>
        Array.from(
          { length: domains + 1 },
          (_, k) => `${c.domainState(k)}/${c.domainParent(k)}`,
        ).join(" "),
      );
      linking.finds(name, d);
    }

    linking.summary(`sequence ${s}`);
    c.__collect();
  }
}

/**
 * An ABC of `n` classes, each extending the one before (or, `interfaces`,
 * each an interface extending the one before), and a script with a body:
 * a chain as deep as the input makes it, which AssemblyScript's linker
 * recurses along.
 */
function chainAbc(n: number, interfaces: boolean): Uint8Array {
  const out: number[] = [16, 0, 46, 0, 0, 0, 0];
  const push = (...bytes: number[]) => {
    for (const b of bytes) {
      out.push(b);
    }
  };
  push(...u30(n + 2), 0);
  for (let i = 0; i < n; i++) {
    const name = `C${i}`;
    push(name.length, ...[...name].map((ch) => ch.charCodeAt(0)));
  }

  push(2, 0x16, 1, 0);
  push(...u30(n + 1));
  for (let i = 0; i < n; i++) {
    push(0x07, 1, ...u30(i + 2));
  }

  push(...u30(2 * n + 1));
  for (let i = 0; i < 2 * n + 1; i++) {
    push(0, 0, 0, 0);
  }

  push(0, ...u30(n));
  for (let i = 0; i < n; i++) {
    push(...u30(i + 1), ...(interfaces || i === 0 ? [0] : u30(i)), interfaces ? 0x04 : 0);
    push(...(interfaces && i > 0 ? [1, ...u30(i)] : [0]));
    push(...u30(2 * i), 0);
  }

  for (let i = 0; i < n; i++) {
    push(...u30(2 * i + 1), 0);
  }

  push(1, ...u30(2 * n), 0, 1, ...u30(2 * n), 1, 1, 0, 1, 1, 0x47, 0, 0);
  return new Uint8Array(out);
}

/**
 * An ABC whose class C has a slot of type Vector.<Vector.<...<int>>>,
 * TypeNames nested `n` deep, which AssemblyScript resolves recursively.
 */
function nestedAbc(n: number): Uint8Array {
  const multinames = [
    [0x07, 2, ...u30(3)],
    [0x07, 1, ...u30(5)],
    [0x07, 1, ...u30(2)],
    [0x07, 1, ...u30(6)],
    [0x07, 1, ...u30(7)],
  ];
  for (let k = 0; k < n; k++) {
    multinames.push([0x1d, 1, 1, ...u30(k === 0 ? 2 : 5 + k)]);
  }

  return abcOf(
    {
      strings: ["", "Object", "Vector", "__AS3__.vec", "int", "C", "x"],
      namespaces: [
        [0x16, ...u30(1)],
        [0x16, ...u30(4)],
      ],
      multinames,
    },
    tables({
      methods: [{}, {}, {}],
      classes: [
        {
          instance: { name: 4, base: 3, init: 0, traits: [{ name: 5, kind: 0, index: 5 + n }] },
          init: 1,
        },
      ],
      scripts: [{ init: 2, traits: [{ name: 4, kind: 4, id: 1, index: 0 }] }],
      bodies: [{ method: 2, code: [0x47] }],
    }),
  );
}

/**
 * An ABC whose script initializer is one block of `n` ifs, each branching
 * to a merge of its own: `n` labelled blocks nested in its code, which
 * the emitter recurses into one by one, structured to 499 and dispatched
 * from MAX_NESTING, 500.
 */
function nestedIfsAbc(n: number): Uint8Array {
  const code: number[] = [];
  for (let k = 0; k < n; k++) {
    const offset = 6 * n - 6 * k - 5;
    code.push(0x26, 0x12, offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff);
  }

  for (let k = 0; k <= n; k++) {
    code.push(0x02);
  }

  code.push(0x47);
  return abcOf(
    { strings: [], namespaces: [], multinames: [] },
    tables({
      methods: [{}],
      scripts: [{ init: 0, traits: [] }],
      bodies: [{ method: 0, code }],
    }),
  );
}

/**
 * An ABC whose script initializer is `n` conditional branches, each over a
 * return to the next: each target a block entered once, whose code the
 * emitter writes in place inside the branch, `n` deep: structured to 500,
 * MAX_NESTING, each level a call deeper through the instruction that
 * branches, where the merges' levels are one call each.
 */
function chainedIfsAbc(n: number): Uint8Array {
  const code: number[] = [];
  for (let k = 0; k < n; k++) {
    code.push(0x26, 0x11, 1, 0, 0, 0x47);
  }

  code.push(0x47);
  return abcOf(
    { strings: [], namespaces: [], multinames: [] },
    tables({
      methods: [{}],
      scripts: [{ init: 0, traits: [] }],
      bodies: [{ method: 0, code }],
    }),
  );
}

/** Body 0 of a deep ABC compiled alone, in a fresh instance; for Zig, how deep its stack went. */
async function deepEmit(
  r: Results,
  fresh: () => Promise<Compiler>,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const c = await fresh();
  r.case(`${name}: emit`, () => {
    c.domainReset(API_VERSION);
    const error = c.domainAdd(bytes, false, 0);
    if (error !== 0) {
      return `add ${error}`;
    }

    c.stackPaint?.();
    const text: string = c.domainEmit(0);
    if (c.stackDeepest) {
      console.log(`    ${name}: ${r.compiler}'s stack reached ${c.stackDeepest()} bytes`);
    }

    return r.blob(
      `${name}: emit`,
      Buffer.from(`${/L\d+: \{/.test(text) ? "structured" : "dispatched"}\n${text}`),
    );
  });
}

/**
 * From the review of stage 5: structured ABCs, a third mutated, each linked
 * into a child domain and its module written a part at a time with a
 * random budget, kept or not, sometimes left after its second part for a
 * child made and dropped and the exports asked of the module abandoned;
 * then its entries compiled again alone, in order or reversed, with
 * items that name nothing, and the module whole, linked only.
 */
function modulePlans(c: Compiler, r: Results, seed: number, count: number): void {
  const { below } = random(Math.imul(seed, 2654435761) >>> 0 || 1);
  const plan = structuredAbcs(count, seed).map((base) => {
    const bytes = base.slice();
    if (below(3) === 0) {
      for (let e = 1 + below(3); e > 0; e--) {
        const from = bytes.length - (bytes.length >> 2);
        bytes[from + below(bytes.length - from)] = below(2)
          ? below(256)
          : [
              0x24, 0x2c, 0x30, 0x1d, 0x10, 0x11, 0x47, 0x48, 0x60, 0x66, 0x5d, 0x4f, 0x80, 0xd0,
              0xd5, 0x1b, 0x5a, 0x40, 1, 2, 3,
            ][below(21)];
      }
    }

    return {
      bytes,
      budget: [1, 7, 64, 300, 5000, 0][below(6)],
      keep: below(4) !== 0,
      abandon: below(8),
      reuse: below(2) === 0,
    };
  });
  const digest = (b: Uint8Array | string) => {
    const x = typeof b === "string" ? Buffer.from(b) : b;
    return `${x.length}:${createHash("sha1").update(x).digest("hex").slice(0, 12)}`;
  };
  const copy = (address: number) => handed(c, address).slice();
  for (const [k, p] of plan.entries()) {
    r.case(`plan ${seed}/${k}`, () => {
      if (k % 40 === 0) {
        c.domainReset(API_VERSION);
        c.domainAdd(builtinLibrary, true, 0);
        c.__collect();
      }

      const child = c.domainChild(0);
      const error = c.domainAdd(p.bytes, false, child);
      let line = `add ${error}`;
      if (error === 0) {
        c.domainPartBudget(p.budget);
        const parts = [copy(c.domainModuleBytes("h0\nh1", -1, p.keep, false))];
        let n = 0;
        while (!c.domainModuleDone()) {
          if (p.abandon === 1 && n === 1) {
            const other = c.domainChild(0);
            c.domainDrop(other);
            line += ` abandoned ${other} ${c.domainModuleDone()} ${copy(c.domainModuleMoreBytes()).length} [${c.domainSourceMap()}] ${c.domainModuleEntries().length} usage ${c.domainUsage().split(" ").slice(0, 2)}`;
            break;
          }

          parts.push(copy(c.domainModuleMoreBytes()));
          n++;
        }

        line += ` more-after ${copy(c.domainModuleMoreBytes()).length} ${c.domainModuleDone()}`;
        c.domainPartBudget(0);
        const entries: string = c.domainModuleEntries();
        const bodies = entries
          .split("\u0002")
          .filter((x) => x.length)
          .map((x) => x.slice(0, x.indexOf("\u0001")));
        line += ` parts ${parts.length} ${digest(Buffer.concat(parts))} map ${digest(c.domainSourceMap())} entries ${digest(entries)}`;
        if (p.abandon === 2) {
          bodies.reverse();
        }

        line += ` each ${digest(c.domainEmitEach(`${bodies.join(",")},,-1,99999,x`, p.reuse))}`;
        line += ` map2 ${digest(c.domainSourceMap())} ent2 ${digest(c.domainModuleEntries())}`;
        line += ` whole ${digest(c.domainModule("own\nfirst\nsecond", -1, false, true))} ent3 ${digest(c.domainModuleEntries())}`;
        if (p.abandon === 3) {
          line += ` whole2 ${digest(c.domainModule("", -1, true, false))} ${digest(c.domainEmitEach(bodies.join(","), !p.reuse))}`;
        }
      }

      c.domainDrop(child);
      return line;
    });
  }
}

/**
 * From the review of stage 5: random calls of the release's domain and
 * module exports with wild arguments, application domains never made,
 * dropped and evicted, indices negative and huge, parts asked for with
 * none pending.
 */
function exportCalls(c: Compiler, r: Results, seed: number, steps: number): void {
  const { below } = random(Math.imul(seed, 2246822519) >>> 0 || 1);
  const abcs = structuredAbcs(400, seed + 1000);
  const digest = (b: Uint8Array | string) => {
    const x = typeof b === "string" ? Buffer.from(b) : b;
    return `${x.length}:${createHash("sha1").update(x).digest("hex").slice(0, 10)}`;
  };
  const copy = (address: number) => (address === 0 ? "none" : digest(handed(c, address).slice()));
  let added = 0;
  let domains = 1;
  c.domainReset(API_VERSION);
  c.domainAdd(builtinLibrary, true, 0);
  added = 1;
  const index = () =>
    [-1, -1, below(added + 2) - 1, added - 1, below(5) === 0 ? 1 << 30 : below(added + 1), -5][
      below(6)
    ];
  const domain = () => [0, below(domains + 2) - 1, domains - 1, -3, 1 << 20][below(5)];
  for (let k = 0; k < steps; k++) {
    r.case(`call ${seed}/${k}`, () => {
      switch (below(16)) {
        case 0:
          if (below(40) === 0) {
            c.domainReset(below(2) ? API_VERSION : 50);
            c.domainAdd(builtinLibrary, true, 0);
            added = 1;
            domains = 1;
            return "reset";
          }

          return "skip";
        case 1:
        case 2: {
          const d = domain();
          const e = c.domainAdd(abcs[below(abcs.length)], false, d);
          if (e >= 0) {
            added++;
          }

          return `add ${d} ${e}`;
        }
        case 3: {
          const d = domain();
          const made = c.domainChild(d);
          if (made >= 0) {
            domains++;
          }

          return `child ${d} ${made}`;
        }
        case 4: {
          const d = domain();
          if (d !== 0 && below(3) === 0) {
            c.domainDrop(d);
            return `drop ${d} ${c.domainState(d)}`;
          }

          return `state ${c.domainState(d)} ${c.domainParent(d)}`;
        }
        case 5: {
          const d = domain();
          if (d !== 0 && below(2) === 0) {
            c.domainEvict(d);
            return `evict ${d} ${c.domainState(d)}`;
          }

          return `revive ${d} ${c.domainRevive(d, false)}`;
        }
        case 6: {
          const i = index();
          return `module ${i} ${digest(c.domainModule(below(2) ? "a\nb\nc" : "", i, below(2) === 0, below(2) === 0))}`;
        }
        case 7:
        case 8: {
          const i = index();
          const address = c.domainModuleBytes(
            below(2) ? "a\nb" : "",
            i,
            below(2) === 0,
            below(2) === 0,
          );
          return `bytes ${i} ${copy(address)} ${c.domainModuleDone()}`;
        }
        case 9:
        case 10:
        case 11:
          return `more ${copy(c.domainModuleMoreBytes())} ${c.domainModuleDone()}`;
        case 12:
          return `entries ${digest(c.domainModuleEntries())}`;
        case 13:
          return `map ${digest(c.domainSourceMap())}`;
        case 14: {
          const i = index();
          return `linked ${i} ${c.domainLinked(i)}`;
        }
        default:
          return `usage ${c.domainUsage().split(" ").slice(0, 2).join(" ")} done ${c.domainModuleDone()}`;
      }
    });
  }
}

/** A deep case, alone in a fresh instance: AssemblyScript's may trap on it. */
async function deep(
  r: Results,
  fresh: () => Promise<Compiler>,
  name: string,
  bytes: Uint8Array,
  libraries: Uint8Array[],
  last: number,
): Promise<void> {
  const c = await fresh();
  r.case(`${name}: link`, () => {
    c.domainReset(API_VERSION);
    for (const library of libraries) {
      c.domainAdd(library, true, 0);
    }

    const index = libraries.length;
    const error = c.domainAdd(bytes, false, 0);
    if (error !== 0) {
      return `add ${error}`;
    }

    // The last class first, which resolves the whole chain at once.
    const count = c.domainTraitsCount();
    const types = c.domainSlotTypes(index, last);
    return `add 0, ${count} traits, class ${last}'s slots ${types}, resolve ${c.domainResolve(0)}, then ${c.domainAdd(chainAbc(3, false), false, 0)}`;
  });
}

/**
 * Host call sequences with wild arguments, from the review of stage 3's
 * differential fuzz: domains never made, negative and huge ids, restores
 * of live, held and missing ABCs, odd API versions, findings with bad
 * kinds and ABCs, and what every domain sees after each step.
 */
function calls(c: Compiler, r: Results, sequences: number, steps: number): void {
  const seeds = linkSeeds().map(([, bytes]) => bytes);
  seeds.push(linkAbcs().failing);
  const finds: [number, string, string][] = [
    [0, "", "Object"],
    [0, "", "A"],
    [0, "", "B"],
    [0, "", "Error"],
    [0, "flash.display", "Sprite"],
    [0, "", "nowhere"],
    [1, "", "Object"],
    [0, "", "I"],
  ];
  const wild = [-1, -2, 0x7fffffff, -2147483648, 1000000, 255, 256, 65536];
  const versions = [50, 51, 0, 52, 255, -1, 2, 9, 53, 300];
  for (let s = 0; s < sequences; s++) {
    const { below } = random(s * 7919 + 1);
    const name = `calls ${s}`;
    let abcs = 0;
    let domains = 1;
    const add = (bytes: Uint8Array, builtin: boolean, d: number) => {
      const error = c.domainAdd(bytes, builtin, d);
      if (error === 0) {
        abcs++;
      }

      return error;
    };
    const version = below(4) ? 50 : versions[below(versions.length)];
    r.case(`${name}: reset ${version}`, () => {
      c.domainReset(version);
      return below(3) > 0
        ? add(linkAbcs().builtin, true, 0)
        : [add(builtinLibrary, true, 0), add(playerglobalLibrary, true, 0)].join();
    });
    const anyDomain = () => (below(8) === 0 ? wild[below(wild.length)] : below(domains + 2));
    for (let step = 0; step < steps; step++) {
      const at = `${name} step ${step}`;
      const d = anyDomain();
      switch (below(12)) {
        case 0:
        case 1:
          r.case(`${at}: child of ${d}`, () => {
            const child = c.domainChild(d);
            if (child >= 0) {
              domains = child + 1;
            }

            return child;
          });
          break;
        case 2:
        case 3: {
          const k = below(seeds.length);
          const builtin = below(10) === 0;
          const first = c.domainTraitsCount();
          r.case(`${at}: add ${k} into ${d}, builtin ${builtin}`, () => add(seeds[k], builtin, d));
          r.case(`${at}: traits`, () =>
            r.blob(`${at}: traits`, Buffer.from(c.domainTraits(first))),
          );
          if (below(2)) {
            r.case(`${at}: resolve`, () => c.domainResolve(first));
          }
          break;
        }
        case 4:
          r.case(`${at}: drop ${d}`, () => c.domainDrop(d) ?? "done");
          break;
        case 5:
          r.case(`${at}: evict ${d}`, () => c.domainEvict(d) ?? "done");
          break;
        case 6:
          r.case(`${at}: revive ${d}`, () => c.domainRevive(d, below(2) === 1));
          break;
        case 7: {
          const [type, uri, local] = finds[below(finds.length)];
          const abc = below(6) === 0 ? wild[below(wild.length)] : below(abcs + 2);
          const kind = below(6) === 0 ? wild[below(wild.length)] : type;
          const asType = below(2) === 1;
          r.case(
            `${at}: found ${kind} ${uri}::${local} of ${abc} by ${d} as type ${asType}`,
            () => {
              c.domainFound(d, kind, uri, local, abc, asType);
              return "done";
            },
          );
          break;
        }
        case 8: {
          const i = below(4) === 0 ? wild[below(wild.length)] : below(abcs + 2);
          const k = below(seeds.length + 1);
          const bytes = k === seeds.length ? new Uint8Array(below(6)) : seeds[k];
          r.case(`${at}: restore ${i} with ${k}`, () => c.domainRestore(i, bytes));
          break;
        }
        case 9: {
          const i = below(4) === 0 ? wild[below(wild.length)] : below(abcs + 2) - 1;
          r.case(`${at}: linked ${i}`, () => c.domainLinked(i));
          break;
        }
        case 10: {
          const i = below(abcs + 1);
          const cls = below(5);
          r.case(`${at}: slot types ${i} ${cls}`, () =>
            i < abcs ? c.domainSlotTypes(i, cls) : "none",
          );
          break;
        }
        default:
          r.case(`${at}: usage`, () => c.domainUsage().split(" ").slice(0, 2).join(" "));
          break;
      }

      r.case(`${at}: domains`, () =>
        Array.from(
          { length: domains + 1 },
          (_, k) => `${c.domainState(k)}/${c.domainParent(k)}`,
        ).join(" "),
      );
      const from = below(domains);
      for (const [type, uri, local] of finds) {
        for (const v of [0, 50, 52]) {
          r.case(`${at}: find ${type} ${uri}::${local} at ${v} from ${from}`, () =>
            c.domainFind(type, uri, local, v, from),
          );
        }
      }
    }

    r.case(`${name}: summary`, () => r.blob(`${name}: summary`, Buffer.from(c.domainSummary())));
    if (s % 16 === 15) {
      c.__collect();
    }
  }
}

/** The VerifyError numbers AssemblyScript's verify gave in the suite running, by number, for its report. */
const verifyErrors = new Map<string, number>();

/** What verifying the last ABC added gives: each body's error, the IR checked, and some bodies' IR. */
function verifyLast(c: Compiler, r: Results, name: string, irs: number): void {
  let bodies = 0;
  linked(c, r, `${name}: verify`, () => {
    const text: string = c.domainVerifyAll();
    bodies = Number(/of (\d+) bodies$/.exec(text)?.[1] ?? 0);
    if (r.compiler === "as") {
      for (const [, error] of text.matchAll(/ error (\d+)$/gm)) {
        verifyErrors.set(error, (verifyErrors.get(error) ?? 0) + 1);
      }
    }

    return r.blob(`${name}: verify`, Buffer.from(text));
  });
  linked(c, r, `${name}: check IR`, () => c.domainCheckIr());
  // Every verified body's whole IR, entry frames and flags included.
  linked(c, r, `${name}: full IR`, () => r.blob(`${name}: full IR`, Buffer.from(c.domainIrAll())));
  // Every body's for a small ABC; for a large one, spread over it.
  const step = Math.max(1, Math.ceil(bodies / irs));
  for (let b = 0; b < bodies; b += step) {
    linked(c, r, `${name}: IR ${b}`, () => r.blob(`${name}: IR ${b}`, Buffer.from(c.domainIr(b))));
  }
}

/**
 * The JavaScript some bodies of the last ABC added compile to, each alone
 * (domainEmit): every body of a small ABC; of a large one, `count` spread
 * over it.
 */
function emitLast(c: Compiler, r: Results, name: string, count: number): void {
  let bodies = 0;
  linked(c, r, `${name}: verify`, () => {
    const text: string = c.domainVerifyAll();
    bodies = Number(/of (\d+) bodies$/.exec(text)?.[1] ?? 0);
    return r.blob(`${name}: verify`, Buffer.from(text));
  });
  const step = Math.max(1, Math.ceil(bodies / count));
  for (let b = 0; b < bodies; b += step) {
    linked(c, r, `${name}: emit ${b}`, () =>
      r.blob(`${name}: emit ${b}`, Buffer.from(c.domainEmit(b))),
    );
  }
}

/**
 * The module the last ABC added compiles to, a part at a time and kept,
 * its source map and entries, each entry's body compiled alone again, and
 * the module whole with hashes, linked only; parts of `budget` bytes.
 */
function moduleLast(c: Compiler, r: Results, name: string, budget: number): void {
  linked(c, r, `${name}: module`, () => {
    c.domainPartBudget(budget);
    // Each part copied as it is handed out: any call may grow memory.
    const parts = [handed(c, c.domainModuleBytes("", -1, true, false)).slice()];
    while (!c.domainModuleDone()) {
      parts.push(handed(c, c.domainModuleMoreBytes()).slice());
    }

    c.domainPartBudget(0);
    return r.blob(`${name}: module`, Buffer.concat(parts));
  });
  linked(c, r, `${name}: source map`, () =>
    r.blob(`${name}: source map`, Buffer.from(c.domainSourceMap())),
  );
  let bodies = "";
  linked(c, r, `${name}: entries`, () => {
    const entries: string = c.domainModuleEntries();
    // Each entry is its body's index, U+0001, its code, U+0002.
    bodies = entries
      .split("\u0002")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.slice(0, entry.indexOf("\u0001")))
      .join(",");
    return r.blob(`${name}: entries`, Buffer.from(entries));
  });
  linked(c, r, `${name}: each`, () =>
    r.blob(`${name}: each`, Buffer.from(c.domainEmitEach(bodies, budget % 2 === 0))),
  );
  linked(c, r, `${name}: linked only`, () =>
    r.blob(
      `${name}: linked only`,
      Buffer.from(c.domainModule("own\nfirst\nsecond", -1, false, true)),
    ),
  );
}

/**
 * What a host keys the last ABC added's module by, around compiling it:
 * the log the compile adds, as domainLogSince writes it, and that log
 * replayed; the context, whole, after the libraries' entries and up to
 * them; the key's header and the log of its application domain `child`
 * and the root in blocks; how far the child's log is its parent's; and
 * the revision. Every `count`-th ABC's module only is compiled.
 */
function keysLast(c: Compiler, r: Results, name: string, _count: number, child: number): void {
  const address = (a: number) => (a === 0 ? "none" : Buffer.from(handed(c, a)).toString("latin1"));
  linked(c, r, `${name}: compile`, () => {
    const mark: number = c.domainLogMark();
    const module = createHash("sha1")
      .update(c.domainModule("", -1, false, false))
      .digest("hex");
    const since: string = c.domainLogSince(mark, -1);
    return `${module} mark ${mark} since [${since}] replay ${c.domainReplay(since, -1)} again [${c.domainLogSince(mark, -1)}]`;
  });
  linked(c, r, `${name}: context`, () =>
    r.blob(
      `${name}: context`,
      Buffer.from(
        `${c.domainContext(-1, 0, -1)}\n--\n${c.domainContext(-1, 2, -1)}\n--\n${c.domainContext(-1, 0, 2)}`,
      ),
    ),
  );
  linked(c, r, `${name}: keys`, () =>
    r.blob(
      `${name}: keys`,
      Buffer.from(
        [
          address(c.domainKeyHeaderBytes(-1)),
          address(c.domainKeyLogBytes(child, 2, 0, -1, 3, 0)),
          address(c.domainKeyLogBytes(child, 0, 1, 7, 2, 1)),
          address(c.domainKeyLogBytes(0, 0, 0, -1, 0, 0)),
          `fork ${c.domainKeyFork(child)} ${c.domainKeyFork(0)} ${c.domainKeyFork(child + 1)}`,
          `revision ${c.domainRevision()}`,
        ].join("\n--\n"),
      ),
    ),
  );
}

/**
 * Each SWF's ABCs added into a child of the root, as linkSwfs adds them,
 * each verified (or what `each` does) after it is added; the domain made
 * again every 40 SWFs.
 */
function verifySwfs(
  c: Compiler,
  r: Results,
  base: Base,
  swfs: [string, [string, Uint8Array][]][],
  irs: number,
  each: (c: Compiler, r: Results, name: string, count: number, child: number) => void = verifyLast,
): void {
  const linking = new Linking(c, r);
  for (const [k, [swf, list]] of swfs.entries()) {
    if (k % 40 === 0) {
      linking.reset(`batch ${k}`, base);
      c.__collect();
    }

    let child = -1;
    r.case(`${swf}: child`, () => {
      child = c.domainChild(0);
      return child;
    });
    for (const [name, bytes] of list) {
      if (linking.link(name, bytes, child)) {
        each(c, r, name, irs, child);
      }
    }

    r.case(`${swf}: drop`, () => {
      c.domainDrop(child);
      return c.domainState(child);
    });
  }
}

/**
 * The link seeds and the tests' ABCs with bytes set in their method
 * bodies' code, mostly to opcodes and small operands, so that the
 * verifier meets what it rejects and what it types differently.
 */
function mutatedCode(count: number): [string, Uint8Array][] {
  const seeds = linkSeeds();
  const { below } = random(17);
  const found: [string, Uint8Array][] = [];
  for (let k = 0; k < count; k++) {
    const [name, seed] = seeds[below(seeds.length)];
    const bytes = seed.slice();
    for (let edits = 1 + below(3); edits > 0; edits--) {
      // The bodies come last in an ABC: its last quarter.
      const from = bytes.length - (bytes.length >> 2);
      const at = from + below(bytes.length - from);
      bytes[at] =
        below(3) === 0
          ? below(256)
          : [
              0x24, 0x2c, 0x30, 0x1d, 0x10, 0x11, 0x47, 0x48, 0x60, 0x66, 0x5d, 0x4f, 0x80, 0xd0,
              0xd5, 1, 2, 3,
            ][below(18)];
    }

    found.push([`${name} code ${k}`, bytes]);
  }

  return found;
}

/** An ABC's untyped decode, as a SWF's and as a library's. */
function codeDumps(c: Compiler, r: Results, name: string, bytes: Uint8Array): void {
  for (const builtin of [false, true]) {
    r.case(`${name}: code, builtin ${builtin}`, () =>
      r.blob(`${name}: code, builtin ${builtin}`, Buffer.from(c.codeDump(bytes, builtin))),
    );
  }
}

/** What the link suites call. */
const LINK_EXPORTS = [
  "domainReset",
  "domainAdd",
  "domainChild",
  "domainDrop",
  "domainState",
  "domainLinked",
  "domainUsage",
  "domainFind",
  "domainSummary",
  "domainTraits",
  "domainResolve",
  "domainBuiltins",
  "domainSlotTypes",
  "domainTraitsCount",
];

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
    name: "link-libraries",
    build: "testing",
    needs: LINK_EXPORTS,
    run: (c, r) => {
      const linking = new Linking(c, r);
      for (const [name, base] of Object.entries({ player: PLAYER, air: AIR, shell: SHELL })) {
        linking.reset(name, { version: base.version, libraries: [] });
        for (const [k, library] of base.libraries.entries()) {
          linking.link(`${name} library ${k}`, library, 0, true);
        }

        linking.summary(name);
        linking.finds(name, 0);
        c.__collect();
      }
    },
  },
  {
    name: "link-tests",
    build: "testing",
    needs: LINK_EXPORTS,
    run: (c, r) => {
      const linking = new Linking(c, r);
      const tests = abcs().slice(3);
      // Into the root, in turn, as a SWF's DoABCs load, and each into a child of its own.
      linking.reset("root", PLAYER);
      for (const [name, bytes] of tests) {
        linking.link(`${name} in the root`, bytes, 0);
      }

      linking.summary("root");
      linking.finds("root", 0);
      linkSwfs(
        c,
        r,
        PLAYER,
        linkSeeds().map(([name, bytes]) => [name, [[name, bytes]]]),
      );
    },
  },
  {
    name: "link-swfs",
    build: "testing",
    needs: LINK_EXPORTS,
    run: (c, r) => linkSwfs(c, r, PLAYER, bySwf(swfAbcs())),
  },
  {
    name: "link-oracle",
    build: "testing",
    needs: LINK_EXPORTS,
    unavailable: () => (existsSync(oracleDir()) ? null : "no oracle cache"),
    run: (c, r) => linkSwfs(c, r, SHELL, oracleAbcs()),
  },
  {
    name: "link-mutated",
    build: "testing",
    needs: LINK_EXPORTS,
    run: (c, r) =>
      linkSwfs(
        c,
        r,
        PLAYER,
        [...mutatedAbcs(2000), ...mutatedLinks(6000)].map(([name, bytes]) => [
          name,
          [[name, bytes]],
        ]),
      ),
  },
  {
    name: "link-sweep",
    build: "testing",
    needs: LINK_EXPORTS,
    run: (c, r) => {
      const cases: [string, [string, Uint8Array][]][] = [];
      for (const floats of [false, true]) {
        const seed = richAbc(floats);
        const name = floats ? "rich 47.16" : "rich 46.16";
        for (let n = 0; n <= seed.length; n++) {
          cases.push([`${name} cut ${n}`, [[`${name} cut ${n}`, seed.subarray(0, n)]]]);
        }

        for (let at = 0; at < seed.length; at++) {
          for (const v of [0, 1, 2, 0x7f, 0x80, 0xff, seed[at] ^ 1]) {
            if (v !== seed[at]) {
              const bytes = seed.slice();
              bytes[at] = v;
              cases.push([`${name} set ${at}=${v}`, [[`${name} set ${at}=${v}`, bytes]]]);
            }
          }
        }
      }

      linkSwfs(c, r, { version: API_VERSION, libraries: [builtinLibrary] }, cases);
      // The link ABCs' user one, against their builtin one, cut and set alike.
      const { builtin, user } = linkAbcs();
      const users: [string, [string, Uint8Array][]][] = [];
      for (let n = 0; n <= user.length; n++) {
        users.push([`user cut ${n}`, [[`user cut ${n}`, user.subarray(0, n)]]]);
      }

      for (let at = 0; at < user.length; at++) {
        for (const v of [0, 1, 2, 3, 4, 5, 6, 7, 0x80, 0xff]) {
          if (v !== user[at]) {
            const bytes = user.slice();
            bytes[at] = v;
            users.push([`user set ${at}=${v}`, [[`user set ${at}=${v}`, bytes]]]);
          }
        }
      }

      linkSwfs(c, r, { version: API_VERSION, libraries: [builtin] }, users);
    },
  },
  {
    name: "link-lifetimes",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainEvict", "domainRevive", "domainFound", "domainParent"],
    run: (c, r) => lifetimes(c, r, 150),
  },
  {
    name: "link-calls",
    build: "testing",
    needs: [
      ...LINK_EXPORTS,
      "domainEvict",
      "domainRevive",
      "domainFound",
      "domainParent",
      "domainRestore",
    ],
    run: (c, r) => calls(c, r, 200, 60),
  },
  {
    name: "link-deep",
    build: "testing",
    needs: LINK_EXPORTS,
    asStackLimit: true,
    run: async (_, r, fresh) => {
      for (const n of [2000, 8000, 20000]) {
        await deep(r, fresh, `extends chain ${n}`, chainAbc(n, false), [], n - 1);
      }

      for (const n of [500, 2000, 4000]) {
        await deep(r, fresh, `interface chain ${n}`, chainAbc(n, true), [], n - 1);
      }

      for (const n of [100, 2000, 8000, 20000]) {
        await deep(r, fresh, `TypeNames nested ${n}`, nestedAbc(n), [builtinLibrary], 0);
      }
    },
  },
  {
    name: "emit-deep",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainEmit"],
    asStackLimit: true,
    run: async (_, r, fresh) => {
      for (const n of [10, 100, 300, 498, 499, 500, 501, 2000, 20000]) {
        await deepEmit(r, fresh, `ifs nested ${n}`, nestedIfsAbc(n));
      }

      for (const n of [10, 300, 499, 500, 501, 2000]) {
        await deepEmit(r, fresh, `ifs chained ${n}`, chainedIfsAbc(n));
      }
    },
  },
  {
    name: "code-dumps",
    build: "testing",
    needs: ["codeDump"],
    run: (c, r) => {
      for (const [i, [name, bytes]] of [...everyAbc(), ...linkSeeds()].entries()) {
        codeDumps(c, r, name, bytes);
        if (i % 32 === 31) {
          c.__collect();
        }
      }
    },
  },
  {
    name: "code-mutated",
    build: "testing",
    needs: ["codeDump"],
    run: (c, r) => {
      for (const [i, [name, bytes]] of [...mutatedAbcs(2000), ...mutatedCode(8000)].entries()) {
        codeDumps(c, r, name, bytes);
        if (i % 32 === 31) {
          c.__collect();
        }
      }
    },
  },
  {
    name: "verify-libraries",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "domainIrAll"],
    run: (c, r) => {
      const linking = new Linking(c, r);
      for (const [name, base] of Object.entries({ player: PLAYER, air: AIR, shell: SHELL })) {
        linking.reset(name, { version: base.version, libraries: [] });
        for (const [k, library] of base.libraries.entries()) {
          if (linking.link(`${name} library ${k}`, library, 0, true)) {
            verifyLast(c, r, `${name} library ${k}`, 40);
          }
        }

        c.__collect();
      }
    },
  },
  {
    name: "verify-tests",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "domainIrAll"],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        linkSeeds().map(([name, bytes]) => [name, [[name, bytes]]]),
        64,
      ),
  },
  {
    name: "verify-swfs",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "domainIrAll"],
    run: (c, r) => verifySwfs(c, r, PLAYER, bySwf(swfAbcs()), 24),
  },
  {
    name: "verify-oracle",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "domainIrAll"],
    unavailable: () => (existsSync(oracleDir()) ? null : "no oracle cache"),
    run: (c, r) => verifySwfs(c, r, SHELL, oracleAbcs(), 8),
  },
  {
    name: "verify-mutated",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "domainIrAll"],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        mutatedCode(6000).map(([name, bytes]) => [name, [[name, bytes]]]),
        16,
      ),
  },
  {
    name: "verify-fuzz",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainCheckIr", "domainIr", "codeDump"],
    run: (c, r) => {
      // From the review of stage 4: structured bodies, linked after builtin alone.
      const base = { version: API_VERSION, libraries: [builtinLibrary] };
      const cases = structuredAbcs(4000, 1).map((bytes, k): [string, [string, Uint8Array][]] => [
        `structured ${k}`,
        [[`structured ${k}`, bytes]],
      ]);
      for (const [k, [name, [[, bytes]]]] of cases.entries()) {
        codeDumps(c, r, name, bytes);
        if (k % 64 === 63) {
          c.__collect();
        }
      }

      verifySwfs(c, r, base, cases, 5);
    },
  },
  {
    name: "emit-libraries",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    run: (c, r) => {
      const linking = new Linking(c, r);
      for (const [name, base] of Object.entries({ player: PLAYER, air: AIR, shell: SHELL })) {
        linking.reset(name, { version: base.version, libraries: [] });
        for (const [k, library] of base.libraries.entries()) {
          if (linking.link(`${name} library ${k}`, library, 0, true)) {
            emitLast(c, r, `${name} library ${k}`, 120);
          }
        }

        c.__collect();
      }
    },
  },
  {
    name: "emit-tests",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        linkSeeds().map(([name, bytes]) => [name, [[name, bytes]]]),
        256,
        emitLast,
      ),
  },
  {
    name: "emit-swfs",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    run: (c, r) => verifySwfs(c, r, PLAYER, bySwf(swfAbcs()), 48, emitLast),
  },
  {
    name: "emit-oracle",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    unavailable: () => (existsSync(oracleDir()) ? null : "no oracle cache"),
    run: (c, r) => verifySwfs(c, r, SHELL, oracleAbcs(), 32, emitLast),
  },
  {
    name: "emit-mutated",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        mutatedCode(3000).map(([name, bytes]) => [name, [[name, bytes]]]),
        16,
        emitLast,
      ),
  },
  {
    name: "emit-fuzz",
    build: "testing",
    needs: [...LINK_EXPORTS, "domainVerifyAll", "domainEmit"],
    run: (c, r) => {
      const base = { version: API_VERSION, libraries: [builtinLibrary] };
      const cases = structuredAbcs(2000, 1).map((bytes, k): [string, [string, Uint8Array][]] => [
        `structured ${k}`,
        [[`structured ${k}`, bytes]],
      ]);
      verifySwfs(c, r, base, cases, 8, emitLast);
    },
  },
  {
    name: "modules-tests",
    build: "testing",
    needs: [...LINK_EXPORTS, ...MODULE_EXPORTS],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        linkSeeds().map(([name, bytes]) => [name, [[name, bytes]]]),
        4096,
        moduleLast,
      ),
  },
  {
    name: "modules-swfs",
    build: "testing",
    needs: [...LINK_EXPORTS, ...MODULE_EXPORTS],
    run: (c, r) => verifySwfs(c, r, PLAYER, bySwf(swfAbcs()), 65536, moduleLast),
  },
  {
    name: "modules-oracle",
    build: "testing",
    needs: [...LINK_EXPORTS, ...MODULE_EXPORTS],
    unavailable: () => (existsSync(oracleDir()) ? null : "no oracle cache"),
    run: (c, r) => verifySwfs(c, r, SHELL, oracleAbcs(), 1 << 20, moduleLast),
  },
  {
    name: "modules-mutated",
    build: "testing",
    needs: [...LINK_EXPORTS, ...MODULE_EXPORTS],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        mutatedCode(3000).map(([name, bytes]) => [name, [[name, bytes]]]),
        2048,
        moduleLast,
      ),
  },
  {
    name: "keys-tests",
    build: "testing",
    needs: [...LINK_EXPORTS, ...KEY_EXPORTS],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        linkSeeds().map(([name, bytes]) => [name, [[name, bytes]]]),
        1,
        keysLast,
      ),
  },
  {
    name: "keys-swfs",
    build: "testing",
    needs: [...LINK_EXPORTS, ...KEY_EXPORTS],
    run: (c, r) => verifySwfs(c, r, PLAYER, bySwf(swfAbcs()), 1, keysLast),
  },
  {
    name: "keys-mutated",
    build: "testing",
    needs: [...LINK_EXPORTS, ...KEY_EXPORTS],
    run: (c, r) =>
      verifySwfs(
        c,
        r,
        PLAYER,
        mutatedCode(2000).map(([name, bytes]) => [name, [[name, bytes]]]),
        1,
        keysLast,
      ),
  },
  {
    name: "modules-plans",
    build: "testing",
    needs: [...LINK_EXPORTS, ...MODULE_EXPORTS],
    run: async (_, r, fresh) => {
      for (const seed of [7, 8, 9, 10]) {
        modulePlans(await fresh(), r, seed, 1500);
      }
    },
  },
  {
    name: "exports-random",
    build: "release",
    needs: [
      "domainReset",
      "domainAdd",
      "domainChild",
      "domainDrop",
      "domainEvict",
      "domainRevive",
      "domainState",
      "domainParent",
      "domainLinked",
      "domainUsage",
      ...MODULE_EXPORTS.filter((name) => name !== "domainEmitEach" && name !== "domainPartBudget"),
    ],
    run: async (_, r, fresh) => {
      for (const seed of [3, 4]) {
        exportCalls(await fresh(), r, seed, 20000);
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
/** A fresh instance of one of the three. */
async function instance(build: Suite["build"], compiler: string): Promise<Compiler> {
  switch (compiler) {
    case "zig":
      return build === "release" ? instantiateZig(modules.zig) : bindTesting(modules.zigTesting);
    case "poison":
      return bindTesting(modules.poison);
    default:
      return build === "release"
        ? instantiateAs(modules.as, { env: {} })
        : instantiateAsTesting(modules.asTesting, { env: {} });
  }
}

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
  await suite.run(fresh[aName], a, () => instance(suite.build, aName));
  await suite.run(fresh[bName], b, () => instance(suite.build, bName));
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
  const unavailable = suite.unavailable?.();
  if (unavailable) {
    report[suite.name] = `skipped: ${unavailable}`;
    console.log(`  ${suite.name}: skipped (${unavailable})`);
    continue;
  }

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
  for (const [compiler, made] of Object.entries(await instances(suite.build))) {
    results[compiler] = new Results(compiler);
    await suite.run(made, results[compiler], () => instance(suite.build, compiler));
    writeFileSync(join(out, `${suite.name}.${compiler}.txt`), results[compiler].lines.join("\n"));
  }

  if (suite.asStackLimit) {
    const ran = results.as.lines.flatMap((line, i) =>
      /: threw RangeError: Maximum call stack size exceeded/.test(line) ? [i] : [],
    );
    for (const i of ran) {
      results.as.lines[i] = results.zig.lines[i];
    }

    if (ran.length) {
      console.log(
        `  ${suite.name}: AssemblyScript's stack ran out at ${ran.length} cases, where Zig's went on: ${ran.map((i) => results.as.names[i]).join("; ")}`,
      );
    }
  }

  if (verifyErrors.size) {
    const counts = [...verifyErrors].sort((x, y) => Number(x[0]) - Number(y[0]));
    console.log(`  ${suite.name}: VerifyErrors ${counts.map(([e, n]) => `${e}:${n}`).join(" ")}`);
    verifyErrors.clear();
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
  } else if (!mismatches.length && !expected.includes(suite.name) && !suite.unavailable) {
    // A ratchet: what is the same is held so.
    console.log(`  ${suite.name} is the same now: add it to tests/parity/expected.json`);
    failed++;
  }
}

writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
if (failed > 0) {
  process.exitCode = 1;
}
