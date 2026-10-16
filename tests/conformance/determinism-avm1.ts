// determinism.ts's checks for AVM1: a SWF's action blocks compile to the
// same module, byte for byte, however the compiler got there, and each
// block compiled alone, as a JIT may compile it when it first runs, to its
// entry in the module. Each SWF's blocks are compiled
//
//   - in an instance of their own (the reference);
//   - in one instance, after all the SWFs before them;
//   - in one instance, in the reverse order, each SWF twice in a row;
//   - in the build that checks every array access;
//   - in the release build, codegen.wasm, through the package's API;
//
// then each block alone, in order with a new emitter each, and in the
// reverse order with one for all. The SWFs are blocks the tests assemble,
// at SWF 5 and 10, and the AVM1 SWFs of Ruffle's corpus where it is
// fetched (tests/player/corpus/fetch-ruffle.ts; not in CI).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createCodegen } from "../../packages/codegen/dist/index.js";
import { isAs3, readActions, readSwf } from "../../packages/format/dist/index.js";
import { Avm1Assembler, constant, register, Simple } from "../avm1-assembler.ts";
import { testingInstances } from "../unit/codegen/testing-module.ts";

interface Avm1Swf {
  name: string;
  bytes: Uint8Array;
  version: number;
  offsets: Int32Array;
  lengths: Int32Array;
}

const corpus = new URL("../player/corpus/ruffle/tests/tests/swfs/", import.meta.url);

/** Blocks laid one after the other as a SWF's bytes. */
function assembled(name: string, version: number, blocks: Uint8Array[]): Avm1Swf {
  const bytes = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  const offsets: number[] = [];
  let at = 0;
  for (const block of blocks) {
    bytes.set(block, at);
    offsets.push(at);
    at += block.length;
  }

  return {
    name,
    bytes,
    version,
    offsets: Int32Array.from(offsets),
    lengths: Int32Array.from(blocks, (b) => b.length),
  };
}

/** The tests' blocks: every action the emitter writes, nested regions, and malformed input. */
function testBlocks(): Uint8Array[] {
  const asm = () => new Avm1Assembler();
  const body = asm().push("body").trace().bytes();
  // A With whose body jumps back before the With, opening it again.
  const reopening = asm()
    .label("top")
    .push("x")
    .action(0x94, [8, 0])
    .push(true)
    .raw([0x9d, 2, 0, 0xf0, 0xff])
    .bytes();
  return [
    asm().push("hello").trace().stop().bytes(),
    asm()
      .constantPool("a", "b", "é")
      .label("top")
      .push(constant(0), constant(2), constant(300), 1.5, null, undefined, false)
      .trace()
      .pop()
      .push(true)
      .if("top")
      .constantPool("c")
      .push(constant(0))
      .jump("end")
      .play()
      .label("end")
      .trace()
      .bytes(),
    asm()
      .action(0x9b, [0x66, 0, 0, 0, body.length, 0])
      .raw([...body])
      .action(0x8f, [3, 2, 0, 2, 0, 2, 0, 0x65, 0])
      .raw([0x06, 0x07, 0x06, 0x07, 0x06, 0x07])
      .push(register(1))
      .action(0x1c)
      .bytes(),
    reopening,
    // DefineFunction2 with its registers, preloads and parameters, a nested one, StoreRegister
    // and Return; and a function whose body jumps back before its DefineFunction.
    asm()
      .defineFunction2(
        "f",
        5,
        0x1ff,
        [
          ["a", 4],
          ["b", 0],
          ["c", 9],
        ],
        asm()
          .push(register(1), register(4), register(6))
          .storeRegister(2)
          .storeRegister(7)
          .defineFunction2(
            "",
            2,
            0x05,
            [["x", 1]],
            asm().push(register(1), register(3)).op("Return"),
          )
          .op("Return"),
      )
      .push(register(2))
      .storeRegister(0)
      .op("Return")
      .bytes(),
    asm().action(0x9b, [0, 0, 0, 5, 0]).raw([0x99, 2, 0, 0xf3, 0xff]).bytes(),
    // Withs and Trys: jumps out of their bodies, a catch into a variable and one into a
    // register of a DefineFunction2, a Return through a finally, and a Throw.
    asm()
      .label("top")
      .push("o")
      .with("w")
      .push("in")
      .trace()
      .push(true)
      .if("top")
      .jump("out")
      .label("w")
      .try("e", "c", "f", "t")
      .push("x")
      .op("Throw")
      .label("c")
      .push("e")
      .with("cw")
      .push(1)
      .label("cw")
      .label("f")
      .push(2)
      .jump("out")
      .label("t")
      .defineFunction2(
        "g",
        3,
        0,
        [],
        asm()
          .try(register(2), "gc", "gf", "gt")
          .push("r")
          .op("Return")
          .label("gc")
          .push(register(2))
          .trace()
          .label("gf")
          .push("finally")
          .trace()
          .label("gt"),
      )
      .label("out")
      .trace()
      .bytes(),
    // Every action without operands that goes on to the next, each operator among them.
    Object.entries(Simple)
      .filter(([name]) => !["End", "Return", "Throw"].includes(name))
      .reduce((a, [, op]) => a.push(1, "2", 3).action(op), asm())
      .bytes(),
    new Uint8Array([0xc3, 0xa9, 0x80, 0x96, 4, 0, 0, 0xe2, 0x82, 0, 0x26, 0x96, 9, 0, 7, 1]),
    new Uint8Array(0),
  ];
}

function corpusSwfs(): Avm1Swf[] {
  if (!existsSync(corpus)) {
    return [];
  }

  const swfs: Avm1Swf[] = [];
  const names = readdirSync(corpus, { recursive: true, encoding: "utf8" })
    .filter((n) => n.endsWith(".swf"))
    .sort();
  for (const name of names) {
    let swf: ReturnType<typeof readSwf>;
    try {
      swf = readSwf(new Uint8Array(readFileSync(new URL(name, corpus))));
    } catch {
      continue;
    }

    if (isAs3(swf)) {
      continue;
    }

    const { version, blocks } = readActions(swf);
    if (blocks.length > 0) {
      swfs.push({
        name,
        bytes: swf.bytes,
        version,
        offsets: Int32Array.from(blocks, (b) => b.offset),
        lengths: Int32Array.from(blocks, (b) => b.length),
      });
    }
  }

  return swfs;
}

/** Entries as actionsModuleEntries and actionsEmitEach write them: index, U+0001, entry, U+0002. */
function parseEntries(text: string): Map<number, string> {
  const entries = new Map<number, string>();
  for (const item of text.split("\u0002")) {
    const at = item.indexOf("\u0001");
    if (at > 0) {
      entries.set(Number(item.slice(0, at)), item.slice(at + 1));
    }
  }

  return entries;
}

const utf8 = new TextDecoder();

/** The SWFs compared in every way: how many, how many blocks, and how many differ. */
export async function avm1Determinism(): Promise<{
  swfs: number;
  blocks: number;
  differences: number;
}> {
  const tests = testBlocks();
  const swfs = [
    assembled("the tests' blocks, SWF 5", 5, tests),
    assembled("the tests' blocks, SWF 10", 10, tests),
    ...corpusSwfs(),
  ];
  let differences = 0;
  const differ = (swf: Avm1Swf, way: string, got: string, want: string) => {
    if (got === want) {
      return;
    }

    differences++;
    const a = got.split("\n");
    const b = want.split("\n");
    let line = 0;
    while (line < a.length && a[line] === b[line]) {
      line++;
    }

    console.log(`DIFF ${swf.name}, ${way}: differs at line ${line + 1}`);
    console.log(`  got:  ${(a[line] ?? "(end)").slice(0, 160)}`);
    console.log(`  want: ${(b[line] ?? "(end)").slice(0, 160)}`);
  };
  // biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
  const module = (testing: any, swf: Avm1Swf, keep = false) =>
    utf8.decode(testing.actionsModuleBytes(swf.bytes, swf.offsets, swf.lengths, swf.version, keep));

  const fresh = await testingInstances("dist-test");
  const reference = new Map<Avm1Swf, string>();
  const entries = new Map<Avm1Swf, Map<number, string>>();
  for (const swf of swfs) {
    const testing = await fresh();
    reference.set(swf, module(testing, swf, true));
    entries.set(swf, parseEntries(testing.actionsModuleEntries()));
  }

  const oneInstance = async (way: string, instance: () => Promise<unknown>, order: Avm1Swf[]) => {
    const testing = await instance();
    for (const swf of order) {
      differ(swf, way, module(testing, swf), reference.get(swf) ?? "");
    }
  };
  await oneInstance("after the SWFs before it", fresh, swfs);
  await oneInstance(
    "in reverse, twice in a row",
    fresh,
    [...swfs].reverse().flatMap((s) => [s, s]),
  );
  await oneInstance("in the checked build", await testingInstances("dist-test-checked"), swfs);

  const wasm = new URL("../../packages/codegen/dist/codegen.wasm", import.meta.url);
  const codegen = await createCodegen(await WebAssembly.compile(readFileSync(wasm)));
  for (const swf of swfs) {
    const blocks = [...swf.offsets].map((offset, k) => ({ offset, length: swf.lengths[k] }));
    const got = codegen.compileActionsModule(swf.bytes, { version: swf.version, blocks });
    differ(swf, "in the release build", got, reference.get(swf) ?? "");
  }

  // The JIT/AOT invariant: each block alone, byte for byte its entry.
  const testing = await fresh();
  let blocks = 0;
  for (const swf of swfs) {
    const want = entries.get(swf) ?? new Map();
    const indices = [...want.keys()];
    for (const [way, order, reuse] of [
      ["alone, in order", indices, false],
      ["alone, in reverse, one emitter", [...indices].reverse(), true],
    ] as const) {
      const got = parseEntries(
        testing.actionsEmitEach(
          swf.bytes,
          swf.offsets,
          swf.lengths,
          swf.version,
          order.join(","),
          reuse,
        ),
      );
      for (const k of indices) {
        if (got.get(k) !== want.get(k)) {
          differ(swf, `block ${k} ${way}`, got.get(k) ?? "(none)", want.get(k) ?? "");
          break;
        }
      }
    }

    blocks += indices.length;
  }

  return { swfs: swfs.length, blocks, differences };
}
