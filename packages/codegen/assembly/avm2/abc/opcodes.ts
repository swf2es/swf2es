// AVM2 instructions (AVM2 overview, chapter 5): how each opcode's operands
// are encoded, whether it can throw, and its name. tests/unit/codegen/
// opcodes.test.ts checks the table against avmplus' core/opcodes.tbl.
//
// Opcodes not defined here are illegal in ABC 46.16, including the float
// instructions of ABC 47.16 (AIR-only: Flash Player never had them) and
// those avmplus only uses internally.

export const OPERANDS_None: u8 = 0;
/** One u30: a pool index, register, argument count or slot. */
export const OPERANDS_U30: u8 = 1;
/** Two u30s, such as a multiname and an argument count. */
export const OPERANDS_U30U30: u8 = 2;
/** An s24 offset from the next instruction. */
export const OPERANDS_Branch: u8 = 3;
/** pushbyte: one signed byte. */
export const OPERANDS_Byte: u8 = 4;
/** pushshort: a u30 whose value is sign-extended from 16 bits. */
export const OPERANDS_Short: u8 = 5;
/** debug: debug type byte, string index, register byte, and an unused u30. */
export const OPERANDS_Debug: u8 = 6;
/** lookupswitch: default s24, case count u30, then count + 1 s24 offsets from the instruction. */
export const OPERANDS_Switch: u8 = 7;
export const OPERANDS_Illegal: u8 = 0xff;

/** The instruction can throw, so it reaches the exception handlers covering it. */
export const FLAG_Throws: u8 = 1;
/** Control never falls through to the next instruction. */
export const FLAG_Terminal: u8 = 2;

// Stack effects beyond an opcode's base pops (see opcodePops).
/** Operand a is a multiname whose runtime name and namespace, if any, are popped too. */
export const STACK_Multiname: u8 = 1;
/** Operand a is an argument count, popped in addition. */
export const STACK_ArgcA: u8 = 2;
/** Operand b is an argument count, popped in addition. */
export const STACK_ArgcB: u8 = 4;
/** Pushes nothing, but avmplus checks the stack as if it pushed one value. */
export const STACK_CheckPushOne: u8 = 8;

// Every opcode the table defines, by name.
export const OP_bkpt: u8 = 0x01;
export const OP_nop: u8 = 0x02;
export const OP_throw: u8 = 0x03;
export const OP_getsuper: u8 = 0x04;
export const OP_setsuper: u8 = 0x05;
export const OP_dxns: u8 = 0x06;
export const OP_dxnslate: u8 = 0x07;
export const OP_kill: u8 = 0x08;
export const OP_label: u8 = 0x09;
export const OP_ifnlt: u8 = 0x0c;
export const OP_ifnle: u8 = 0x0d;
export const OP_ifngt: u8 = 0x0e;
export const OP_ifnge: u8 = 0x0f;
export const OP_jump: u8 = 0x10;
export const OP_iftrue: u8 = 0x11;
export const OP_iffalse: u8 = 0x12;
export const OP_ifeq: u8 = 0x13;
export const OP_ifne: u8 = 0x14;
export const OP_iflt: u8 = 0x15;
export const OP_ifle: u8 = 0x16;
export const OP_ifgt: u8 = 0x17;
export const OP_ifge: u8 = 0x18;
export const OP_ifstricteq: u8 = 0x19;
export const OP_ifstrictne: u8 = 0x1a;
export const OP_lookupswitch: u8 = 0x1b;
export const OP_pushwith: u8 = 0x1c;
export const OP_popscope: u8 = 0x1d;
export const OP_nextname: u8 = 0x1e;
export const OP_hasnext: u8 = 0x1f;
export const OP_pushnull: u8 = 0x20;
export const OP_pushundefined: u8 = 0x21;
export const OP_nextvalue: u8 = 0x23;
export const OP_pushbyte: u8 = 0x24;
export const OP_pushshort: u8 = 0x25;
export const OP_pushtrue: u8 = 0x26;
export const OP_pushfalse: u8 = 0x27;
export const OP_pushnan: u8 = 0x28;
export const OP_pop: u8 = 0x29;
export const OP_dup: u8 = 0x2a;
export const OP_swap: u8 = 0x2b;
export const OP_pushstring: u8 = 0x2c;
export const OP_pushint: u8 = 0x2d;
export const OP_pushuint: u8 = 0x2e;
export const OP_pushdouble: u8 = 0x2f;
export const OP_pushscope: u8 = 0x30;
export const OP_pushnamespace: u8 = 0x31;
export const OP_hasnext2: u8 = 0x32;
export const OP_li8: u8 = 0x35;
export const OP_li16: u8 = 0x36;
export const OP_li32: u8 = 0x37;
export const OP_lf32: u8 = 0x38;
export const OP_lf64: u8 = 0x39;
export const OP_si8: u8 = 0x3a;
export const OP_si16: u8 = 0x3b;
export const OP_si32: u8 = 0x3c;
export const OP_sf32: u8 = 0x3d;
export const OP_sf64: u8 = 0x3e;
export const OP_newfunction: u8 = 0x40;
export const OP_call: u8 = 0x41;
export const OP_construct: u8 = 0x42;
export const OP_callmethod: u8 = 0x43;
export const OP_callstatic: u8 = 0x44;
export const OP_callsuper: u8 = 0x45;
export const OP_callproperty: u8 = 0x46;
export const OP_returnvoid: u8 = 0x47;
export const OP_returnvalue: u8 = 0x48;
export const OP_constructsuper: u8 = 0x49;
export const OP_constructprop: u8 = 0x4a;
export const OP_callproplex: u8 = 0x4c;
export const OP_callsupervoid: u8 = 0x4e;
export const OP_callpropvoid: u8 = 0x4f;
export const OP_sxi1: u8 = 0x50;
export const OP_sxi8: u8 = 0x51;
export const OP_sxi16: u8 = 0x52;
export const OP_applytype: u8 = 0x53;
export const OP_newobject: u8 = 0x55;
export const OP_newarray: u8 = 0x56;
export const OP_newactivation: u8 = 0x57;
export const OP_newclass: u8 = 0x58;
export const OP_getdescendants: u8 = 0x59;
export const OP_newcatch: u8 = 0x5a;
export const OP_findpropstrict: u8 = 0x5d;
export const OP_findproperty: u8 = 0x5e;
export const OP_finddef: u8 = 0x5f;
export const OP_getlex: u8 = 0x60;
export const OP_setproperty: u8 = 0x61;
export const OP_getlocal: u8 = 0x62;
export const OP_setlocal: u8 = 0x63;
export const OP_getglobalscope: u8 = 0x64;
export const OP_getscopeobject: u8 = 0x65;
export const OP_getproperty: u8 = 0x66;
export const OP_getouterscope: u8 = 0x67;
export const OP_initproperty: u8 = 0x68;
export const OP_deleteproperty: u8 = 0x6a;
export const OP_getslot: u8 = 0x6c;
export const OP_setslot: u8 = 0x6d;
export const OP_getglobalslot: u8 = 0x6e;
export const OP_setglobalslot: u8 = 0x6f;
export const OP_convert_s: u8 = 0x70;
export const OP_esc_xelem: u8 = 0x71;
export const OP_esc_xattr: u8 = 0x72;
export const OP_convert_i: u8 = 0x73;
export const OP_convert_u: u8 = 0x74;
export const OP_convert_d: u8 = 0x75;
export const OP_convert_b: u8 = 0x76;
export const OP_convert_o: u8 = 0x77;
export const OP_checkfilter: u8 = 0x78;
export const OP_coerce: u8 = 0x80;
export const OP_coerce_b: u8 = 0x81;
export const OP_coerce_a: u8 = 0x82;
export const OP_coerce_i: u8 = 0x83;
export const OP_coerce_d: u8 = 0x84;
export const OP_coerce_s: u8 = 0x85;
export const OP_astype: u8 = 0x86;
export const OP_astypelate: u8 = 0x87;
export const OP_coerce_u: u8 = 0x88;
export const OP_coerce_o: u8 = 0x89;
export const OP_negate: u8 = 0x90;
export const OP_increment: u8 = 0x91;
export const OP_inclocal: u8 = 0x92;
export const OP_decrement: u8 = 0x93;
export const OP_declocal: u8 = 0x94;
export const OP_typeof: u8 = 0x95;
export const OP_not: u8 = 0x96;
export const OP_bitnot: u8 = 0x97;
export const OP_add: u8 = 0xa0;
export const OP_subtract: u8 = 0xa1;
export const OP_multiply: u8 = 0xa2;
export const OP_divide: u8 = 0xa3;
export const OP_modulo: u8 = 0xa4;
export const OP_lshift: u8 = 0xa5;
export const OP_rshift: u8 = 0xa6;
export const OP_urshift: u8 = 0xa7;
export const OP_bitand: u8 = 0xa8;
export const OP_bitor: u8 = 0xa9;
export const OP_bitxor: u8 = 0xaa;
export const OP_equals: u8 = 0xab;
export const OP_strictequals: u8 = 0xac;
export const OP_lessthan: u8 = 0xad;
export const OP_lessequals: u8 = 0xae;
export const OP_greaterthan: u8 = 0xaf;
export const OP_greaterequals: u8 = 0xb0;
export const OP_instanceof: u8 = 0xb1;
export const OP_istype: u8 = 0xb2;
export const OP_istypelate: u8 = 0xb3;
export const OP_in: u8 = 0xb4;
export const OP_increment_i: u8 = 0xc0;
export const OP_decrement_i: u8 = 0xc1;
export const OP_inclocal_i: u8 = 0xc2;
export const OP_declocal_i: u8 = 0xc3;
export const OP_negate_i: u8 = 0xc4;
export const OP_add_i: u8 = 0xc5;
export const OP_subtract_i: u8 = 0xc6;
export const OP_multiply_i: u8 = 0xc7;
export const OP_getlocal0: u8 = 0xd0;
export const OP_getlocal1: u8 = 0xd1;
export const OP_getlocal2: u8 = 0xd2;
export const OP_getlocal3: u8 = 0xd3;
export const OP_setlocal0: u8 = 0xd4;
export const OP_setlocal1: u8 = 0xd5;
export const OP_setlocal2: u8 = 0xd6;
export const OP_setlocal3: u8 = 0xd7;
export const OP_debug: u8 = 0xef;
export const OP_debugline: u8 = 0xf0;
export const OP_debugfile: u8 = 0xf1;
export const OP_bkptline: u8 = 0xf2;
export const OP_timestamp: u8 = 0xf3;

export const opcodeOperands = new StaticArray<u8>(256);
export const opcodeFlags = new StaticArray<u8>(256);
export const opcodeNames = new StaticArray<string>(256);
/** Values popped and pushed, as avmplus' verifier checks them, before STACK_* parts. */
export const opcodePops = new StaticArray<u8>(256);
export const opcodePushes = new StaticArray<u8>(256);
export const opcodeStack = new StaticArray<u8>(256);

function define(
  opcode: i32,
  name: string,
  operands: u8,
  flags: u8,
  pops: u8,
  pushes: u8,
  stack: u8,
): void {
  opcodeOperands[opcode] = operands;
  opcodeFlags[opcode] = flags;
  opcodeNames[opcode] = name;
  opcodePops[opcode] = pops;
  opcodePushes[opcode] = pushes;
  opcodeStack[opcode] = stack;
}

function defineAll(): void {
  for (let opcode = 0; opcode < 256; opcode++) {
    opcodeOperands[opcode] = OPERANDS_Illegal;
    opcodeNames[opcode] = `0x${opcode < 0x10 ? "0" : ""}${opcode.toString(16)}`;
  }

  define(0x01, "bkpt", OPERANDS_None, 0, 0, 0, 0);
  define(0x02, "nop", OPERANDS_None, 0, 0, 0, 0);
  define(0x03, "throw", OPERANDS_None, FLAG_Throws | FLAG_Terminal, 1, 0, 0);
  define(0x04, "getsuper", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname);
  define(0x05, "setsuper", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname);
  define(0x06, "dxns", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0x07, "dxnslate", OPERANDS_None, FLAG_Throws, 1, 0, 0);
  define(0x08, "kill", OPERANDS_U30, 0, 0, 0, 0);
  define(0x09, "label", OPERANDS_None, 0, 0, 0, 0);
  define(0x0c, "ifnlt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x0d, "ifnle", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x0e, "ifngt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x0f, "ifnge", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x10, "jump", OPERANDS_Branch, FLAG_Terminal, 0, 0, 0);
  define(0x11, "iftrue", OPERANDS_Branch, 0, 1, 0, 0);
  define(0x12, "iffalse", OPERANDS_Branch, 0, 1, 0, 0);
  define(0x13, "ifeq", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x14, "ifne", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x15, "iflt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x16, "ifle", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x17, "ifgt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x18, "ifge", OPERANDS_Branch, FLAG_Throws, 2, 0, 0);
  define(0x19, "ifstricteq", OPERANDS_Branch, 0, 2, 0, 0);
  define(0x1a, "ifstrictne", OPERANDS_Branch, 0, 2, 0, 0);
  define(0x1b, "lookupswitch", OPERANDS_Switch, FLAG_Terminal, 1, 0, 0);
  define(0x1c, "pushwith", OPERANDS_None, FLAG_Throws, 1, 0, 0);
  define(0x1d, "popscope", OPERANDS_None, 0, 0, 0, 0);
  define(0x1e, "nextname", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0x1f, "hasnext", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0x20, "pushnull", OPERANDS_None, 0, 0, 1, 0);
  define(0x21, "pushundefined", OPERANDS_None, 0, 0, 1, 0);
  define(0x23, "nextvalue", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0x24, "pushbyte", OPERANDS_Byte, 0, 0, 1, 0);
  define(0x25, "pushshort", OPERANDS_Short, 0, 0, 1, 0);
  define(0x26, "pushtrue", OPERANDS_None, 0, 0, 1, 0);
  define(0x27, "pushfalse", OPERANDS_None, 0, 0, 1, 0);
  define(0x28, "pushnan", OPERANDS_None, 0, 0, 1, 0);
  define(0x29, "pop", OPERANDS_None, 0, 1, 0, 0);
  define(0x2a, "dup", OPERANDS_None, 0, 1, 2, 0);
  define(0x2b, "swap", OPERANDS_None, 0, 2, 2, 0);
  define(0x2c, "pushstring", OPERANDS_U30, 0, 0, 1, 0);
  define(0x2d, "pushint", OPERANDS_U30, 0, 0, 1, 0);
  define(0x2e, "pushuint", OPERANDS_U30, 0, 0, 1, 0);
  define(0x2f, "pushdouble", OPERANDS_U30, 0, 0, 1, 0);
  define(0x30, "pushscope", OPERANDS_None, FLAG_Throws, 1, 0, 0);
  define(0x31, "pushnamespace", OPERANDS_U30, 0, 0, 1, 0);
  define(0x32, "hasnext2", OPERANDS_U30U30, FLAG_Throws, 0, 1, 0);
  define(0x35, "li8", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x36, "li16", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x37, "li32", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x38, "lf32", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x39, "lf64", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x3a, "si8", OPERANDS_None, FLAG_Throws, 2, 0, 0);
  define(0x3b, "si16", OPERANDS_None, FLAG_Throws, 2, 0, 0);
  define(0x3c, "si32", OPERANDS_None, FLAG_Throws, 2, 0, 0);
  define(0x3d, "sf32", OPERANDS_None, FLAG_Throws, 2, 0, 0);
  define(0x3e, "sf64", OPERANDS_None, FLAG_Throws, 2, 0, 0);
  define(0x40, "newfunction", OPERANDS_U30, FLAG_Throws, 0, 1, 0);
  define(0x41, "call", OPERANDS_U30, FLAG_Throws, 2, 1, STACK_ArgcA);
  define(0x42, "construct", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_ArgcA);
  define(0x43, "callmethod", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_ArgcB);
  define(0x44, "callstatic", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_ArgcB);
  define(0x45, "callsuper", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB);
  define(0x46, "callproperty", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB);
  define(0x47, "returnvoid", OPERANDS_None, FLAG_Terminal, 0, 0, 0);
  define(0x48, "returnvalue", OPERANDS_None, FLAG_Throws | FLAG_Terminal, 1, 0, 0);
  define(0x49, "constructsuper", OPERANDS_U30, FLAG_Throws, 1, 0, STACK_ArgcA);
  define(0x4a, "constructprop", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB);
  define(0x4c, "callproplex", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB);
  define(
    0x4e,
    "callsupervoid",
    OPERANDS_U30U30,
    FLAG_Throws,
    1,
    0,
    STACK_Multiname | STACK_ArgcB | STACK_CheckPushOne,
  );
  define(
    0x4f,
    "callpropvoid",
    OPERANDS_U30U30,
    FLAG_Throws,
    1,
    0,
    STACK_Multiname | STACK_ArgcB | STACK_CheckPushOne,
  );
  define(0x50, "sxi1", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x51, "sxi8", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x52, "sxi16", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x53, "applytype", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_ArgcA);
  define(0x55, "newobject", OPERANDS_U30, FLAG_Throws, 0, 1, 0);
  define(0x56, "newarray", OPERANDS_U30, FLAG_Throws, 0, 1, 0);
  define(0x57, "newactivation", OPERANDS_None, FLAG_Throws, 0, 1, 0);
  define(0x58, "newclass", OPERANDS_U30, FLAG_Throws, 1, 1, 0);
  define(0x59, "getdescendants", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname);
  define(0x5a, "newcatch", OPERANDS_U30, FLAG_Throws, 0, 1, 0);
  define(0x5d, "findpropstrict", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname);
  define(0x5e, "findproperty", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname);
  define(0x5f, "finddef", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname);
  define(0x60, "getlex", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname);
  define(0x61, "setproperty", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname);
  define(0x62, "getlocal", OPERANDS_U30, 0, 0, 1, 0);
  define(0x63, "setlocal", OPERANDS_U30, 0, 1, 0, 0);
  define(0x64, "getglobalscope", OPERANDS_None, 0, 0, 1, 0);
  define(0x65, "getscopeobject", OPERANDS_U30, 0, 0, 1, 0);
  define(0x66, "getproperty", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname);
  define(0x67, "getouterscope", OPERANDS_U30, 0, 0, 1, 0);
  define(0x68, "initproperty", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname);
  define(0x6a, "deleteproperty", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname);
  define(0x6c, "getslot", OPERANDS_U30, FLAG_Throws, 1, 1, 0);
  define(0x6d, "setslot", OPERANDS_U30, FLAG_Throws, 2, 0, 0);
  define(0x6e, "getglobalslot", OPERANDS_U30, 0, 0, 1, 0);
  define(0x6f, "setglobalslot", OPERANDS_U30, FLAG_Throws, 1, 0, 0);
  define(0x70, "convert_s", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x71, "esc_xelem", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x72, "esc_xattr", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x73, "convert_i", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x74, "convert_u", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x75, "convert_d", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x76, "convert_b", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x77, "convert_o", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x78, "checkfilter", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x80, "coerce", OPERANDS_U30, FLAG_Throws, 1, 1, 0);
  define(0x81, "coerce_b", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x82, "coerce_a", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x83, "coerce_i", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x84, "coerce_d", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x85, "coerce_s", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x86, "astype", OPERANDS_U30, FLAG_Throws, 1, 1, 0);
  define(0x87, "astypelate", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0x88, "coerce_u", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x89, "coerce_o", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x90, "negate", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x91, "increment", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x92, "inclocal", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0x93, "decrement", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0x94, "declocal", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0x95, "typeof", OPERANDS_None, 0, 1, 1, 0);
  define(0x96, "not", OPERANDS_None, 0, 1, 1, 0);
  define(0x97, "bitnot", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0xa0, "add", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa1, "subtract", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa2, "multiply", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa3, "divide", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa4, "modulo", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa5, "lshift", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa6, "rshift", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa7, "urshift", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa8, "bitand", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xa9, "bitor", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xaa, "bitxor", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xab, "equals", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xac, "strictequals", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xad, "lessthan", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xae, "lessequals", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xaf, "greaterthan", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xb0, "greaterequals", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xb1, "instanceof", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xb2, "istype", OPERANDS_U30, FLAG_Throws, 1, 1, 0);
  define(0xb3, "istypelate", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xb4, "in", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xc0, "increment_i", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0xc1, "decrement_i", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0xc2, "inclocal_i", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0xc3, "declocal_i", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0xc4, "negate_i", OPERANDS_None, FLAG_Throws, 1, 1, 0);
  define(0xc5, "add_i", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xc6, "subtract_i", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xc7, "multiply_i", OPERANDS_None, FLAG_Throws, 2, 1, 0);
  define(0xd0, "getlocal0", OPERANDS_None, 0, 0, 1, 0);
  define(0xd1, "getlocal1", OPERANDS_None, 0, 0, 1, 0);
  define(0xd2, "getlocal2", OPERANDS_None, 0, 0, 1, 0);
  define(0xd3, "getlocal3", OPERANDS_None, 0, 0, 1, 0);
  define(0xd4, "setlocal0", OPERANDS_None, 0, 1, 0, 0);
  define(0xd5, "setlocal1", OPERANDS_None, 0, 1, 0, 0);
  define(0xd6, "setlocal2", OPERANDS_None, 0, 1, 0, 0);
  define(0xd7, "setlocal3", OPERANDS_None, 0, 1, 0, 0);
  define(0xef, "debug", OPERANDS_Debug, FLAG_Throws, 0, 0, 0);
  define(0xf0, "debugline", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0xf1, "debugfile", OPERANDS_U30, FLAG_Throws, 0, 0, 0);
  define(0xf2, "bkptline", OPERANDS_U30, 0, 0, 0, 0);
  define(0xf3, "timestamp", OPERANDS_None, 0, 0, 0, 0);
}

defineAll();
