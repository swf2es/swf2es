// AVM2 instructions (AVM2 overview, chapter 5): how each opcode's operands
// are encoded, whether it can throw, and its name. tests/unit/codegen/
// opcodes.test.ts checks the table against avmplus' core/opcodes.tbl.
//
// Opcodes not defined here are illegal in ABC 46.16, including the float
// instructions of ABC 47.16 and those avmplus only uses internally.

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

export const opcodeOperands = new StaticArray<u8>(256);
export const opcodeFlags = new StaticArray<u8>(256);
export const opcodeNames = new StaticArray<string>(256);

function define(opcode: i32, name: string, operands: u8, flags: u8): void {
  unchecked((opcodeOperands[opcode] = operands));
  unchecked((opcodeFlags[opcode] = flags));
  unchecked((opcodeNames[opcode] = name));
}

function defineAll(): void {
  for (let opcode = 0; opcode < 256; opcode++) {
    unchecked((opcodeOperands[opcode] = OPERANDS_Illegal));
    unchecked((opcodeNames[opcode] = `0x${opcode < 0x10 ? "0" : ""}${opcode.toString(16)}`));
  }

  define(0x01, "bkpt", OPERANDS_None, 0);
  define(0x02, "nop", OPERANDS_None, 0);
  define(0x03, "throw", OPERANDS_None, FLAG_Throws | FLAG_Terminal);
  define(0x04, "getsuper", OPERANDS_U30, FLAG_Throws);
  define(0x05, "setsuper", OPERANDS_U30, FLAG_Throws);
  define(0x06, "dxns", OPERANDS_U30, FLAG_Throws);
  define(0x07, "dxnslate", OPERANDS_None, FLAG_Throws);
  define(0x08, "kill", OPERANDS_U30, 0);
  define(0x09, "label", OPERANDS_None, 0);
  define(0x0c, "ifnlt", OPERANDS_Branch, FLAG_Throws);
  define(0x0d, "ifnle", OPERANDS_Branch, FLAG_Throws);
  define(0x0e, "ifngt", OPERANDS_Branch, FLAG_Throws);
  define(0x0f, "ifnge", OPERANDS_Branch, FLAG_Throws);
  define(0x10, "jump", OPERANDS_Branch, FLAG_Terminal);
  define(0x11, "iftrue", OPERANDS_Branch, 0);
  define(0x12, "iffalse", OPERANDS_Branch, 0);
  define(0x13, "ifeq", OPERANDS_Branch, FLAG_Throws);
  define(0x14, "ifne", OPERANDS_Branch, FLAG_Throws);
  define(0x15, "iflt", OPERANDS_Branch, FLAG_Throws);
  define(0x16, "ifle", OPERANDS_Branch, FLAG_Throws);
  define(0x17, "ifgt", OPERANDS_Branch, FLAG_Throws);
  define(0x18, "ifge", OPERANDS_Branch, FLAG_Throws);
  define(0x19, "ifstricteq", OPERANDS_Branch, 0);
  define(0x1a, "ifstrictne", OPERANDS_Branch, 0);
  define(0x1b, "lookupswitch", OPERANDS_Switch, FLAG_Terminal);
  define(0x1c, "pushwith", OPERANDS_None, FLAG_Throws);
  define(0x1d, "popscope", OPERANDS_None, 0);
  define(0x1e, "nextname", OPERANDS_None, FLAG_Throws);
  define(0x1f, "hasnext", OPERANDS_None, FLAG_Throws);
  define(0x20, "pushnull", OPERANDS_None, 0);
  define(0x21, "pushundefined", OPERANDS_None, 0);
  define(0x23, "nextvalue", OPERANDS_None, FLAG_Throws);
  define(0x24, "pushbyte", OPERANDS_Byte, 0);
  define(0x25, "pushshort", OPERANDS_Short, 0);
  define(0x26, "pushtrue", OPERANDS_None, 0);
  define(0x27, "pushfalse", OPERANDS_None, 0);
  define(0x28, "pushnan", OPERANDS_None, 0);
  define(0x29, "pop", OPERANDS_None, 0);
  define(0x2a, "dup", OPERANDS_None, 0);
  define(0x2b, "swap", OPERANDS_None, 0);
  define(0x2c, "pushstring", OPERANDS_U30, 0);
  define(0x2d, "pushint", OPERANDS_U30, 0);
  define(0x2e, "pushuint", OPERANDS_U30, 0);
  define(0x2f, "pushdouble", OPERANDS_U30, 0);
  define(0x30, "pushscope", OPERANDS_None, FLAG_Throws);
  define(0x31, "pushnamespace", OPERANDS_U30, 0);
  define(0x32, "hasnext2", OPERANDS_U30U30, FLAG_Throws);
  define(0x35, "li8", OPERANDS_None, FLAG_Throws);
  define(0x36, "li16", OPERANDS_None, FLAG_Throws);
  define(0x37, "li32", OPERANDS_None, FLAG_Throws);
  define(0x38, "lf32", OPERANDS_None, FLAG_Throws);
  define(0x39, "lf64", OPERANDS_None, FLAG_Throws);
  define(0x3a, "si8", OPERANDS_None, FLAG_Throws);
  define(0x3b, "si16", OPERANDS_None, FLAG_Throws);
  define(0x3c, "si32", OPERANDS_None, FLAG_Throws);
  define(0x3d, "sf32", OPERANDS_None, FLAG_Throws);
  define(0x3e, "sf64", OPERANDS_None, FLAG_Throws);
  define(0x40, "newfunction", OPERANDS_U30, FLAG_Throws);
  define(0x41, "call", OPERANDS_U30, FLAG_Throws);
  define(0x42, "construct", OPERANDS_U30, FLAG_Throws);
  define(0x43, "callmethod", OPERANDS_U30U30, FLAG_Throws);
  define(0x44, "callstatic", OPERANDS_U30U30, FLAG_Throws);
  define(0x45, "callsuper", OPERANDS_U30U30, FLAG_Throws);
  define(0x46, "callproperty", OPERANDS_U30U30, FLAG_Throws);
  define(0x47, "returnvoid", OPERANDS_None, FLAG_Terminal);
  define(0x48, "returnvalue", OPERANDS_None, FLAG_Throws | FLAG_Terminal);
  define(0x49, "constructsuper", OPERANDS_U30, FLAG_Throws);
  define(0x4a, "constructprop", OPERANDS_U30U30, FLAG_Throws);
  define(0x4c, "callproplex", OPERANDS_U30U30, FLAG_Throws);
  define(0x4e, "callsupervoid", OPERANDS_U30U30, FLAG_Throws);
  define(0x4f, "callpropvoid", OPERANDS_U30U30, FLAG_Throws);
  define(0x50, "sxi1", OPERANDS_None, FLAG_Throws);
  define(0x51, "sxi8", OPERANDS_None, FLAG_Throws);
  define(0x52, "sxi16", OPERANDS_None, FLAG_Throws);
  define(0x53, "applytype", OPERANDS_U30, FLAG_Throws);
  define(0x55, "newobject", OPERANDS_U30, FLAG_Throws);
  define(0x56, "newarray", OPERANDS_U30, FLAG_Throws);
  define(0x57, "newactivation", OPERANDS_None, FLAG_Throws);
  define(0x58, "newclass", OPERANDS_U30, FLAG_Throws);
  define(0x59, "getdescendants", OPERANDS_U30, FLAG_Throws);
  define(0x5a, "newcatch", OPERANDS_U30, FLAG_Throws);
  define(0x5d, "findpropstrict", OPERANDS_U30, FLAG_Throws);
  define(0x5e, "findproperty", OPERANDS_U30, FLAG_Throws);
  define(0x5f, "finddef", OPERANDS_U30, FLAG_Throws);
  define(0x60, "getlex", OPERANDS_U30, FLAG_Throws);
  define(0x61, "setproperty", OPERANDS_U30, FLAG_Throws);
  define(0x62, "getlocal", OPERANDS_U30, 0);
  define(0x63, "setlocal", OPERANDS_U30, 0);
  define(0x64, "getglobalscope", OPERANDS_None, 0);
  define(0x65, "getscopeobject", OPERANDS_U30, 0);
  define(0x66, "getproperty", OPERANDS_U30, FLAG_Throws);
  define(0x67, "getouterscope", OPERANDS_U30, 0);
  define(0x68, "initproperty", OPERANDS_U30, FLAG_Throws);
  define(0x6a, "deleteproperty", OPERANDS_U30, FLAG_Throws);
  define(0x6c, "getslot", OPERANDS_U30, FLAG_Throws);
  define(0x6d, "setslot", OPERANDS_U30, FLAG_Throws);
  define(0x6e, "getglobalslot", OPERANDS_U30, 0);
  define(0x6f, "setglobalslot", OPERANDS_U30, FLAG_Throws);
  define(0x70, "convert_s", OPERANDS_None, FLAG_Throws);
  define(0x71, "esc_xelem", OPERANDS_None, FLAG_Throws);
  define(0x72, "esc_xattr", OPERANDS_None, FLAG_Throws);
  define(0x73, "convert_i", OPERANDS_None, FLAG_Throws);
  define(0x74, "convert_u", OPERANDS_None, FLAG_Throws);
  define(0x75, "convert_d", OPERANDS_None, FLAG_Throws);
  define(0x76, "convert_b", OPERANDS_None, FLAG_Throws);
  define(0x77, "convert_o", OPERANDS_None, FLAG_Throws);
  define(0x78, "checkfilter", OPERANDS_None, FLAG_Throws);
  define(0x80, "coerce", OPERANDS_U30, FLAG_Throws);
  define(0x81, "coerce_b", OPERANDS_None, FLAG_Throws);
  define(0x82, "coerce_a", OPERANDS_None, FLAG_Throws);
  define(0x83, "coerce_i", OPERANDS_None, FLAG_Throws);
  define(0x84, "coerce_d", OPERANDS_None, FLAG_Throws);
  define(0x85, "coerce_s", OPERANDS_None, FLAG_Throws);
  define(0x86, "astype", OPERANDS_U30, FLAG_Throws);
  define(0x87, "astypelate", OPERANDS_None, FLAG_Throws);
  define(0x88, "coerce_u", OPERANDS_None, FLAG_Throws);
  define(0x89, "coerce_o", OPERANDS_None, FLAG_Throws);
  define(0x90, "negate", OPERANDS_None, FLAG_Throws);
  define(0x91, "increment", OPERANDS_None, FLAG_Throws);
  define(0x92, "inclocal", OPERANDS_U30, FLAG_Throws);
  define(0x93, "decrement", OPERANDS_None, FLAG_Throws);
  define(0x94, "declocal", OPERANDS_U30, FLAG_Throws);
  define(0x95, "typeof", OPERANDS_None, 0);
  define(0x96, "not", OPERANDS_None, 0);
  define(0x97, "bitnot", OPERANDS_None, FLAG_Throws);
  define(0xa0, "add", OPERANDS_None, FLAG_Throws);
  define(0xa1, "subtract", OPERANDS_None, FLAG_Throws);
  define(0xa2, "multiply", OPERANDS_None, FLAG_Throws);
  define(0xa3, "divide", OPERANDS_None, FLAG_Throws);
  define(0xa4, "modulo", OPERANDS_None, FLAG_Throws);
  define(0xa5, "lshift", OPERANDS_None, FLAG_Throws);
  define(0xa6, "rshift", OPERANDS_None, FLAG_Throws);
  define(0xa7, "urshift", OPERANDS_None, FLAG_Throws);
  define(0xa8, "bitand", OPERANDS_None, FLAG_Throws);
  define(0xa9, "bitor", OPERANDS_None, FLAG_Throws);
  define(0xaa, "bitxor", OPERANDS_None, FLAG_Throws);
  define(0xab, "equals", OPERANDS_None, FLAG_Throws);
  define(0xac, "strictequals", OPERANDS_None, FLAG_Throws);
  define(0xad, "lessthan", OPERANDS_None, FLAG_Throws);
  define(0xae, "lessequals", OPERANDS_None, FLAG_Throws);
  define(0xaf, "greaterthan", OPERANDS_None, FLAG_Throws);
  define(0xb0, "greaterequals", OPERANDS_None, FLAG_Throws);
  define(0xb1, "instanceof", OPERANDS_None, FLAG_Throws);
  define(0xb2, "istype", OPERANDS_U30, FLAG_Throws);
  define(0xb3, "istypelate", OPERANDS_None, FLAG_Throws);
  define(0xb4, "in", OPERANDS_None, FLAG_Throws);
  define(0xc0, "increment_i", OPERANDS_None, FLAG_Throws);
  define(0xc1, "decrement_i", OPERANDS_None, FLAG_Throws);
  define(0xc2, "inclocal_i", OPERANDS_U30, FLAG_Throws);
  define(0xc3, "declocal_i", OPERANDS_U30, FLAG_Throws);
  define(0xc4, "negate_i", OPERANDS_None, FLAG_Throws);
  define(0xc5, "add_i", OPERANDS_None, FLAG_Throws);
  define(0xc6, "subtract_i", OPERANDS_None, FLAG_Throws);
  define(0xc7, "multiply_i", OPERANDS_None, FLAG_Throws);
  define(0xd0, "getlocal0", OPERANDS_None, 0);
  define(0xd1, "getlocal1", OPERANDS_None, 0);
  define(0xd2, "getlocal2", OPERANDS_None, 0);
  define(0xd3, "getlocal3", OPERANDS_None, 0);
  define(0xd4, "setlocal0", OPERANDS_None, 0);
  define(0xd5, "setlocal1", OPERANDS_None, 0);
  define(0xd6, "setlocal2", OPERANDS_None, 0);
  define(0xd7, "setlocal3", OPERANDS_None, 0);
  define(0xef, "debug", OPERANDS_Debug, FLAG_Throws);
  define(0xf0, "debugline", OPERANDS_U30, FLAG_Throws);
  define(0xf1, "debugfile", OPERANDS_U30, FLAG_Throws);
  define(0xf2, "bkptline", OPERANDS_U30, 0);
  define(0xf3, "timestamp", OPERANDS_None, 0);
}

defineAll();
