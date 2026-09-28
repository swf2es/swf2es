// Method bodies the structural verifier checks, with the VerifyError avmplus
// reports for each. verify.test.ts checks swf2es against these, and
// `pnpm oracle:cases` checks them against avmshell.
import { abc, type Body, tables, u30 } from "./abc-builder.ts";
import type { Case } from "./oracle-case.ts";

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
 * An ABC whose script init has `code`. Method 1, with a body of its own, is
 * there for newfunction.
 */
function method(code: number[], { flags = 0, params = [], ...frame }: Frame = {}): Uint8Array {
  const body: Body = { method: 0, code, maxStack: 4, ...frame };
  return abc(
    pool,
    tables({
      methods: [{ flags, params }, {}],
      scripts: [{ init: 0 }],
      bodies: [body, { method: 1 }],
    }),
  );
}

const dxnsInTry = [DXNS, 1, RETURNVOID, RETURNVOID];
const dxnsHandler: Body["exceptions"] = [[0, 2, 3, 0, 0]];
const runtimeName = [PUSHNAMESPACE, 1, PUSHSTRING, 1];
const withScope = [GETLOCAL0, PUSHSCOPE];

export const verifyCases: Case[] = [
  {
    name: "a well-formed body verifies (1)",
    abc: method([GETLOCAL0, PUSHSCOPE, POPSCOPE, RETURNVOID]),
  },
  {
    name: "1107: too few registers for this and the parameters (1)",
    abc: method([RETURNVOID], { localCount: 0 }),
    error: 1107,
  },
  {
    name: "1107: too few registers for this and the parameters (2)",
    abc: method([RETURNVOID], { params: [0] }),
    error: 1107,
  },
  {
    name: "1107: too few registers for this and the parameters (3)",
    abc: method([RETURNVOID], { params: [0], localCount: 2 }),
  },
  {
    name: "1025: rest or arguments needs a register after the parameters (1)",
    abc: method([RETURNVOID], { flags: NEED_REST }),
    error: 1025,
  },
  {
    name: "1025: rest or arguments needs a register after the parameters (2)",
    abc: method([RETURNVOID], { flags: NEED_REST, localCount: 2 }),
  },
  {
    name: "1024 and 1023: stack underflow and overflow (1)",
    abc: method([POP, RETURNVOID]),
    error: 1024,
  },
  {
    name: "1024 and 1023: stack underflow and overflow (2)",
    abc: method([PUSHNULL, PUSHNULL, POP, POP, RETURNVOID], { maxStack: 1 }),
    error: 1023,
  },
  {
    name: "1024 and 1023: stack underflow and overflow (3)",
    abc: method([PUSHNULL, POP, RETURNVOID], { maxStack: 1 }),
  },
  // Flash Player checks this since PSIRT 3037; the oracle's avmshell predates it.
  {
    name: "1023: a handler needs room for the exception (1)",
    abc: method(dxnsInTry, { flags: SETS_DXNS, maxStack: 0, exceptions: dxnsHandler }),
    error: 1023,
    avmshell: null,
  },
  {
    name: "1023: a handler needs room for the exception (2)",
    abc: method(dxnsInTry, { flags: SETS_DXNS, maxStack: 1, exceptions: dxnsHandler }),
  },
  {
    name: "1025: registers past local_count (1)",
    abc: method([GETLOCAL, 1, POP, RETURNVOID]),
    error: 1025,
  },
  {
    name: "1025: registers past local_count (2)",
    abc: method([GETLOCAL, 1, POP, RETURNVOID], { localCount: 2 }),
  },
  {
    name: "1017, 1018 and 1019: scope overflow, underflow and getscopeobject bounds (1)",
    abc: method([GETLOCAL0, PUSHSCOPE, GETLOCAL0, PUSHSCOPE, RETURNVOID]),
    error: 1017,
  },
  {
    name: "1017, 1018 and 1019: scope overflow, underflow and getscopeobject bounds (2)",
    abc: method([POPSCOPE, RETURNVOID]),
    error: 1018,
  },
  {
    name: "1017, 1018 and 1019: scope overflow, underflow and getscopeobject bounds (3)",
    abc: method([GETSCOPEOBJECT, 0, POP, RETURNVOID]),
    error: 1019,
  },
  {
    name: "1017, 1018 and 1019: scope overflow, underflow and getscopeobject bounds (4)",
    abc: method([GETLOCAL0, PUSHSCOPE, GETSCOPEOBJECT, 0, POP, RETURNVOID]),
  },
  // 1: iftrue +1 to 6, the returnvoid; the fall-through pushes first.
  {
    name: "1030 and 1031: paths into a block with different depths (1)",
    abc: method([PUSHTRUE, IFTRUE, ...s24(1), PUSHNULL, RETURNVOID]),
    error: 1030,
  },
  // 1: iftrue +2 to 7, the returnvoid; the fall-through pushes a scope first.
  {
    name: "1030 and 1031: paths into a block with different depths (2)",
    abc: method([PUSHTRUE, IFTRUE, ...s24(2), GETLOCAL0, PUSHSCOPE, RETURNVOID]),
    error: 1031,
  },
  {
    name: "1032: pool indices out of range (1)",
    abc: method([PUSHSTRING, 0, POP, RETURNVOID]),
    error: 1032,
  },
  {
    name: "1032: pool indices out of range (2)",
    abc: method([PUSHSTRING, 2, POP, RETURNVOID]),
    error: 1032,
  },
  { name: "1032: pool indices out of range (3)", abc: method([PUSHSTRING, 1, POP, RETURNVOID]) },
  {
    name: "1032: pool indices out of range (4)",
    abc: method([PUSHINT, 1, POP, RETURNVOID]),
    error: 1032,
  },
  {
    name: "1032: pool indices out of range (5)",
    abc: method([GETLOCAL0, CALLPROPERTY, 0, 0, POP, RETURNVOID]),
    error: 1032,
  },
  {
    name: "1032: pool indices out of range (6)",
    abc: method([GETLOCAL0, CALLPROPERTY, 9, 0, POP, RETURNVOID]),
    error: 1032,
  },
  {
    name: "runtime multinames take their parts from the stack (1)",
    abc: method([GETLOCAL0, ...runtimeName.slice(2), CALLPROPERTY, 3, 0, POP, RETURNVOID]),
    error: 1024,
  },
  {
    name: "runtime multinames take their parts from the stack (2)",
    abc: method([GETLOCAL0, ...runtimeName, CALLPROPERTY, 3, 0, POP, RETURNVOID]),
  },
  // getlex needs a scope first, or it fails with 1013.
  {
    name: "1078: multinames an opcode does not allow (1)",
    abc: method([...withScope, PUSHNULL, PUSHNULL, GETLEX, 3, POP, RETURNVOID]),
    error: 1078,
  },
  {
    name: "1078: multinames an opcode does not allow (2)",
    abc: method([PUSHNULL, PUSHNULL, FINDDEF, 3, POP, RETURNVOID]),
    error: 1078,
  },
  {
    name: "1078: multinames an opcode does not allow (3)",
    abc: method([GETLOCAL0, CALLPROPERTY, 2, 0, POP, RETURNVOID]),
    error: 1078,
  },
  {
    name: "1078: multinames an opcode does not allow (4)",
    abc: method([GETLOCAL0, CALLPROPERTY, 1, 0, POP, RETURNVOID]),
  },
  { name: "1015: dxns needs SETS_DXNS (1)", abc: method([DXNS, 1, RETURNVOID]), error: 1015 },
  {
    name: "1015: dxns needs SETS_DXNS (2)",
    abc: method([DXNS, 1, RETURNVOID], { flags: SETS_DXNS }),
  },
  {
    name: "1113: newactivation needs NEED_ACTIVATION, newcatch a handler (1)",
    abc: method([NEWACTIVATION, POP, RETURNVOID]),
    error: 1113,
  },
  {
    name: "1113: newactivation needs NEED_ACTIVATION, newcatch a handler (2)",
    abc: method([NEWACTIVATION, POP, RETURNVOID], { flags: NEED_ACTIVATION }),
  },
  {
    name: "1113: newactivation needs NEED_ACTIVATION, newcatch a handler (3)",
    abc: method([NEWCATCH, 0, POP, RETURNVOID]),
    error: 1113,
  },
  {
    name: "1124: hasnext2 with the same register twice (1)",
    abc: method([HASNEXT2, 0, 0, POP, RETURNVOID]),
    error: 1124,
  },
  // callstatic's target must also be bound to a trait, which step 2 checks.
  {
    name: "1027, 1060 and 1107: method and class indices (1)",
    abc: method([NEWFUNCTION, 2, POP, RETURNVOID]),
    error: 1027,
  },
  {
    name: "1027, 1060 and 1107: method and class indices (2)",
    abc: method([NEWFUNCTION, 1, POP, RETURNVOID]),
  },
  {
    name: "1027, 1060 and 1107: method and class indices (3)",
    abc: method([PUSHNULL, NEWCLASS, 0, POP, RETURNVOID]),
    error: 1060,
  },
  {
    name: "1027, 1060 and 1107: method and class indices (4)",
    abc: method([GETLOCAL0, CALLSTATIC, 2, 0, POP, RETURNVOID]),
    error: 1107,
  },
];
