import assert from "node:assert/strict";
import { test } from "node:test";
import { abc, type Body, tables, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

// Multinames: 1 a (QName), 2 @a (QNameA), 3 RTQNameL.
const pool = {
  strings: ["a"],
  namespaces: [[0x16, ...u30(1)]],
  multinames: [[0x07, ...u30(1), ...u30(1)], [0x0d, ...u30(1), ...u30(1)], [0x11]],
};

const s24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

// Opcodes used below.
const DXNS = 0x06;
const IFTRUE = 0x11;
const POPSCOPE = 0x1d;
const PUSHNULL = 0x20;
const PUSHTRUE = 0x26;
const POP = 0x29;
const PUSHSTRING = 0x2c;
const PUSHINT = 0x2d;
const PUSHSCOPE = 0x30;
const PUSHNAMESPACE = 0x31;
const HASNEXT2 = 0x32;
const NEWFUNCTION = 0x40;
const CALLSTATIC = 0x44;
const CALLPROPERTY = 0x46;
const RETURNVOID = 0x47;
const NEWACTIVATION = 0x57;
const NEWCLASS = 0x58;
const NEWCATCH = 0x5a;
const FINDDEF = 0x5f;
const GETLEX = 0x60;
const GETLOCAL = 0x62;
const GETSCOPEOBJECT = 0x65;
const GETLOCAL0 = 0xd0;

const NEED_ACTIVATION = 0x02;
const NEED_REST = 0x04;
const SETS_DXNS = 0x40;

/** The body's frame, with the method's flags and parameter types. */
type Frame = Partial<Body> & { flags?: number; params?: number[] };

/**
 * The error avmplus' verifier reports for the script init's body, or
 * undefined. Method 1, with a body of its own, is there for newfunction.
 */
function verify(
  code: number[],
  { flags = 0, params = [], ...frame }: Frame = {},
): number | undefined {
  const body: Body = { method: 0, code, maxStack: 4, ...frame };
  const bytes = abc(
    pool,
    tables({
      methods: [{ flags, params }, {}],
      scripts: [{ init: 0 }],
      bodies: [body, { method: 1 }],
    }),
  );
  const error = (testing.codeDump(bytes) as string)
    .split("\n")
    .find((l) => l.trim().startsWith("error"));
  return error ? Number(error.trim().split(" ")[1]) : undefined;
}

test("a well-formed body verifies", () => {
  assert.equal(verify([GETLOCAL0, PUSHSCOPE, POPSCOPE, RETURNVOID]), undefined);
});

test("1107: too few registers for this and the parameters", () => {
  assert.equal(verify([RETURNVOID], { localCount: 0 }), 1107);
  assert.equal(verify([RETURNVOID], { params: [0] }), 1107);
  assert.equal(verify([RETURNVOID], { params: [0], localCount: 2 }), undefined);
});

test("1025: rest or arguments needs a register after the parameters", () => {
  assert.equal(verify([RETURNVOID], { flags: NEED_REST }), 1025);
  assert.equal(verify([RETURNVOID], { flags: NEED_REST, localCount: 2 }), undefined);
});

test("1024 and 1023: stack underflow and overflow", () => {
  assert.equal(verify([POP, RETURNVOID]), 1024);
  assert.equal(verify([PUSHNULL, PUSHNULL, POP, POP, RETURNVOID], { maxStack: 1 }), 1023);
  assert.equal(verify([PUSHNULL, POP, RETURNVOID], { maxStack: 1 }), undefined);
});

// Flash Player checks this since PSIRT 3037; the oracle's avmshell predates it.
test("1023: a handler needs room for the exception", () => {
  const code = [DXNS, 1, RETURNVOID, RETURNVOID];
  const handler: Body["exceptions"] = [[0, 2, 3, 0, 0]];
  assert.equal(verify(code, { flags: SETS_DXNS, maxStack: 0, exceptions: handler }), 1023);
  assert.equal(verify(code, { flags: SETS_DXNS, maxStack: 1, exceptions: handler }), undefined);
});

test("1025: registers past local_count", () => {
  assert.equal(verify([GETLOCAL, 1, POP, RETURNVOID]), 1025);
  assert.equal(verify([GETLOCAL, 1, POP, RETURNVOID], { localCount: 2 }), undefined);
});

test("1017, 1018 and 1019: scope overflow, underflow and getscopeobject bounds", () => {
  assert.equal(verify([GETLOCAL0, PUSHSCOPE, GETLOCAL0, PUSHSCOPE, RETURNVOID]), 1017);
  assert.equal(verify([POPSCOPE, RETURNVOID]), 1018);
  assert.equal(verify([GETSCOPEOBJECT, 0, POP, RETURNVOID]), 1019);
  assert.equal(verify([GETLOCAL0, PUSHSCOPE, GETSCOPEOBJECT, 0, POP, RETURNVOID]), undefined);
});

test("1030 and 1031: paths into a block with different depths", () => {
  // 1: iftrue +1 to 6, the returnvoid; the fall-through pushes first.
  assert.equal(verify([PUSHTRUE, IFTRUE, ...s24(1), PUSHNULL, RETURNVOID]), 1030);
  // 1: iftrue +2 to 7, the returnvoid; the fall-through pushes a scope first.
  assert.equal(verify([PUSHTRUE, IFTRUE, ...s24(2), GETLOCAL0, PUSHSCOPE, RETURNVOID]), 1031);
});

test("1032: pool indices out of range", () => {
  assert.equal(verify([PUSHSTRING, 0, POP, RETURNVOID]), 1032);
  assert.equal(verify([PUSHSTRING, 2, POP, RETURNVOID]), 1032);
  assert.equal(verify([PUSHSTRING, 1, POP, RETURNVOID]), undefined);
  assert.equal(verify([PUSHINT, 1, POP, RETURNVOID]), 1032);
  assert.equal(verify([GETLOCAL0, CALLPROPERTY, 0, 0, POP, RETURNVOID]), 1032);
  assert.equal(verify([GETLOCAL0, CALLPROPERTY, 9, 0, POP, RETURNVOID]), 1032);
});

test("runtime multinames take their parts from the stack", () => {
  const name = [PUSHNAMESPACE, 1, PUSHSTRING, 1];
  assert.equal(verify([GETLOCAL0, ...name.slice(2), CALLPROPERTY, 3, 0, POP, RETURNVOID]), 1024);
  assert.equal(verify([GETLOCAL0, ...name, CALLPROPERTY, 3, 0, POP, RETURNVOID]), undefined);
});

test("1078: multinames an opcode does not allow", () => {
  // getlex needs a scope first, or it fails with 1013.
  const scope = [GETLOCAL0, PUSHSCOPE];
  assert.equal(verify([...scope, PUSHNULL, PUSHNULL, GETLEX, 3, POP, RETURNVOID]), 1078);
  assert.equal(verify([PUSHNULL, PUSHNULL, FINDDEF, 3, POP, RETURNVOID]), 1078);
  assert.equal(verify([GETLOCAL0, CALLPROPERTY, 2, 0, POP, RETURNVOID]), 1078);
  assert.equal(verify([GETLOCAL0, CALLPROPERTY, 1, 0, POP, RETURNVOID]), undefined);
});

test("1015: dxns needs SETS_DXNS", () => {
  assert.equal(verify([DXNS, 1, RETURNVOID]), 1015);
  assert.equal(verify([DXNS, 1, RETURNVOID], { flags: SETS_DXNS }), undefined);
});

test("1113: newactivation needs NEED_ACTIVATION, newcatch a handler", () => {
  assert.equal(verify([NEWACTIVATION, POP, RETURNVOID]), 1113);
  assert.equal(verify([NEWACTIVATION, POP, RETURNVOID], { flags: NEED_ACTIVATION }), undefined);
  assert.equal(verify([NEWCATCH, 0, POP, RETURNVOID]), 1113);
});

test("1124: hasnext2 with the same register twice", () => {
  assert.equal(verify([HASNEXT2, 0, 0, POP, RETURNVOID]), 1124);
});

// callstatic's target must also be bound to a trait, which step 2 checks.
test("1027, 1060 and 1107: method and class indices", () => {
  assert.equal(verify([NEWFUNCTION, 2, POP, RETURNVOID]), 1027);
  assert.equal(verify([NEWFUNCTION, 1, POP, RETURNVOID]), undefined);
  assert.equal(verify([PUSHNULL, NEWCLASS, 0, POP, RETURNVOID]), 1060);
  assert.equal(verify([GETLOCAL0, CALLSTATIC, 2, 0, POP, RETURNVOID]), 1107);
});
