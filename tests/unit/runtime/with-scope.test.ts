// A with scope over an activation, which ASC never writes and has no
// prototype: findproperty asks it, finds nothing, and goes on outward, as
// avmshell does (it traces "outer" for this script initializer).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 "", 3 outer, 4 Missing. Namespace 1 public.
// Multinames 1 trace, 2 Missing.
const pool = {
  strings: ["trace", "", "outer", "Missing"],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(4)],
  ],
};

const NEED_ACTIVATION = 0x02;
const GETLOCAL0 = 0xd0;
const PUSHSCOPE = 0x30;
const NEWACTIVATION = 0x57;
const PUSHWITH = 0x1c;
const POPSCOPE = 0x1d;
const FINDPROPSTRICT = 0x5d;
const FINDPROPERTY = 0x5e;
const PUSHSTRING = 0x2c;
const CALLPROPVOID = 0x4f;
const POP = 0x29;
const RETURNVOID = 0x47;

/** The script initializer: with (activation) { trace("outer"); findproperty Missing }. */
const activationWith = abc(
  pool,
  tables({
    methods: [{ flags: NEED_ACTIVATION }],
    scripts: [{ init: 0 }],
    bodies: [
      {
        method: 0,
        maxStack: 3,
        localCount: 1,
        maxScopeDepth: 3,
        code: [
          GETLOCAL0,
          PUSHSCOPE,
          NEWACTIVATION,
          PUSHWITH,
          FINDPROPSTRICT,
          1,
          PUSHSTRING,
          3,
          CALLPROPVOID,
          1,
          1,
          FINDPROPERTY,
          2,
          POP,
          POPSCOPE,
          POPSCOPE,
          RETURNVOID,
        ],
      },
    ],
  }),
);

test("a with scope over an activation lets a lookup go on outward", { skip }, async () => {
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  assert.deepEqual(await runSwf2es(builtins, activationWith), ["outer"]);
});
