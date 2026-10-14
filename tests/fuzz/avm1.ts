// Fuzzes codegen's AVM1 decoder and flow (packages/codegen/assembly/avm1/)
// with random and mutated action blocks. The JIT decodes whatever a SWF
// holds, so for any bytes the decoder must finish without trapping: a trap
// kills the wasm instance. For each case,
//
//   - the decoder did not trap (with SWF2ES_CHECKED, nor read past an array);
//   - each region lists an action at most once among its blocks;
//   - the block decodes to the same regions again, after other blocks, as
//     the JIT/AOT invariant asks (docs/architecture.md).
//
// The seeds are blocks generated from the actions' grammar, nested bodies
// and branches included, and a few shapes at the edges: bodies that jump
// back before their own start, long WaitForFrame chains, deep nesting, and
// blocks that read the same bytes from many offsets. A case that fails is
// written to out/failures/ as a .avm1 file of the block's bytes. The generator is seeded, so a run repeats exactly:
//
//   node tests/fuzz/avm1.ts [cases, 2000] [seed, 1]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadTesting } from "../unit/codegen/testing-module.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const caseCount = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);

/** mulberry32: a small generator whose sequence the seed fixes. */
function generator(start: number): () => number {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = generator(seed);
const below = (n: number) => Math.floor(random() * n);
const pick = <T>(items: readonly T[]): T => items[below(items.length)];

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const str = (s: string) => [...Buffer.from(s, "latin1"), 0];
const act = (op: number, operands: number[]) => [op, ...u16(operands.length), ...operands];
const name = () => str(pick(["", "a", "_root", "this", "x.y", "/a:b"]));

// Actions without operands, Flash's and a few it does not know.
const SIMPLE = [
  0x00, 0x04, 0x06, 0x07, 0x0a, 0x0b, 0x0e, 0x12, 0x17, 0x1c, 0x1d, 0x20, 0x26, 0x2a, 0x3d, 0x3e,
  0x40, 0x42, 0x43, 0x46, 0x47, 0x49, 0x4c, 0x4d, 0x4e, 0x4f, 0x52, 0x55, 0x66, 0x69, 0x01, 0x7f,
];
// Bytes at the edges of what the fields hold.
const EDGES = [0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x96, 0x99, 0x9d, 0x8e, 0x8f, 0x94];

function pushValue(): number[] {
  switch (below(11)) {
    case 0:
      return [0, ...name()];
    case 1:
      return [1, below(256), below(256), below(256), below(256)];
    case 2:
      return [6, ...Array.from({ length: 8 }, () => below(256))];
    case 3:
      return [7, below(256), below(256), below(256), below(256)];
    case 4:
      return [4, below(8)];
    case 5:
      return [5, below(2)];
    case 6:
      return [8, below(256)];
    case 7:
      return [9, below(256), below(4)];
    case 8:
      return [below(256)];
    default:
      return [pick([2, 3])];
  }
}

/** A run of actions, about `size` of them, nested `depth` bodies deep at most. */
function actions(size: number, depth: number): number[] {
  const bytes: number[] = [];
  for (let k = 0; k < size; k++) {
    const roll = below(20);
    if (roll < 6) {
      bytes.push(pick(SIMPLE));
    } else if (roll < 10) {
      const values = Array.from({ length: 1 + below(3) }, pushValue).flat();
      bytes.push(...act(0x96, values));
    } else if (roll < 13) {
      // A jump anywhere near, into an action's middle or out of the block.
      const offset = below(2)
        ? below(bytes.length + 8) - bytes.length - 5
        : below(0x10000) - 0x8000;
      bytes.push(...act(pick([0x99, 0x9d]), u16(offset & 0xffff)));
    } else if (roll < 14) {
      bytes.push(...act(pick([0x8a, 0x8d]), [...(below(2) ? u16(below(4)) : []), below(6)]));
    } else if (roll < 15) {
      bytes.push(...act(0x88, [...u16(3), ...name(), ...name(), ...name()]));
    } else if (roll < 18 && depth > 0) {
      const body = actions(1 + below(size), depth - 1);
      switch (below(4)) {
        case 0:
          bytes.push(...act(0x9b, [...name(), ...u16(1), ...name(), ...u16(body.length)]), ...body);
          break;
        case 1: {
          const header = [
            ...name(),
            ...u16(1),
            below(8),
            ...u16(below(0x10000)),
            below(4),
            ...name(),
          ];
          bytes.push(...act(0x8e, [...header, ...u16(body.length)]), ...body);
          break;
        }
        case 2:
          bytes.push(...act(0x94, u16(body.length)), ...body);
          break;
        default: {
          const split = [below(body.length + 1), below(body.length + 1)].sort((a, b) => a - b);
          const flags = below(8);
          const sizes = [split[0], split[1] - split[0], body.length - split[1]];
          const header = [flags, ...sizes.flatMap(u16), ...(flags & 4 ? [below(4)] : name())];
          bytes.push(...act(0x8f, header), ...body);
          break;
        }
      }
    } else {
      const op = pick([0x81, 0x83, 0x87, 0x8b, 0x8c, 0x9a, 0x9e, 0x9f, 0xa0, 0xff]);
      bytes.push(
        ...act(
          op,
          Array.from({ length: below(5) }, () => below(256)),
        ),
      );
    }
  }

  return bytes;
}

/** Edge shapes: bodies that jump back before themselves, chained skips, deep nesting, rereading. */
function edges(): number[][] {
  const leaving: number[] = [];
  for (let k = 0; k < 2500; k++) {
    // A With whose body jumps back to the block's start, leaving it.
    const body = act(0x99, u16(-(leaving.length + 10) & 0xffff));
    leaving.push(...act(0x94, u16(body.length)), ...body);
  }

  const reopening: number[] = [];
  for (let k = 0; k < 2500; k++) {
    // A function whose body jumps back to the block's start, running it all
    // and defining every function again.
    const body = act(0x99, u16(-(reopening.length + 13) & 0xffff));
    reopening.push(...act(0x9b, [0, ...u16(0), ...u16(body.length)]), ...body);
  }

  let nested: number[] = [0x26];
  for (let k = 0; k < 3000; k++) {
    nested = [...act(0x94, u16(nested.length)), ...nested];
  }

  const skips = Array.from({ length: 5000 }, () => act(0x8d, [255])).flat();
  return [leaving, reopening, nested, skips, rereading(0x8c), rereading(0x96)];
}

/**
 * Ifs into each offset of a long run of `fill` without a zero: as
 * GotoLabels, each looks through the rest for its string's zero; as
 * Pushes, each reads tens of kilobytes of values it skips.
 */
function rereading(fill: number): number[] {
  const ifs = 2000;
  const bytes: number[] = new Array(5 * ifs + 0x10000).fill(fill);
  for (let k = 0; k < ifs; k++) {
    const offset = 5 * ifs + k - (5 * k + 5);
    bytes.splice(5 * k, 5, ...act(0x9d, u16(offset)));
  }

  return bytes;
}

/**
 * A few mutations of `block`: bytes flipped, set to edge values, inserted,
 * deleted or copied from elsewhere, or the block cut short.
 */
function mutate(block: number[]): Uint8Array {
  const bytes = [...block];
  const count = 1 + below(4);
  for (let m = 0; m < count; m++) {
    const n = bytes.length;
    if (n === 0) {
      break;
    }

    const at = below(n);
    switch (below(7)) {
      case 0:
        bytes[at] ^= 1 << below(8);
        break;
      case 1:
        bytes[at] = pick(EDGES);
        break;
      case 2:
        bytes.splice(at, 0, below(256));
        break;
      case 3:
        bytes.splice(at, 1 + below(4));
        break;
      case 4: {
        const from = below(n);
        bytes.splice(at, 0, ...bytes.slice(from, from + 1 + below(16)));
        break;
      }
      case 5:
        bytes.length = at;
        break;
      default:
        bytes[at] = below(256);
        break;
    }
  }

  return new Uint8Array(bytes);
}

const seeds = [...edges(), ...Array.from({ length: 64 }, () => actions(1 + below(40), 3))];
const build = process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test";
let testing = await loadTesting(build);
const failures: string[] = [];
let tooLarge = 0;
let slowest = { ms: 0, at: -1 };

function fail(block: Uint8Array, why: string): void {
  mkdirSync(`${out}failures`, { recursive: true });
  const file = `${out}failures/${createHash("sha256").update(block).digest("hex").slice(0, 16)}.avm1`;
  writeFileSync(file, block);
  failures.push(`${why}: ${file}`);
}

const started = Date.now();
let previous: { block: Uint8Array; check: string } | null = null;
for (let k = 0; k < caseCount; k++) {
  const seedBlock = seeds[below(seeds.length)];
  const block = k < seeds.length ? new Uint8Array(seeds[k]) : mutate(seedBlock);
  const t0 = performance.now();
  try {
    const check: string = testing.avm1Check(block);
    if (check === "too large") {
      tooLarge++;
    } else if (check.startsWith("repeated")) {
      fail(block, `an action in two blocks of one region (${check})`);
    }

    // The block before this one, decoded again after it.
    if (previous && testing.avm1Check(previous.block) !== previous.check) {
      fail(previous.block, "decodes differently after another block");
    }

    previous = { block, check };
  } catch (e) {
    // A trap leaves the instance unusable: start a new one.
    fail(block, `the decoder trapped (${(e as Error).message})`);
    testing = await loadTesting(build);
    previous = null;
  } finally {
    const ms = performance.now() - t0;
    if (ms > slowest.ms) {
      slowest = { ms, at: k };
    }
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const summary = `${caseCount} cases from ${seeds.length} seeds (seed ${seed}), ${tooLarge} too large, slowest ${slowest.ms.toFixed(0)} ms`;
if (failures.length) {
  console.log(failures.slice(0, 20).join("\n"));
  console.log(`fuzz avm1: ${failures.length} failed of ${summary} (${seconds} s)`);
  process.exit(1);
}

console.log(`fuzz avm1: ${summary}, all well (${seconds} s)`);
