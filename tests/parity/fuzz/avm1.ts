// AVM1, from a review of the idiomatic pass: crafted Pushes of every shape
// (numbers at the edges, strings with every byte, registers and constants
// out of range) among actions that branch, define functions and wait for
// frames; the corpus's blocks with bytes changed, offsets and lengths that
// do not fit, and other versions; and the corpus's SWFs as they are. Each
// asked for everything the AVM1 exports give: the module, its entries and
// units, each block alone, each unit alone, held and released, and the
// first block's dump. Local SWFs (SWF2ES_LOCAL_SWFS) join the corpus,
// named by number.
import { type Avm1Swf, avm1Swfs } from "../../conformance/determinism-avm1.ts";
import { localAvm1 } from "../local.ts";
import type { Compiler, Results } from "../suite.ts";
import { count, type FuzzOptions, generator, type Live } from "./common.ts";

const handed = (t: Compiler, at: number) =>
  Buffer.from(new Uint8Array(t.memory.buffer, at >>> 0, t.outputLength())).toString("latin1");

/** Everything the AVM1 compiler gives for a SWF, as the parity tool asks it. */
function everything(t: Compiler, swf: Avm1Swf): string {
  const { bytes, offsets, lengths, version } = swf;
  const all = Array.from(offsets, (_, k) => k).join(",");
  const out: string[] = [];
  const step = (label: string, f: () => string) => {
    try {
      out.push(`${label} ${f()}`);
    } catch (error) {
      if (!/ran out of memory/.test((error as Error).message)) {
        throw error;
      }

      out.push(`${label} OOM`);
    }
  };
  step("module", () => handed(t, t.actionsModuleBytes(bytes, offsets, lengths, version, true)));
  step("entries", () => t.actionsModuleEntries());
  let units = "";
  step("units", () => {
    units = t.actionsModuleUnits();
    return units;
  });
  for (const reuse of [true, false]) {
    step(`each ${reuse}`, () =>
      handed(t, t.actionsEmitEachBytes(bytes, offsets, lengths, version, all, reuse)),
    );
  }

  step("each str", () => t.actionsEmitEach(bytes, offsets, lengths, version, all, false));
  const keys = units
    .split("\u0002")
    .map((item) => item.split("\u0001"))
    .filter((p) => p.length === 4)
    .map(([key, numbers]) => [key, numbers.split(",").map(Number)] as const);
  for (const [key, [at, end, bound, five]] of keys.slice(0, 40)) {
    step(
      `unit ${key}`,
      () =>
        `${handed(t, t.actionsUnitBytes(bytes, offsets, lengths, version, at, end, bound, five !== 0))} ${t.actionsUnitLimits().join(",")}`,
    );
  }

  step("held", () => {
    t.actionsHold(7, bytes, offsets, lengths);
    return String(t.actionsHeldCount());
  });
  step("held blocks", () => handed(t, t.actionsHeldEmitEachBytes(7, version, all)));
  for (const [key, [at, end, bound, five]] of keys.slice(0, 10)) {
    step(
      `held unit ${key}`,
      () =>
        `${handed(t, t.actionsHeldUnitBytes(7, version, at, end, bound, five !== 0))} ${t.actionsUnitLimits().join(",")}`,
    );
  }

  step("released", () => {
    t.actionsRelease(7);
    return String(t.actionsHeldCount());
  });
  step("dump", () =>
    offsets.length ? t.avm1Dump(bytes.subarray(offsets[0], offsets[0] + lengths[0])) : "",
  );
  return out.join("\n@@\n");
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const act = (op: number, operands: number[]) => [op, ...u16(operands.length), ...operands];

export async function avm1(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { random, below } = generator(o.seed);
  const corpus = avm1Swfs(true);
  const fromCorpus = corpus.length - avm1Swfs(false).length;
  const local = localAvm1();
  const swfs = [...corpus, ...local];
  r.input(
    `${swfs.length} SWFs, ${fromCorpus} of them the corpus's, ${local.length} local`,
    fromCorpus === 0 ? "no corpus fetched (tests/player/corpus/fetch-ruffle.ts)" : undefined,
  );
  // The corpus as it is, asked for more than the avm1 suite asks.
  for (const swf of swfs) {
    await live.case(r, swf.name, (t) => everything(t, swf));
  }

  const doubleBytes = (): number[] => {
    const b = Buffer.alloc(8);
    switch (below(12)) {
      case 0:
        b.writeDoubleLE(
          [
            0,
            -0,
            1,
            -1,
            0.1,
            1e21,
            1e-7,
            123456789012345680000,
            5e-324,
            1.7976931348623157e308,
            NaN,
            Infinity,
            -Infinity,
            0.000001,
            1e300,
            4294967296,
            2147483648,
            -2147483649,
            0.5,
            1 / 3,
          ][below(20)],
        );
        break;
      case 1:
        b.writeDoubleLE((random() - 0.5) * 10 ** (below(40) - 20));
        break;
      case 2:
        b.writeDoubleLE(Math.round((random() - 0.5) * 1e6));
        break;
      case 3:
        b.writeDoubleLE(2 ** (below(2100) - 1075));
        break;
      case 4:
        b.writeDoubleLE(below(1000) / 10 ** below(8));
        break;
      case 5:
        b.writeDoubleLE(Number((random() * 10 ** below(22)).toPrecision(1 + below(17))));
        break;
      default:
        for (let i = 0; i < 8; i++) {
          b[i] = below(256);
        }
    }

    // As a Push holds a double: the high word first.
    return [b[4], b[5], b[6], b[7], b[0], b[1], b[2], b[3]];
  };
  const strBytes = (): number[] => {
    const n = below(14);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = [
        below(256),
        34,
        39,
        92,
        10,
        13,
        9,
        8,
        12,
        11,
        0x7f,
        0x80,
        0xc2,
        0xe2,
        0x80,
        0xa8,
        0xa9,
        0xed,
        0xa0,
        0xbd,
        0xf0,
        0x9f,
        0x98,
        0x80,
        0xef,
        0xbf,
        0xbf,
        60,
        47,
        36,
        96,
      ][below(31)];
      out.push(c === 0 ? 1 : c);
    }

    return [...out, 0];
  };
  const pushItem = (): number[] => {
    switch (below(10)) {
      case 0:
        return [0, ...strBytes()];
      case 1: {
        const b = Buffer.alloc(4);
        if (below(3)) {
          b.writeFloatLE((random() - 0.5) * 10 ** (below(30) - 15));
        } else {
          for (let i = 0; i < 4; i++) {
            b[i] = below(256);
          }
        }

        return [1, ...b];
      }
      case 2:
        return [2];
      case 3:
        return [3];
      case 4:
        return [4, [0, 1, 2, 3, 4, 127, 128, 254, 255][below(9)]];
      case 5:
        return [5, below(3)];
      case 6:
        return [6, ...doubleBytes()];
      case 7: {
        const v = [
          0,
          1,
          -1,
          2147483647,
          -2147483648,
          255,
          256,
          65535,
          65536,
          below(0x7fffffff),
          -below(0x7fffffff),
        ][below(11)];
        const b = Buffer.alloc(4);
        b.writeInt32LE(v);
        return [7, ...b];
      }
      case 8:
        return [8, [0, 1, 2, 127, 128, 255][below(6)]];
      default:
        return [9, ...u16([0, 1, 255, 256, 65535, below(65536)][below(6)])];
    }
  };
  const craftedBlock = (): number[] => {
    const out: number[] = [];
    if (below(3) === 0) {
      const n = 1 + below(5);
      const items: number[] = [];
      for (let i = 0; i < n; i++) {
        items.push(...strBytes());
      }

      out.push(...act(0x88, [...u16(n), ...items]));
    }

    const n = 1 + below(8);
    for (let i = 0; i < n; i++) {
      const items: number[] = [];
      const k = 1 + below(4);
      for (let j = 0; j < k; j++) {
        items.push(...pushItem());
      }

      out.push(...act(0x96, items));
      switch (below(14)) {
        case 0:
          out.push(0x26); // trace
          break;
        case 1:
          out.push(...act(0x87, [[0, 1, 3, 4, 254, 255][below(6)]])); // store register
          break;
        case 2:
          out.push(0x1c); // get variable
          break;
        case 3:
          out.push(0x1d); // set variable
          break;
        case 4:
          out.push(...act(0x81, u16(below(65536)))); // goto frame
          break;
        case 5:
          out.push(...act(0x8c, strBytes())); // goto label
          break;
        case 6:
          out.push(...act(0x83, [...strBytes(), ...strBytes()])); // get url
          break;
        case 7:
          out.push(...act(0x8b, strBytes())); // set target
          break;
        case 8:
          out.push(...act(0x9d, u16([0, 1, 5, 0xffff, 0x8000, below(65536)][below(6)]))); // if
          break;
        case 9:
          out.push(...act(0x99, u16([0, 1, 0xfffb, below(65536)][below(4)]))); // jump
          break;
        case 10:
          out.push(...act(0x9b, [...strBytes(), ...u16(1), ...strBytes(), ...u16(1)]), 0x00); // define function
          break;
        case 11:
          out.push(...act(0x8a, [...u16(below(65536)), below(256)])); // wait for frame
          break;
        case 12:
          out.push(0x4e, 0x4f, 0x47, 0x0a, 0x0b, 0x0c, 0x0d);
          break;
        default:
          out.push(0x17);
      }
    }

    out.push(0x00);
    return out;
  };
  const crafted = count(o, 1500, 1500);
  for (let c = 0; c < crafted; c++) {
    const blocksOf: number[][] = [];
    const n = 1 + below(4);
    for (let i = 0; i < n; i++) {
      blocksOf.push(craftedBlock());
    }

    const bytes = new Uint8Array(blocksOf.flat());
    const offsets: number[] = [];
    let at = 0;
    for (const b of blocksOf) {
      offsets.push(at);
      at += b.length;
    }

    const swf: Avm1Swf = {
      name: `crafted ${c}`,
      bytes,
      version: [4, 5, 6, 7, 8, 10, 3, 1, 32][below(9)],
      offsets: Int32Array.from(offsets),
      lengths: Int32Array.from(blocksOf, (b) => b.length),
    };
    await live.case(r, swf.name, (t) => everything(t, swf));
  }

  // The corpus's blocks with bytes changed, and offsets and lengths that do not fit.
  const mutations = count(o, 3000, 3000);
  for (let c = 0; c < mutations; c++) {
    const from = swfs[below(swfs.length)];
    if (from.bytes.length === 0 || from.offsets.length === 0) {
      continue;
    }

    const bytes = from.bytes.slice();
    const edits = 1 + below(4);
    for (let e = 0; e < edits; e++) {
      const k = below(from.offsets.length);
      const start = from.offsets[k];
      const len = from.lengths[k];
      if (len <= 0) {
        continue;
      }

      const at = start + below(len);
      switch (below(5)) {
        case 0:
          bytes[at] = below(256);
          break;
        case 1:
          bytes[at] ^= 1 << below(8);
          break;
        case 2:
          bytes[at] = [
            0, 1, 0x7f, 0x80, 0xff, 0x96, 0x99, 0x9d, 0x8e, 0x8f, 0x94, 0x9b, 0x88, 0x87,
          ][below(14)];
          break;
        case 3:
          bytes[at] = (bytes[at] + 1) & 255;
          break;
        default:
          bytes[at] = (bytes[at] + 255) & 255;
      }
    }

    let offsets = from.offsets;
    let lengths = from.lengths;
    if (random() < 0.1) {
      offsets = Int32Array.from(offsets, (x) => (random() < 0.3 ? x + below(5) - 2 : x));
      lengths = Int32Array.from(lengths, (x) => (random() < 0.3 ? x + below(9) - 4 : x));
    }

    const swf: Avm1Swf = {
      name: from.name,
      bytes,
      version: random() < 0.2 ? [3, 4, 5, 6, 7, 8, 9, 10, 15][below(9)] : from.version,
      offsets,
      lengths,
    };
    await live.case(r, `mutated ${c}`, (t) => everything(t, swf));
  }
}
