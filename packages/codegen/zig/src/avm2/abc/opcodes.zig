// AVM2 instructions (AVM2 overview, chapter 5): how each opcode's
// operands are encoded, whether it can throw, its name and its stack effects.
// tests/unit/codegen/opcodes.test.ts checks the table against avmplus'
// core/opcodes.tbl.
const std = @import("std");

/// An AVM2 opcode: the byte the code holds. Non-exhaustive, as the code
/// holds any byte: one no field names is illegal, and every switch must
/// handle it. The code buffer stays bytes; an instruction's opcode is read
/// as an Op where it is decoded.
pub const Op = enum(u8) {
    bkpt = 0x01,
    nop = 0x02,
    throw = 0x03,
    getsuper = 0x04,
    setsuper = 0x05,
    dxns = 0x06,
    dxnslate = 0x07,
    kill = 0x08,
    label = 0x09,
    ifnlt = 0x0c,
    ifnle = 0x0d,
    ifngt = 0x0e,
    ifnge = 0x0f,
    jump = 0x10,
    iftrue = 0x11,
    iffalse = 0x12,
    ifeq = 0x13,
    ifne = 0x14,
    iflt = 0x15,
    ifle = 0x16,
    ifgt = 0x17,
    ifge = 0x18,
    ifstricteq = 0x19,
    ifstrictne = 0x1a,
    lookupswitch = 0x1b,
    pushwith = 0x1c,
    popscope = 0x1d,
    nextname = 0x1e,
    hasnext = 0x1f,
    pushnull = 0x20,
    pushundefined = 0x21,
    pushfloat = 0x22,
    convert_f = 0x79,
    unplus = 0x7a,
    nextvalue = 0x23,
    pushbyte = 0x24,
    pushshort = 0x25,
    pushtrue = 0x26,
    pushfalse = 0x27,
    pushnan = 0x28,
    pop = 0x29,
    dup = 0x2a,
    swap = 0x2b,
    pushstring = 0x2c,
    pushint = 0x2d,
    pushuint = 0x2e,
    pushdouble = 0x2f,
    pushscope = 0x30,
    pushnamespace = 0x31,
    hasnext2 = 0x32,
    li8 = 0x35,
    li16 = 0x36,
    li32 = 0x37,
    lf32 = 0x38,
    lf64 = 0x39,
    si8 = 0x3a,
    si16 = 0x3b,
    si32 = 0x3c,
    sf32 = 0x3d,
    sf64 = 0x3e,
    newfunction = 0x40,
    call = 0x41,
    construct = 0x42,
    callmethod = 0x43,
    callstatic = 0x44,
    callsuper = 0x45,
    callproperty = 0x46,
    returnvoid = 0x47,
    returnvalue = 0x48,
    constructsuper = 0x49,
    constructprop = 0x4a,
    callproplex = 0x4c,
    callsupervoid = 0x4e,
    callpropvoid = 0x4f,
    sxi1 = 0x50,
    sxi8 = 0x51,
    sxi16 = 0x52,
    applytype = 0x53,
    newobject = 0x55,
    newarray = 0x56,
    newactivation = 0x57,
    newclass = 0x58,
    getdescendants = 0x59,
    newcatch = 0x5a,
    findpropstrict = 0x5d,
    findproperty = 0x5e,
    finddef = 0x5f,
    getlex = 0x60,
    setproperty = 0x61,
    getlocal = 0x62,
    setlocal = 0x63,
    getglobalscope = 0x64,
    getscopeobject = 0x65,
    getproperty = 0x66,
    getouterscope = 0x67,
    initproperty = 0x68,
    deleteproperty = 0x6a,
    getslot = 0x6c,
    setslot = 0x6d,
    getglobalslot = 0x6e,
    setglobalslot = 0x6f,
    convert_s = 0x70,
    esc_xelem = 0x71,
    esc_xattr = 0x72,
    convert_i = 0x73,
    convert_u = 0x74,
    convert_d = 0x75,
    convert_b = 0x76,
    convert_o = 0x77,
    checkfilter = 0x78,
    coerce = 0x80,
    coerce_b = 0x81,
    coerce_a = 0x82,
    coerce_i = 0x83,
    coerce_d = 0x84,
    coerce_s = 0x85,
    astype = 0x86,
    astypelate = 0x87,
    coerce_u = 0x88,
    coerce_o = 0x89,
    negate = 0x90,
    increment = 0x91,
    inclocal = 0x92,
    decrement = 0x93,
    declocal = 0x94,
    typeof = 0x95,
    not = 0x96,
    bitnot = 0x97,
    add = 0xa0,
    subtract = 0xa1,
    multiply = 0xa2,
    divide = 0xa3,
    modulo = 0xa4,
    lshift = 0xa5,
    rshift = 0xa6,
    urshift = 0xa7,
    bitand = 0xa8,
    bitor = 0xa9,
    bitxor = 0xaa,
    equals = 0xab,
    strictequals = 0xac,
    lessthan = 0xad,
    lessequals = 0xae,
    greaterthan = 0xaf,
    greaterequals = 0xb0,
    instanceof = 0xb1,
    istype = 0xb2,
    istypelate = 0xb3,
    in = 0xb4,
    increment_i = 0xc0,
    decrement_i = 0xc1,
    inclocal_i = 0xc2,
    declocal_i = 0xc3,
    negate_i = 0xc4,
    add_i = 0xc5,
    subtract_i = 0xc6,
    multiply_i = 0xc7,
    getlocal0 = 0xd0,
    getlocal1 = 0xd1,
    getlocal2 = 0xd2,
    getlocal3 = 0xd3,
    setlocal0 = 0xd4,
    setlocal1 = 0xd5,
    setlocal2 = 0xd6,
    setlocal3 = 0xd7,
    debug = 0xef,
    debugline = 0xf0,
    debugfile = 0xf1,
    bkptline = 0xf2,
    timestamp = 0xf3,
    _,

    /// Its operands, effects and stack use, from `rows`.
    pub fn info(op: Op) Info {
        return tables.info[@backingInt(op)];
    }

    /// Its name as avmplus' opcodes.tbl spells it, or its hex ("0x00") for
    /// an opcode with none.
    pub fn name(op: Op) []const u8 {
        return tables.names[@backingInt(op)];
    }

    /// The local getlocal0 to getlocal3 read, or null for another opcode.
    pub fn getLocalN(op: Op) ?u32 {
        return inRange(op, .getlocal0, .getlocal3);
    }

    /// The local setlocal0 to setlocal3 write, or null for another opcode.
    pub fn setLocalN(op: Op) ?u32 {
        return inRange(op, .setlocal0, .setlocal3);
    }

    /// Whether it branches: jump, or a conditional branch.
    pub fn isBranch(op: Op) bool {
        const b = @backingInt(op);
        return b >= @backingInt(Op.ifnlt) and b <= @backingInt(Op.ifstrictne);
    }

    /// Whether it branches on a condition.
    pub fn isConditional(op: Op) bool {
        return op.isBranch() and op != .jump;
    }

    /// Its offset from `first` where it is one of first to last, else null.
    fn inRange(op: Op, comptime first: Op, comptime last: Op) ?u32 {
        const b = @backingInt(op);
        if (b < @backingInt(first) or b > @backingInt(last)) {
            return null;
        }

        return b - @backingInt(first);
    }
};

/// How an instruction's operands are encoded after its opcode.
pub const Operands = enum(u8) {
    none = 0,
    u30 = 1,
    u30u30 = 2,
    /// An s24 offset from the next instruction.
    branch = 3,
    byte = 4,
    short = 5,
    /// debug's u8, u30, u8 and u30.
    debug = 6,
    /// lookupswitch's default offset, case count and case offsets.
    switch_table = 7,
    /// An opcode no row names.
    illegal = 0xff,
};

pub const Flags = packed struct(u8) {
    /// It may throw, so the handlers that cover it are reachable from it.
    throws: bool = false,
    /// Control never falls through it to the next instruction.
    terminal: bool = false,
    _: u6 = 0,
};

/// Stack use beyond the fixed pops and pushes, as avmplus' verifier
/// counts it.
pub const Stack = packed struct(u8) {
    /// It pops the runtime parts of its multiname operand.
    multiname: bool = false,
    /// It pops `a` more values, an argument count.
    argc_a: bool = false,
    /// It pops `b` more values, an argument count.
    argc_b: bool = false,
    /// The verifier checks room for one push, whatever it pushes.
    check_push_one: bool = false,
    _: u4 = 0,
};

/// One opcode's row: its encoding, flags, and the values it pops and
/// pushes, as avmplus' verifier checks them, before `stack`'s parts.
pub const Info = struct {
    operands: Operands = .illegal,
    flags: Flags = .{},
    pops: u8 = 0,
    pushes: u8 = 0,
    stack: Stack = .{},
};

const throws: Flags = .{ .throws = true };
const terminal: Flags = .{ .terminal = true };
const throws_terminal: Flags = .{ .throws = true, .terminal = true };

const Row = struct { Op, Operands, Flags, u8, u8, Stack };

const rows = [_]Row{
    .{ .bkpt, .none, .{}, 0, 0, .{} },
    .{ .nop, .none, .{}, 0, 0, .{} },
    .{ .throw, .none, throws_terminal, 1, 0, .{} },
    .{ .getsuper, .u30, throws, 1, 1, .{ .multiname = true } },
    .{ .setsuper, .u30, throws, 2, 0, .{ .multiname = true } },
    .{ .dxns, .u30, throws, 0, 0, .{} },
    .{ .dxnslate, .none, throws, 1, 0, .{} },
    .{ .kill, .u30, .{}, 0, 0, .{} },
    .{ .label, .none, .{}, 0, 0, .{} },
    .{ .ifnlt, .branch, throws, 2, 0, .{} },
    .{ .ifnle, .branch, throws, 2, 0, .{} },
    .{ .ifngt, .branch, throws, 2, 0, .{} },
    .{ .ifnge, .branch, throws, 2, 0, .{} },
    .{ .jump, .branch, terminal, 0, 0, .{} },
    .{ .iftrue, .branch, .{}, 1, 0, .{} },
    .{ .iffalse, .branch, .{}, 1, 0, .{} },
    .{ .ifeq, .branch, throws, 2, 0, .{} },
    .{ .ifne, .branch, throws, 2, 0, .{} },
    .{ .iflt, .branch, throws, 2, 0, .{} },
    .{ .ifle, .branch, throws, 2, 0, .{} },
    .{ .ifgt, .branch, throws, 2, 0, .{} },
    .{ .ifge, .branch, throws, 2, 0, .{} },
    .{ .ifstricteq, .branch, .{}, 2, 0, .{} },
    .{ .ifstrictne, .branch, .{}, 2, 0, .{} },
    .{ .lookupswitch, .switch_table, terminal, 1, 0, .{} },
    .{ .pushwith, .none, throws, 1, 0, .{} },
    .{ .popscope, .none, .{}, 0, 0, .{} },
    .{ .nextname, .none, throws, 2, 1, .{} },
    .{ .hasnext, .none, throws, 2, 1, .{} },
    .{ .pushnull, .none, .{}, 0, 1, .{} },
    .{ .pushundefined, .none, .{}, 0, 1, .{} },
    .{ .pushfloat, .u30, .{}, 0, 1, .{} },
    .{ .convert_f, .none, throws, 1, 1, .{} },
    .{ .unplus, .none, throws, 1, 1, .{} },
    .{ .nextvalue, .none, throws, 2, 1, .{} },
    .{ .pushbyte, .byte, .{}, 0, 1, .{} },
    .{ .pushshort, .short, .{}, 0, 1, .{} },
    .{ .pushtrue, .none, .{}, 0, 1, .{} },
    .{ .pushfalse, .none, .{}, 0, 1, .{} },
    .{ .pushnan, .none, .{}, 0, 1, .{} },
    .{ .pop, .none, .{}, 1, 0, .{} },
    .{ .dup, .none, .{}, 1, 2, .{} },
    .{ .swap, .none, .{}, 2, 2, .{} },
    .{ .pushstring, .u30, .{}, 0, 1, .{} },
    .{ .pushint, .u30, .{}, 0, 1, .{} },
    .{ .pushuint, .u30, .{}, 0, 1, .{} },
    .{ .pushdouble, .u30, .{}, 0, 1, .{} },
    .{ .pushscope, .none, throws, 1, 0, .{} },
    .{ .pushnamespace, .u30, .{}, 0, 1, .{} },
    .{ .hasnext2, .u30u30, throws, 0, 1, .{} },
    .{ .li8, .none, throws, 1, 1, .{} },
    .{ .li16, .none, throws, 1, 1, .{} },
    .{ .li32, .none, throws, 1, 1, .{} },
    .{ .lf32, .none, throws, 1, 1, .{} },
    .{ .lf64, .none, throws, 1, 1, .{} },
    .{ .si8, .none, throws, 2, 0, .{} },
    .{ .si16, .none, throws, 2, 0, .{} },
    .{ .si32, .none, throws, 2, 0, .{} },
    .{ .sf32, .none, throws, 2, 0, .{} },
    .{ .sf64, .none, throws, 2, 0, .{} },
    .{ .newfunction, .u30, throws, 0, 1, .{} },
    .{ .call, .u30, throws, 2, 1, .{ .argc_a = true } },
    .{ .construct, .u30, throws, 1, 1, .{ .argc_a = true } },
    .{ .callmethod, .u30u30, throws, 1, 1, .{ .argc_b = true } },
    .{ .callstatic, .u30u30, throws, 1, 1, .{ .argc_b = true } },
    .{ .callsuper, .u30u30, throws, 1, 1, .{ .multiname = true, .argc_b = true } },
    .{ .callproperty, .u30u30, throws, 1, 1, .{ .multiname = true, .argc_b = true } },
    .{ .returnvoid, .none, terminal, 0, 0, .{} },
    .{ .returnvalue, .none, throws_terminal, 1, 0, .{} },
    .{ .constructsuper, .u30, throws, 1, 0, .{ .argc_a = true } },
    .{ .constructprop, .u30u30, throws, 1, 1, .{ .multiname = true, .argc_b = true } },
    .{ .callproplex, .u30u30, throws, 1, 1, .{ .multiname = true, .argc_b = true } },
    .{ .callsupervoid, .u30u30, throws, 1, 0, .{ .multiname = true, .argc_b = true, .check_push_one = true } },
    .{ .callpropvoid, .u30u30, throws, 1, 0, .{ .multiname = true, .argc_b = true, .check_push_one = true } },
    .{ .sxi1, .none, throws, 1, 1, .{} },
    .{ .sxi8, .none, throws, 1, 1, .{} },
    .{ .sxi16, .none, throws, 1, 1, .{} },
    .{ .applytype, .u30, throws, 1, 1, .{ .argc_a = true } },
    .{ .newobject, .u30, throws, 0, 1, .{} },
    .{ .newarray, .u30, throws, 0, 1, .{} },
    .{ .newactivation, .none, throws, 0, 1, .{} },
    .{ .newclass, .u30, throws, 1, 1, .{} },
    .{ .getdescendants, .u30, throws, 1, 1, .{ .multiname = true } },
    .{ .newcatch, .u30, throws, 0, 1, .{} },
    .{ .findpropstrict, .u30, throws, 0, 1, .{ .multiname = true } },
    .{ .findproperty, .u30, throws, 0, 1, .{ .multiname = true } },
    .{ .finddef, .u30, throws, 0, 1, .{ .multiname = true } },
    .{ .getlex, .u30, throws, 0, 1, .{ .multiname = true } },
    .{ .setproperty, .u30, throws, 2, 0, .{ .multiname = true } },
    .{ .getlocal, .u30, .{}, 0, 1, .{} },
    .{ .setlocal, .u30, .{}, 1, 0, .{} },
    .{ .getglobalscope, .none, .{}, 0, 1, .{} },
    .{ .getscopeobject, .u30, .{}, 0, 1, .{} },
    .{ .getproperty, .u30, throws, 1, 1, .{ .multiname = true } },
    .{ .getouterscope, .u30, .{}, 0, 1, .{} },
    .{ .initproperty, .u30, throws, 2, 0, .{ .multiname = true } },
    .{ .deleteproperty, .u30, throws, 1, 1, .{ .multiname = true } },
    .{ .getslot, .u30, throws, 1, 1, .{} },
    .{ .setslot, .u30, throws, 2, 0, .{} },
    .{ .getglobalslot, .u30, .{}, 0, 1, .{} },
    .{ .setglobalslot, .u30, throws, 1, 0, .{} },
    .{ .convert_s, .none, throws, 1, 1, .{} },
    .{ .esc_xelem, .none, throws, 1, 1, .{} },
    .{ .esc_xattr, .none, throws, 1, 1, .{} },
    .{ .convert_i, .none, throws, 1, 1, .{} },
    .{ .convert_u, .none, throws, 1, 1, .{} },
    .{ .convert_d, .none, throws, 1, 1, .{} },
    .{ .convert_b, .none, throws, 1, 1, .{} },
    .{ .convert_o, .none, throws, 1, 1, .{} },
    .{ .checkfilter, .none, throws, 1, 1, .{} },
    .{ .coerce, .u30, throws, 1, 1, .{} },
    .{ .coerce_b, .none, throws, 1, 1, .{} },
    .{ .coerce_a, .none, throws, 1, 1, .{} },
    .{ .coerce_i, .none, throws, 1, 1, .{} },
    .{ .coerce_d, .none, throws, 1, 1, .{} },
    .{ .coerce_s, .none, throws, 1, 1, .{} },
    .{ .astype, .u30, throws, 1, 1, .{} },
    .{ .astypelate, .none, throws, 2, 1, .{} },
    .{ .coerce_u, .none, throws, 1, 1, .{} },
    .{ .coerce_o, .none, throws, 1, 1, .{} },
    .{ .negate, .none, throws, 1, 1, .{} },
    .{ .increment, .none, throws, 1, 1, .{} },
    .{ .inclocal, .u30, throws, 0, 0, .{} },
    .{ .decrement, .none, throws, 1, 1, .{} },
    .{ .declocal, .u30, throws, 0, 0, .{} },
    .{ .typeof, .none, .{}, 1, 1, .{} },
    .{ .not, .none, .{}, 1, 1, .{} },
    .{ .bitnot, .none, throws, 1, 1, .{} },
    .{ .add, .none, throws, 2, 1, .{} },
    .{ .subtract, .none, throws, 2, 1, .{} },
    .{ .multiply, .none, throws, 2, 1, .{} },
    .{ .divide, .none, throws, 2, 1, .{} },
    .{ .modulo, .none, throws, 2, 1, .{} },
    .{ .lshift, .none, throws, 2, 1, .{} },
    .{ .rshift, .none, throws, 2, 1, .{} },
    .{ .urshift, .none, throws, 2, 1, .{} },
    .{ .bitand, .none, throws, 2, 1, .{} },
    .{ .bitor, .none, throws, 2, 1, .{} },
    .{ .bitxor, .none, throws, 2, 1, .{} },
    .{ .equals, .none, throws, 2, 1, .{} },
    .{ .strictequals, .none, throws, 2, 1, .{} },
    .{ .lessthan, .none, throws, 2, 1, .{} },
    .{ .lessequals, .none, throws, 2, 1, .{} },
    .{ .greaterthan, .none, throws, 2, 1, .{} },
    .{ .greaterequals, .none, throws, 2, 1, .{} },
    .{ .instanceof, .none, throws, 2, 1, .{} },
    .{ .istype, .u30, throws, 1, 1, .{} },
    .{ .istypelate, .none, throws, 2, 1, .{} },
    .{ .in, .none, throws, 2, 1, .{} },
    .{ .increment_i, .none, throws, 1, 1, .{} },
    .{ .decrement_i, .none, throws, 1, 1, .{} },
    .{ .inclocal_i, .u30, throws, 0, 0, .{} },
    .{ .declocal_i, .u30, throws, 0, 0, .{} },
    .{ .negate_i, .none, throws, 1, 1, .{} },
    .{ .add_i, .none, throws, 2, 1, .{} },
    .{ .subtract_i, .none, throws, 2, 1, .{} },
    .{ .multiply_i, .none, throws, 2, 1, .{} },
    .{ .getlocal0, .none, .{}, 0, 1, .{} },
    .{ .getlocal1, .none, .{}, 0, 1, .{} },
    .{ .getlocal2, .none, .{}, 0, 1, .{} },
    .{ .getlocal3, .none, .{}, 0, 1, .{} },
    .{ .setlocal0, .none, .{}, 1, 0, .{} },
    .{ .setlocal1, .none, .{}, 1, 0, .{} },
    .{ .setlocal2, .none, .{}, 1, 0, .{} },
    .{ .setlocal3, .none, .{}, 1, 0, .{} },
    .{ .debug, .debug, throws, 0, 0, .{} },
    .{ .debugline, .u30, throws, 0, 0, .{} },
    .{ .debugfile, .u30, throws, 0, 0, .{} },
    .{ .bkptline, .u30, .{}, 0, 0, .{} },
    .{ .timestamp, .none, .{}, 0, 0, .{} },
};

const Tables = struct {
    info: [256]Info,
    names: [256][]const u8,
};

/// The rows by opcode, made at compile time; an opcode not in `rows` is
/// illegal and named by its hex.
const tables: Tables = blk: {
    @setEvalBranchQuota(100_000);
    var t: Tables = .{ .info = @splat(.{}), .names = undefined };
    for (0..256) |b| {
        const op: Op = @fromBackingInt(b);
        t.names[b] = std.enums.tagName(Op, op) orelse std.fmt.comptimePrint("0x{x:0>2}", .{b});
    }

    for (rows) |row| {
        t.info[@backingInt(row[0])] = .{ .operands = row[1], .flags = row[2], .pops = row[3], .pushes = row[4], .stack = row[5] };
    }

    break :blk t;
};

comptime {
    // Every named opcode has its row, and only one.
    var seen: [256]bool = @splat(false);
    for (rows) |row| {
        if (seen[@backingInt(row[0])]) {
            @compileError("two rows for " ++ @tagName(row[0]));
        }

        seen[@backingInt(row[0])] = true;
    }

    for (std.enums.values(Op)) |op| {
        if (!seen[@backingInt(op)]) {
            @compileError("no row for " ++ @tagName(op));
        }
    }
}

test "the table names and lays out the opcodes" {
    try std.testing.expectEqualStrings("getsuper", Op.getsuper.name());
    const illegal: Op = @fromBackingInt(0x00);
    try std.testing.expectEqual(Operands.illegal, illegal.info().operands);
    try std.testing.expectEqualStrings("0x00", illegal.name());
    try std.testing.expectEqual(throws_terminal, Op.throw.info().flags);
    try std.testing.expectEqual(2, Op.getlocal2.getLocalN());
    try std.testing.expectEqual(null, Op.getlocal.getLocalN());
    try std.testing.expectEqual(3, Op.setlocal3.setLocalN());
}
