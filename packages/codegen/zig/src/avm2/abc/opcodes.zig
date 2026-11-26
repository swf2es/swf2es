// AVM2 instructions (AVM2 overview, chapter 5): how each opcode's
// operands are encoded, whether it can throw, its name and its stack effects.
// tests/unit/codegen/opcodes.test.ts checks the table against avmplus'
// core/opcodes.tbl.
const std = @import("std");

pub const OPERANDS_None: u8 = 0;
pub const OPERANDS_U30: u8 = 1;
pub const OPERANDS_U30U30: u8 = 2;
pub const OPERANDS_Branch: u8 = 3;
pub const OPERANDS_Byte: u8 = 4;
pub const OPERANDS_Short: u8 = 5;
pub const OPERANDS_Debug: u8 = 6;
pub const OPERANDS_Switch: u8 = 7;
pub const OPERANDS_Illegal: u8 = 0xff;
pub const FLAG_Throws: u8 = 1;
pub const FLAG_Terminal: u8 = 2;
pub const STACK_Multiname: u8 = 1;
pub const STACK_ArgcA: u8 = 2;
pub const STACK_ArgcB: u8 = 4;
pub const STACK_CheckPushOne: u8 = 8;
pub const OP_bkpt: u8 = 0x01;
pub const OP_nop: u8 = 0x02;
pub const OP_throw: u8 = 0x03;
pub const OP_getsuper: u8 = 0x04;
pub const OP_setsuper: u8 = 0x05;
pub const OP_dxns: u8 = 0x06;
pub const OP_dxnslate: u8 = 0x07;
pub const OP_kill: u8 = 0x08;
pub const OP_label: u8 = 0x09;
pub const OP_ifnlt: u8 = 0x0c;
pub const OP_ifnle: u8 = 0x0d;
pub const OP_ifngt: u8 = 0x0e;
pub const OP_ifnge: u8 = 0x0f;
pub const OP_jump: u8 = 0x10;
pub const OP_iftrue: u8 = 0x11;
pub const OP_iffalse: u8 = 0x12;
pub const OP_ifeq: u8 = 0x13;
pub const OP_ifne: u8 = 0x14;
pub const OP_iflt: u8 = 0x15;
pub const OP_ifle: u8 = 0x16;
pub const OP_ifgt: u8 = 0x17;
pub const OP_ifge: u8 = 0x18;
pub const OP_ifstricteq: u8 = 0x19;
pub const OP_ifstrictne: u8 = 0x1a;
pub const OP_lookupswitch: u8 = 0x1b;
pub const OP_pushwith: u8 = 0x1c;
pub const OP_popscope: u8 = 0x1d;
pub const OP_nextname: u8 = 0x1e;
pub const OP_hasnext: u8 = 0x1f;
pub const OP_pushnull: u8 = 0x20;
pub const OP_pushundefined: u8 = 0x21;
pub const OP_nextvalue: u8 = 0x23;
pub const OP_pushbyte: u8 = 0x24;
pub const OP_pushshort: u8 = 0x25;
pub const OP_pushtrue: u8 = 0x26;
pub const OP_pushfalse: u8 = 0x27;
pub const OP_pushnan: u8 = 0x28;
pub const OP_pop: u8 = 0x29;
pub const OP_dup: u8 = 0x2a;
pub const OP_swap: u8 = 0x2b;
pub const OP_pushstring: u8 = 0x2c;
pub const OP_pushint: u8 = 0x2d;
pub const OP_pushuint: u8 = 0x2e;
pub const OP_pushdouble: u8 = 0x2f;
pub const OP_pushfloat: u8 = 0x22;
pub const OP_convert_f: u8 = 0x79;
pub const OP_unplus: u8 = 0x7a;
pub const OP_pushscope: u8 = 0x30;
pub const OP_pushnamespace: u8 = 0x31;
pub const OP_hasnext2: u8 = 0x32;
pub const OP_li8: u8 = 0x35;
pub const OP_li16: u8 = 0x36;
pub const OP_li32: u8 = 0x37;
pub const OP_lf32: u8 = 0x38;
pub const OP_lf64: u8 = 0x39;
pub const OP_si8: u8 = 0x3a;
pub const OP_si16: u8 = 0x3b;
pub const OP_si32: u8 = 0x3c;
pub const OP_sf32: u8 = 0x3d;
pub const OP_sf64: u8 = 0x3e;
pub const OP_newfunction: u8 = 0x40;
pub const OP_call: u8 = 0x41;
pub const OP_construct: u8 = 0x42;
pub const OP_callmethod: u8 = 0x43;
pub const OP_callstatic: u8 = 0x44;
pub const OP_callsuper: u8 = 0x45;
pub const OP_callproperty: u8 = 0x46;
pub const OP_returnvoid: u8 = 0x47;
pub const OP_returnvalue: u8 = 0x48;
pub const OP_constructsuper: u8 = 0x49;
pub const OP_constructprop: u8 = 0x4a;
pub const OP_callproplex: u8 = 0x4c;
pub const OP_callsupervoid: u8 = 0x4e;
pub const OP_callpropvoid: u8 = 0x4f;
pub const OP_sxi1: u8 = 0x50;
pub const OP_sxi8: u8 = 0x51;
pub const OP_sxi16: u8 = 0x52;
pub const OP_applytype: u8 = 0x53;
pub const OP_newobject: u8 = 0x55;
pub const OP_newarray: u8 = 0x56;
pub const OP_newactivation: u8 = 0x57;
pub const OP_newclass: u8 = 0x58;
pub const OP_getdescendants: u8 = 0x59;
pub const OP_newcatch: u8 = 0x5a;
pub const OP_findpropstrict: u8 = 0x5d;
pub const OP_findproperty: u8 = 0x5e;
pub const OP_finddef: u8 = 0x5f;
pub const OP_getlex: u8 = 0x60;
pub const OP_setproperty: u8 = 0x61;
pub const OP_getlocal: u8 = 0x62;
pub const OP_setlocal: u8 = 0x63;
pub const OP_getglobalscope: u8 = 0x64;
pub const OP_getscopeobject: u8 = 0x65;
pub const OP_getproperty: u8 = 0x66;
pub const OP_getouterscope: u8 = 0x67;
pub const OP_initproperty: u8 = 0x68;
pub const OP_deleteproperty: u8 = 0x6a;
pub const OP_getslot: u8 = 0x6c;
pub const OP_setslot: u8 = 0x6d;
pub const OP_getglobalslot: u8 = 0x6e;
pub const OP_setglobalslot: u8 = 0x6f;
pub const OP_convert_s: u8 = 0x70;
pub const OP_esc_xelem: u8 = 0x71;
pub const OP_esc_xattr: u8 = 0x72;
pub const OP_convert_i: u8 = 0x73;
pub const OP_convert_u: u8 = 0x74;
pub const OP_convert_d: u8 = 0x75;
pub const OP_convert_b: u8 = 0x76;
pub const OP_convert_o: u8 = 0x77;
pub const OP_checkfilter: u8 = 0x78;
pub const OP_coerce: u8 = 0x80;
pub const OP_coerce_b: u8 = 0x81;
pub const OP_coerce_a: u8 = 0x82;
pub const OP_coerce_i: u8 = 0x83;
pub const OP_coerce_d: u8 = 0x84;
pub const OP_coerce_s: u8 = 0x85;
pub const OP_astype: u8 = 0x86;
pub const OP_astypelate: u8 = 0x87;
pub const OP_coerce_u: u8 = 0x88;
pub const OP_coerce_o: u8 = 0x89;
pub const OP_negate: u8 = 0x90;
pub const OP_increment: u8 = 0x91;
pub const OP_inclocal: u8 = 0x92;
pub const OP_decrement: u8 = 0x93;
pub const OP_declocal: u8 = 0x94;
pub const OP_typeof: u8 = 0x95;
pub const OP_not: u8 = 0x96;
pub const OP_bitnot: u8 = 0x97;
pub const OP_add: u8 = 0xa0;
pub const OP_subtract: u8 = 0xa1;
pub const OP_multiply: u8 = 0xa2;
pub const OP_divide: u8 = 0xa3;
pub const OP_modulo: u8 = 0xa4;
pub const OP_lshift: u8 = 0xa5;
pub const OP_rshift: u8 = 0xa6;
pub const OP_urshift: u8 = 0xa7;
pub const OP_bitand: u8 = 0xa8;
pub const OP_bitor: u8 = 0xa9;
pub const OP_bitxor: u8 = 0xaa;
pub const OP_equals: u8 = 0xab;
pub const OP_strictequals: u8 = 0xac;
pub const OP_lessthan: u8 = 0xad;
pub const OP_lessequals: u8 = 0xae;
pub const OP_greaterthan: u8 = 0xaf;
pub const OP_greaterequals: u8 = 0xb0;
pub const OP_instanceof: u8 = 0xb1;
pub const OP_istype: u8 = 0xb2;
pub const OP_istypelate: u8 = 0xb3;
pub const OP_in: u8 = 0xb4;
pub const OP_increment_i: u8 = 0xc0;
pub const OP_decrement_i: u8 = 0xc1;
pub const OP_inclocal_i: u8 = 0xc2;
pub const OP_declocal_i: u8 = 0xc3;
pub const OP_negate_i: u8 = 0xc4;
pub const OP_add_i: u8 = 0xc5;
pub const OP_subtract_i: u8 = 0xc6;
pub const OP_multiply_i: u8 = 0xc7;
pub const OP_getlocal0: u8 = 0xd0;
pub const OP_getlocal1: u8 = 0xd1;
pub const OP_getlocal2: u8 = 0xd2;
pub const OP_getlocal3: u8 = 0xd3;
pub const OP_setlocal0: u8 = 0xd4;
pub const OP_setlocal1: u8 = 0xd5;
pub const OP_setlocal2: u8 = 0xd6;
pub const OP_setlocal3: u8 = 0xd7;
pub const OP_debug: u8 = 0xef;
pub const OP_debugline: u8 = 0xf0;
pub const OP_debugfile: u8 = 0xf1;
pub const OP_bkptline: u8 = 0xf2;
pub const OP_timestamp: u8 = 0xf3;

/// One opcode's row of the table.
const Row = struct { u8, []const u8, u8, u8, u8, u8, u8 };

const rows = [_]Row{
    .{ 0x01, "bkpt", OPERANDS_None, 0, 0, 0, 0 },
    .{ 0x02, "nop", OPERANDS_None, 0, 0, 0, 0 },
    .{ 0x03, "throw", OPERANDS_None, FLAG_Throws | FLAG_Terminal, 1, 0, 0 },
    .{ 0x04, "getsuper", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname },
    .{ 0x05, "setsuper", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname },
    .{ 0x06, "dxns", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0x07, "dxnslate", OPERANDS_None, FLAG_Throws, 1, 0, 0 },
    .{ 0x08, "kill", OPERANDS_U30, 0, 0, 0, 0 },
    .{ 0x09, "label", OPERANDS_None, 0, 0, 0, 0 },
    .{ 0x0c, "ifnlt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x0d, "ifnle", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x0e, "ifngt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x0f, "ifnge", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x10, "jump", OPERANDS_Branch, FLAG_Terminal, 0, 0, 0 },
    .{ 0x11, "iftrue", OPERANDS_Branch, 0, 1, 0, 0 },
    .{ 0x12, "iffalse", OPERANDS_Branch, 0, 1, 0, 0 },
    .{ 0x13, "ifeq", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x14, "ifne", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x15, "iflt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x16, "ifle", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x17, "ifgt", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x18, "ifge", OPERANDS_Branch, FLAG_Throws, 2, 0, 0 },
    .{ 0x19, "ifstricteq", OPERANDS_Branch, 0, 2, 0, 0 },
    .{ 0x1a, "ifstrictne", OPERANDS_Branch, 0, 2, 0, 0 },
    .{ 0x1b, "lookupswitch", OPERANDS_Switch, FLAG_Terminal, 1, 0, 0 },
    .{ 0x1c, "pushwith", OPERANDS_None, FLAG_Throws, 1, 0, 0 },
    .{ 0x1d, "popscope", OPERANDS_None, 0, 0, 0, 0 },
    .{ 0x1e, "nextname", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0x1f, "hasnext", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0x20, "pushnull", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x21, "pushundefined", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x22, "pushfloat", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x79, "convert_f", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x7a, "unplus", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x23, "nextvalue", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0x24, "pushbyte", OPERANDS_Byte, 0, 0, 1, 0 },
    .{ 0x25, "pushshort", OPERANDS_Short, 0, 0, 1, 0 },
    .{ 0x26, "pushtrue", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x27, "pushfalse", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x28, "pushnan", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x29, "pop", OPERANDS_None, 0, 1, 0, 0 },
    .{ 0x2a, "dup", OPERANDS_None, 0, 1, 2, 0 },
    .{ 0x2b, "swap", OPERANDS_None, 0, 2, 2, 0 },
    .{ 0x2c, "pushstring", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x2d, "pushint", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x2e, "pushuint", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x2f, "pushdouble", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x30, "pushscope", OPERANDS_None, FLAG_Throws, 1, 0, 0 },
    .{ 0x31, "pushnamespace", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x32, "hasnext2", OPERANDS_U30U30, FLAG_Throws, 0, 1, 0 },
    .{ 0x35, "li8", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x36, "li16", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x37, "li32", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x38, "lf32", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x39, "lf64", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x3a, "si8", OPERANDS_None, FLAG_Throws, 2, 0, 0 },
    .{ 0x3b, "si16", OPERANDS_None, FLAG_Throws, 2, 0, 0 },
    .{ 0x3c, "si32", OPERANDS_None, FLAG_Throws, 2, 0, 0 },
    .{ 0x3d, "sf32", OPERANDS_None, FLAG_Throws, 2, 0, 0 },
    .{ 0x3e, "sf64", OPERANDS_None, FLAG_Throws, 2, 0, 0 },
    .{ 0x40, "newfunction", OPERANDS_U30, FLAG_Throws, 0, 1, 0 },
    .{ 0x41, "call", OPERANDS_U30, FLAG_Throws, 2, 1, STACK_ArgcA },
    .{ 0x42, "construct", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_ArgcA },
    .{ 0x43, "callmethod", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_ArgcB },
    .{ 0x44, "callstatic", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_ArgcB },
    .{ 0x45, "callsuper", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB },
    .{ 0x46, "callproperty", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB },
    .{ 0x47, "returnvoid", OPERANDS_None, FLAG_Terminal, 0, 0, 0 },
    .{ 0x48, "returnvalue", OPERANDS_None, FLAG_Throws | FLAG_Terminal, 1, 0, 0 },
    .{ 0x49, "constructsuper", OPERANDS_U30, FLAG_Throws, 1, 0, STACK_ArgcA },
    .{ 0x4a, "constructprop", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB },
    .{ 0x4c, "callproplex", OPERANDS_U30U30, FLAG_Throws, 1, 1, STACK_Multiname | STACK_ArgcB },
    .{ 0x4e, "callsupervoid", OPERANDS_U30U30, FLAG_Throws, 1, 0, STACK_Multiname | STACK_ArgcB | STACK_CheckPushOne },
    .{ 0x4f, "callpropvoid", OPERANDS_U30U30, FLAG_Throws, 1, 0, STACK_Multiname | STACK_ArgcB | STACK_CheckPushOne },
    .{ 0x50, "sxi1", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x51, "sxi8", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x52, "sxi16", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x53, "applytype", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_ArgcA },
    .{ 0x55, "newobject", OPERANDS_U30, FLAG_Throws, 0, 1, 0 },
    .{ 0x56, "newarray", OPERANDS_U30, FLAG_Throws, 0, 1, 0 },
    .{ 0x57, "newactivation", OPERANDS_None, FLAG_Throws, 0, 1, 0 },
    .{ 0x58, "newclass", OPERANDS_U30, FLAG_Throws, 1, 1, 0 },
    .{ 0x59, "getdescendants", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname },
    .{ 0x5a, "newcatch", OPERANDS_U30, FLAG_Throws, 0, 1, 0 },
    .{ 0x5d, "findpropstrict", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname },
    .{ 0x5e, "findproperty", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname },
    .{ 0x5f, "finddef", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname },
    .{ 0x60, "getlex", OPERANDS_U30, FLAG_Throws, 0, 1, STACK_Multiname },
    .{ 0x61, "setproperty", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname },
    .{ 0x62, "getlocal", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x63, "setlocal", OPERANDS_U30, 0, 1, 0, 0 },
    .{ 0x64, "getglobalscope", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0x65, "getscopeobject", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x66, "getproperty", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname },
    .{ 0x67, "getouterscope", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x68, "initproperty", OPERANDS_U30, FLAG_Throws, 2, 0, STACK_Multiname },
    .{ 0x6a, "deleteproperty", OPERANDS_U30, FLAG_Throws, 1, 1, STACK_Multiname },
    .{ 0x6c, "getslot", OPERANDS_U30, FLAG_Throws, 1, 1, 0 },
    .{ 0x6d, "setslot", OPERANDS_U30, FLAG_Throws, 2, 0, 0 },
    .{ 0x6e, "getglobalslot", OPERANDS_U30, 0, 0, 1, 0 },
    .{ 0x6f, "setglobalslot", OPERANDS_U30, FLAG_Throws, 1, 0, 0 },
    .{ 0x70, "convert_s", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x71, "esc_xelem", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x72, "esc_xattr", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x73, "convert_i", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x74, "convert_u", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x75, "convert_d", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x76, "convert_b", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x77, "convert_o", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x78, "checkfilter", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x80, "coerce", OPERANDS_U30, FLAG_Throws, 1, 1, 0 },
    .{ 0x81, "coerce_b", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x82, "coerce_a", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x83, "coerce_i", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x84, "coerce_d", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x85, "coerce_s", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x86, "astype", OPERANDS_U30, FLAG_Throws, 1, 1, 0 },
    .{ 0x87, "astypelate", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0x88, "coerce_u", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x89, "coerce_o", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x90, "negate", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x91, "increment", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x92, "inclocal", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0x93, "decrement", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0x94, "declocal", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0x95, "typeof", OPERANDS_None, 0, 1, 1, 0 },
    .{ 0x96, "not", OPERANDS_None, 0, 1, 1, 0 },
    .{ 0x97, "bitnot", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0xa0, "add", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa1, "subtract", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa2, "multiply", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa3, "divide", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa4, "modulo", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa5, "lshift", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa6, "rshift", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa7, "urshift", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa8, "bitand", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xa9, "bitor", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xaa, "bitxor", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xab, "equals", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xac, "strictequals", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xad, "lessthan", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xae, "lessequals", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xaf, "greaterthan", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xb0, "greaterequals", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xb1, "instanceof", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xb2, "istype", OPERANDS_U30, FLAG_Throws, 1, 1, 0 },
    .{ 0xb3, "istypelate", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xb4, "in", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xc0, "increment_i", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0xc1, "decrement_i", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0xc2, "inclocal_i", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0xc3, "declocal_i", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0xc4, "negate_i", OPERANDS_None, FLAG_Throws, 1, 1, 0 },
    .{ 0xc5, "add_i", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xc6, "subtract_i", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xc7, "multiply_i", OPERANDS_None, FLAG_Throws, 2, 1, 0 },
    .{ 0xd0, "getlocal0", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0xd1, "getlocal1", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0xd2, "getlocal2", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0xd3, "getlocal3", OPERANDS_None, 0, 0, 1, 0 },
    .{ 0xd4, "setlocal0", OPERANDS_None, 0, 1, 0, 0 },
    .{ 0xd5, "setlocal1", OPERANDS_None, 0, 1, 0, 0 },
    .{ 0xd6, "setlocal2", OPERANDS_None, 0, 1, 0, 0 },
    .{ 0xd7, "setlocal3", OPERANDS_None, 0, 1, 0, 0 },
    .{ 0xef, "debug", OPERANDS_Debug, FLAG_Throws, 0, 0, 0 },
    .{ 0xf0, "debugline", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0xf1, "debugfile", OPERANDS_U30, FLAG_Throws, 0, 0, 0 },
    .{ 0xf2, "bkptline", OPERANDS_U30, 0, 0, 0, 0 },
    .{ 0xf3, "timestamp", OPERANDS_None, 0, 0, 0, 0 },
};

/// The tables by opcode, made at compile time; an opcode not in `rows` is illegal and named by its hex.
const Tables = struct {
    operands: [256]u8,
    flags: [256]u8,
    names: [256][]const u8,
    pops: [256]u8,
    pushes: [256]u8,
    stack: [256]u8,
};

const tables: Tables = blk: {
    @setEvalBranchQuota(100_000);
    var t: Tables = .{
        .operands = @splat(OPERANDS_Illegal),
        .flags = @splat(0),
        .names = undefined,
        .pops = @splat(0),
        .pushes = @splat(0),
        .stack = @splat(0),
    };
    for (0..256) |op| {
        t.names[op] = std.fmt.comptimePrint("0x{x:0>2}", .{op});
    }

    for (rows) |row| {
        t.operands[row[0]] = row[2];
        t.flags[row[0]] = row[3];
        t.names[row[0]] = row[1];
        t.pops[row[0]] = row[4];
        t.pushes[row[0]] = row[5];
        t.stack[row[0]] = row[6];
    }

    break :blk t;
};

pub const opcodeOperands = &tables.operands;
pub const opcodeFlags = &tables.flags;
pub const opcodeNames = &tables.names;
/// Values popped and pushed, as avmplus' verifier checks them, before STACK_* parts.
pub const opcodePops = &tables.pops;
pub const opcodePushes = &tables.pushes;
pub const opcodeStack = &tables.stack;

test "the table names and lays out the opcodes" {
    try std.testing.expectEqualStrings("getsuper", opcodeNames[OP_getsuper]);
    try std.testing.expectEqual(OPERANDS_Illegal, opcodeOperands[0x00]);
    try std.testing.expectEqualStrings("0x00", opcodeNames[0x00]);
    try std.testing.expectEqual(FLAG_Throws | FLAG_Terminal, opcodeFlags[OP_throw]);
}
