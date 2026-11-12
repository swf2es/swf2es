// A function that two methods create in different scope chains, as an
// obfuscator's copies of one helper do. avmplus verifies each method as it
// first runs: the first creator to run gives the function its scope chain,
// and another fails with VerifyError 1107 when it first runs, after what ran
// before it. avmshell prints what each case expects here.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 "", 3 ran, 4 Math, 5 PI. Namespace 1 public. Multinames 1 trace, 2 Math, 3 PI.
const pool = {
  strings: ["trace", "", "ran", "Math", "PI"],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(4)],
    [0x07, ...u30(1), ...u30(5)],
  ],
};

const POPSCOPE = 0x1d;
const PUSHNULL = 0x20;
const POP = 0x29;
const PUSHSTRING = 0x2c;
const PUSHSCOPE = 0x30;
const NEWFUNCTION = 0x40;
const CALL = 0x41;
const RETURNVOID = 0x47;
const CALLPROPVOID = 0x4f;
const FINDPROPSTRICT = 0x5d;
const GETLEX = 0x60;
const GETPROPERTY = 0x66;
const GETLOCAL0 = 0xd0;

/** Create function m and call it. */
const call = (m: number) => [NEWFUNCTION, m, PUSHNULL, CALL, 0, POP];

/**
 * A script initializer running `init`. Function 3 traces "ran"; function 1
 * creates and calls it in the script's scope chain, and function 2 does so
 * with its own `this` pushed as well, a longer chain. Function 3 then
 * pushes Math and creates and calls function 4, which traces PI: found on
 * Math by its place in the chain, which must be the same whichever of the
 * two chains function 3 runs in.
 */
function script(init: number[]): Uint8Array {
  const body = { localCount: 1, initScopeDepth: 1, maxScopeDepth: 1, maxStack: 2 };
  return abc(
    pool,
    tables({
      methods: [{}, {}, {}, {}, {}],
      scripts: [{ init: 0 }],
      bodies: [
        {
          ...body,
          method: 0,
          initScopeDepth: 0,
          code: [GETLOCAL0, PUSHSCOPE, ...init, RETURNVOID],
        },
        { ...body, method: 1, code: [...call(3), RETURNVOID] },
        {
          ...body,
          method: 2,
          maxScopeDepth: 2,
          code: [GETLOCAL0, PUSHSCOPE, ...call(3), POPSCOPE, RETURNVOID],
        },
        {
          ...body,
          method: 3,
          maxScopeDepth: 2,
          code: [
            ...[FINDPROPSTRICT, 1, PUSHSTRING, 3, CALLPROPVOID, 1, 1],
            ...[GETLEX, 2, PUSHSCOPE, ...call(4), POPSCOPE, RETURNVOID],
          ],
        },
        {
          ...body,
          method: 4,
          code: [
            FINDPROPSTRICT,
            1,
            FINDPROPSTRICT,
            3,
            GETPROPERTY,
            3,
            CALLPROPVOID,
            1,
            1,
            RETURNVOID,
          ],
        },
      ],
    }),
  );
}

/** What functions 3 and 4 trace. */
const ran = ["ran", "3.141592653589793"];

const builtins = () =>
  ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );

test("a function's creator that runs gives it its scope chain", { skip }, async () => {
  const lib = builtins();
  assert.deepEqual(await runSwf2es(lib, script([...call(1), NEWFUNCTION, 2, POP])), ran);
  assert.deepEqual(await runSwf2es(lib, script([NEWFUNCTION, 1, POP, ...call(2)])), ran);
});

test("a function's creator in another scope chain fails as it first runs", { skip }, async () => {
  const lib = builtins();
  const expected = [...ran, "VerifyError: Error #1107"];
  assert.deepEqual(await runSwf2es(lib, script([...call(1), ...call(2)])), expected);
  assert.deepEqual(await runSwf2es(lib, script([...call(2), ...call(1)])), expected);
});
