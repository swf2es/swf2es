// super outside an instance method, which ASC never writes: avmplus'
// script traits extend Object and a class object's traits Class, so a
// script's constructsuper and callsuper reach Object's, and a class's
// static initializer and static methods reach Class's, whose prototype
// getter is the class's. avmshell traces "true" and "[object Object]".
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 "", 3 Object, 4 C, 5 AS3's URI, 6 hasOwnProperty, 7 prototype, 8 m.
// Namespaces 1 public, 2 AS3. Multinames 1 trace, 2 Object, 3 C, 4 AS3::hasOwnProperty,
// 5 prototype, 6 m.
const pool = {
  strings: [
    "trace",
    "",
    "Object",
    "C",
    "http://adobe.com/AS3/2006/builtin",
    "hasOwnProperty",
    "prototype",
    "m",
  ],
  namespaces: [
    [0x16, ...u30(2)],
    [0x08, ...u30(5)],
  ],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(3)],
    [0x07, ...u30(1), ...u30(4)],
    [0x07, ...u30(2), ...u30(6)],
    [0x07, ...u30(1), ...u30(7)],
    [0x07, ...u30(1), ...u30(8)],
  ],
};

const GETSUPER = 0x04;
const PUSHSCOPE = 0x30;
const PUSHSTRING = 0x2c;
const CALLSUPER = 0x45;
const CALLPROPERTY = 0x46;
const RETURNVOID = 0x47;
const RETURNVALUE = 0x48;
const CONSTRUCTSUPER = 0x49;
const CALLPROPVOID = 0x4f;
const NEWCLASS = 0x58;
const FINDPROPSTRICT = 0x5d;
const GETLEX = 0x60;
const GETSCOPEOBJECT = 0x65;
const INITPROPERTY = 0x68;
const POPSCOPE = 0x1d;
const GETLOCAL0 = 0xd0;

const superOutsideInstances = abc(
  pool,
  tables({
    methods: [{}, {}, {}, {}],
    classes: [
      {
        instance: { name: 3, base: 2, init: 1 },
        init: 2,
        traits: [{ name: 6, kind: 1, id: 1, index: 3 }],
      },
    ],
    scripts: [{ init: 0, traits: [{ name: 3, kind: 4, id: 1, index: 0 }] }],
    bodies: [
      {
        // super() and super.hasOwnProperty("C") on the global object, then
        // the class made and its static method called.
        method: 0,
        maxStack: 3,
        localCount: 1,
        maxScopeDepth: 2,
        code: [
          GETLOCAL0,
          PUSHSCOPE,
          GETLOCAL0,
          CONSTRUCTSUPER,
          0,
          FINDPROPSTRICT,
          1,
          GETLOCAL0,
          PUSHSTRING,
          4,
          CALLSUPER,
          4,
          1,
          CALLPROPVOID,
          1,
          1,
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
          1,
          GETLEX,
          3,
          CALLPROPERTY,
          6,
          0,
          CALLPROPVOID,
          1,
          1,
          RETURNVOID,
        ],
      },
      {
        method: 1,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, GETLOCAL0, CONSTRUCTSUPER, 0, RETURNVOID],
      },
      {
        // The static initializer: super() on the class object.
        method: 2,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, GETLOCAL0, CONSTRUCTSUPER, 0, RETURNVOID],
      },
      {
        // static function m() { return super.prototype; }
        method: 3,
        initScopeDepth: 2,
        maxScopeDepth: 3,
        code: [GETLOCAL0, PUSHSCOPE, GETLOCAL0, GETSUPER, 5, RETURNVALUE],
      },
    ],
  }),
);

test("super in a script and in a class's statics reaches Object's and Class's", {
  skip,
}, async () => {
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  assert.deepEqual(await runSwf2es(builtins, superOutsideInstances), ["true", "[object Object]"]);
});
