// callstatic, which ASC never writes: a method by its index, called on
// any receiver. avmplus' AbcEnv keeps an environment for each method,
// getter and setter of traits that have a vtable, and for the
// initializers of a class and its instances, so each can be called so.
// avmshell traces "cinit", "init", "m", "init", "cinit".
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 "", 3 Object, 4 C, 5 init, 6 m, 7 cinit, 8 again.
// Namespace 1 public. Multinames 1 trace, 2 Object, 3 C, 4 m, 5 again.
const pool = {
  strings: ["trace", "", "Object", "C", "init", "m", "cinit", "again"],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(3)],
    [0x07, ...u30(1), ...u30(4)],
    [0x07, ...u30(1), ...u30(6)],
    [0x07, ...u30(1), ...u30(8)],
  ],
};

const PUSHSCOPE = 0x30;
const PUSHSTRING = 0x2c;
const POP = 0x29;
const CALLSTATIC = 0x44;
const RETURNVOID = 0x47;
const CONSTRUCTSUPER = 0x49;
const CALLPROPVOID = 0x4f;
const NEWCLASS = 0x58;
const FINDPROPSTRICT = 0x5d;
const GETLEX = 0x60;
const GETSCOPEOBJECT = 0x65;
const INITPROPERTY = 0x68;
const POPSCOPE = 0x1d;
const CONSTRUCTPROP = 0x4a;
const GETLOCAL0 = 0xd0;

const traceString = (s: number) => [FINDPROPSTRICT, 1, PUSHSTRING, s, CALLPROPVOID, 1, 1];

// Methods: 0 the script's initializer, 1 C's instance initializer, 2 C's
// static initializer, 3 C's method m, 4 C's method again, which calls
// 1 and 3 on its receiver, then 2 on C.
const callStatic = abc(
  pool,
  tables({
    methods: [{}, {}, {}, {}, {}],
    classes: [
      {
        instance: {
          name: 3,
          base: 2,
          init: 1,
          traits: [
            { name: 4, kind: 1, id: 1, index: 3 },
            { name: 5, kind: 1, id: 2, index: 4 },
          ],
        },
        init: 2,
      },
    ],
    scripts: [{ init: 0, traits: [{ name: 3, kind: 4, id: 1, index: 0 }] }],
    bodies: [
      {
        method: 0,
        maxStack: 3,
        localCount: 1,
        maxScopeDepth: 2,
        code: [
          GETLOCAL0,
          PUSHSCOPE,
          GETSCOPEOBJECT,
          0,
          GETLEX,
          2,
          PUSHSCOPE,
          GETLEX,
          2,
          NEWCLASS,
          0,
          POPSCOPE,
          INITPROPERTY,
          3,
          FINDPROPSTRICT,
          3,
          CONSTRUCTPROP,
          3,
          0,
          CALLPROPVOID,
          5,
          0,
          RETURNVOID,
        ],
      },
      {
        method: 1,
        maxStack: 2,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, GETLOCAL0, CONSTRUCTSUPER, 0, ...traceString(5), RETURNVOID],
      },
      {
        method: 2,
        maxStack: 2,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, ...traceString(7), RETURNVOID],
      },
      {
        method: 3,
        maxStack: 2,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, ...traceString(6), RETURNVOID],
      },
      {
        method: 4,
        maxStack: 2,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [
          GETLOCAL0,
          PUSHSCOPE,
          GETLOCAL0,
          CALLSTATIC,
          3,
          0,
          POP,
          GETLOCAL0,
          CALLSTATIC,
          1,
          0,
          POP,
          GETLEX,
          3,
          CALLSTATIC,
          2,
          0,
          POP,
          RETURNVOID,
        ],
      },
    ],
  }),
);

test("callstatic calls methods and initializers by their index", { skip }, async () => {
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  assert.deepEqual(await runSwf2es(builtins, callStatic), ["cinit", "init", "m", "init", "cinit"]);
});
