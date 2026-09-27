import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { testing } from "./testing-module.ts";

const tbl = new URL("../../../oracle/avmplus/core/opcodes.tbl", import.meta.url);

// Operand counts as opcodes.tbl states them, per operand layout.
const COUNT = { none: 0, u30: 1, u30u30: 2, branch: 1, byte: 1, short: 1, debug: 4, switch: 2 };
const LAYOUTS = ["none", "u30", "u30u30", "branch", "byte", "short", "debug", "switch"] as const;
const ILLEGAL = 0xff;
const THROWS = 1;
const TERMINAL = 2;

const ours = (testing.opcodeTable() as string).split("\n").map((line) => {
  const [opcode, name, layout, flags] = line.split(" ");
  return { opcode: Number(opcode), name, layout: Number(layout), flags: Number(flags) };
});

test("defines exactly the opcodes avmplus accepts in ABC 46.16", { skip: !existsSync(tbl) }, () => {
  // ABC_OP(opCount, throw, stack, internal, name) // 0xNN; ABC_OP_F entries
  // are the float instructions of ABC 47.16.
  const entries = readFileSync(tbl, "utf8").matchAll(
    /^(ABC_OP|ABC_OP_F|ABC_UNUSED_OP)\(\s*(-?\d+),\s*(\d+),\s*-?\d+,\s*(\d+),\s*(\w+)\)\s*\/\/\s*0x([0-9A-F]{2})/gm,
  );

  let checked = 0;
  for (const [, kind, count, throws, internal, name, hex] of entries) {
    const op = ours[Number.parseInt(hex, 16)];
    const legal = kind === "ABC_OP" && Number(count) >= 0 && internal === "0";
    checked++;

    if (!legal) {
      assert.equal(op.layout, ILLEGAL, `0x${hex} ${name} should be illegal`);
      continue;
    }

    assert.equal(op.name, name, `0x${hex}`);
    assert.notEqual(op.layout, ILLEGAL, name);
    assert.equal(COUNT[LAYOUTS[op.layout]], Number(count), `${name} operand count`);
    assert.equal(Boolean(op.flags & THROWS), throws === "1", `${name} can throw`);
  }

  assert.equal(checked, 256);
});

test("the terminal instructions never fall through", () => {
  const terminal = ours.filter((op) => op.flags & TERMINAL).map((op) => op.name);
  assert.deepEqual(terminal.sort(), ["jump", "lookupswitch", "returnvalue", "returnvoid", "throw"]);
});
