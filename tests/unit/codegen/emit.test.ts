import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { s24, script } from "./ir-cases.ts";
import { testing } from "./testing-module.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

/** Just what these methods call. */
const rt = {
  greaterThan: (a: number, b: number) => a > b,
  caught: (e: unknown) => e,
  unreachable: () => new Error("unreachable"),
};

/** The script initializer of `abc`, compiled and run with `this` as its global; its result. */
function run(abc: Uint8Array): unknown {
  testing.domainReset(50);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  assert.equal(testing.domainAdd(abc, false), 0);
  const js = testing.domainEmit(0) as string;
  return new Function("rt", `return ${js}`)(rt).call({});
}

const PUSHBYTE = 0x24;
const LABEL = 0x09;
const IFGT = 0x17;
const LSHIFT = 0xa5;
const SUBTRACT_I = 0xc6;
const ADD = 0xa0;
const ADD_I = 0xc5;
const DECLOCAL_I = 0xc3;
const RETURNVALUE = 0x48;
const THROW = 0x03;
const GETLOCAL1 = 0xd1;
const GETLOCAL2 = 0xd2;
const GETLOCAL3 = 0xd3;
const SETLOCAL1 = 0xd5;
const SETLOCAL2 = 0xd6;
const SETLOCAL3 = 0xd7;

test("locals and arithmetic run as plain JavaScript", { skip }, () => {
  const code = [PUSHBYTE, 7, SETLOCAL1, PUSHBYTE, 5, SETLOCAL2, GETLOCAL1, GETLOCAL2, ADD];
  assert.equal(run(script([...code, SETLOCAL3, GETLOCAL3, RETURNVALUE])), 12);
});

test("int arithmetic wraps as avmplus' does", { skip }, () => {
  // (1 << 31) - 1, in int: -2147483648 - 1 wraps to 2147483647.
  const code = [PUSHBYTE, 1, PUSHBYTE, 31, LSHIFT, PUSHBYTE, 1, SUBTRACT_I, RETURNVALUE];
  assert.equal(run(script(code)), 2147483647);
});

test("a loop runs through its blocks until its branch falls through", { skip }, () => {
  // sum = 0; i = 10; do { sum += i; i-- } while (i > 0); return sum
  // 6: label; 16: ifgt back to 6 (next 20, offset -14).
  const code = [
    PUSHBYTE,
    0,
    SETLOCAL1,
    PUSHBYTE,
    10,
    SETLOCAL2,
    LABEL,
    GETLOCAL1,
    GETLOCAL2,
    ADD_I,
    SETLOCAL1,
    DECLOCAL_I,
    2,
    GETLOCAL2,
    PUSHBYTE,
    0,
    IFGT,
    ...s24(-14),
    GETLOCAL1,
    RETURNVALUE,
  ];
  assert.equal(run(script(code)), 55);
});

test("a throw in a handler's range runs the handler, with the exception on the stack", {
  skip,
}, () => {
  // 0: pushbyte 7; 2: throw; 3: returnvalue, the handler of 0 up to 3, for any type.
  const code = [PUSHBYTE, 7, THROW, RETURNVALUE];
  assert.equal(run(script(code, { exceptions: [[0, 3, 3, 0, 0]] })), 7);
});

test("a throw past a handler's range goes on to the caller", { skip }, () => {
  // The handler covers 0 up to 2, so not the throw at 2.
  const code = [PUSHBYTE, 7, THROW, RETURNVALUE];
  assert.throws(
    () => run(script(code, { exceptions: [[0, 2, 3, 0, 0]] })),
    (e) => e === 7,
  );
});

/** The module of `name`, added to the domain, as a function of `rt` whose body parses. */
function module(name: string, builtin: boolean): string {
  assert.equal(
    testing.domainAdd(new Uint8Array(readFileSync(new URL(name, generated))), builtin),
    0,
  );
  const js = testing.domainModule() as string;
  const body = js.replace(/^export default function \(rt\) \{/, "").replace(/\}\s*$/, "");
  assert.doesNotThrow(() => new Function("rt", body), `${name} parses`);
  return js;
}

test("the builtins compile to modules with every instruction lowered", { skip }, () => {
  testing.domainReset(50);
  for (const name of ["builtin.abc", "shell_toplevel.abc"]) {
    const js = module(name, true);
    assert.deepEqual(js.match(/rt\.unsupported\("[^"]*"\)/g) ?? [], [], name);
    assert.equal(js.match(/rt\.unverified/g), null, `${name} has every method verified`);
  }
});

test("an ABC compiled again gives the same module", { skip }, () => {
  testing.domainReset(50);
  const first = module("builtin.abc", true);
  assert.equal(testing.domainModule(), first);
});
