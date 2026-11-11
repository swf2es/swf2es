// A function that pushes its `this` as a scope, which ASC never writes, and
// looks up a name its type, Object, does not bind. The verifier finds the
// name on no scope, but avmplus searches again at run time (its JIT turns
// findpropglobal back into findproperty), asking each local scope's traits
// as it is then: called on an Array, `length` is the Array's. avmshell
// prints "2", and on the global object, which has no length, ReferenceError.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 length, 3 "". Namespace 1 public. Multinames 1 trace, 2 length.
const pool = {
  strings: ["trace", "length", ""],
  namespaces: [[0x16, ...u30(3)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(2)],
  ],
};

const PUSHNULL = 0x20;
const PUSHBYTE = 0x24;
const PUSHSCOPE = 0x30;
const NEWFUNCTION = 0x40;
const CALL = 0x41;
const RETURNVOID = 0x47;
const RETURNVALUE = 0x48;
const CALLPROPVOID = 0x4f;
const NEWARRAY = 0x56;
const FINDPROPSTRICT = 0x5d;
const GETPROPERTY = 0x66;
const GETLOCAL0 = 0xd0;

/** trace(f.call(receiver)), f pushing `this` and returning length found along its scopes. */
function script(receiver: number[]): Uint8Array {
  return abc(
    pool,
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0 }],
      bodies: [
        {
          method: 0,
          maxStack: 5,
          localCount: 1,
          maxScopeDepth: 1,
          code: [
            ...[GETLOCAL0, PUSHSCOPE, FINDPROPSTRICT, 1, NEWFUNCTION, 1, ...receiver],
            ...[CALL, 0, CALLPROPVOID, 1, 1, RETURNVOID],
          ],
        },
        {
          method: 1,
          maxStack: 2,
          localCount: 1,
          initScopeDepth: 1,
          maxScopeDepth: 2,
          code: [GETLOCAL0, PUSHSCOPE, FINDPROPSTRICT, 2, GETPROPERTY, 2, RETURNVALUE],
        },
      ],
    }),
  );
}

test("a name no scope binds statically is looked up on the local scopes as they are", {
  skip,
}, async () => {
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  const array = [PUSHBYTE, 1, PUSHBYTE, 2, NEWARRAY, 2];
  assert.deepEqual(await runSwf2es(builtins, script(array)), ["2"]);
  // Called on null, a function's `this` is the global object.
  assert.deepEqual(await runSwf2es(builtins, script([PUSHNULL])), ["ReferenceError: Error #1065"]);
});
