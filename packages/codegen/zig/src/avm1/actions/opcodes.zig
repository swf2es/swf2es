// AVM1 actions, SWF 3 to 10 (SWF file format specification, chapter 5):
// their opcodes and names. An action from 0x80 is followed by a u16 length
// and that many bytes of operands; one below has none.
//
// An opcode not named here is unknown: Flash skips it, as its length says,
// and goes on with the next action.
const std = @import("std");

pub const Op = enum(u8) {
    end = 0x00,
    next_frame = 0x04,
    previous_frame = 0x05,
    play = 0x06,
    stop = 0x07,
    toggle_quality = 0x08,
    stop_sounds = 0x09,
    add = 0x0a,
    subtract = 0x0b,
    multiply = 0x0c,
    divide = 0x0d,
    equals = 0x0e,
    less = 0x0f,
    @"and" = 0x10,
    @"or" = 0x11,
    not = 0x12,
    string_equals = 0x13,
    string_length = 0x14,
    string_extract = 0x15,
    pop = 0x17,
    to_integer = 0x18,
    get_variable = 0x1c,
    set_variable = 0x1d,
    set_target2 = 0x20,
    string_add = 0x21,
    get_property = 0x22,
    set_property = 0x23,
    clone_sprite = 0x24,
    remove_sprite = 0x25,
    trace = 0x26,
    start_drag = 0x27,
    end_drag = 0x28,
    string_less = 0x29,
    throw = 0x2a,
    cast_op = 0x2b,
    implements_op = 0x2c,
    random_number = 0x30,
    mb_string_length = 0x31,
    char_to_ascii = 0x32,
    ascii_to_char = 0x33,
    get_time = 0x34,
    mb_string_extract = 0x35,
    mb_char_to_ascii = 0x36,
    mb_ascii_to_char = 0x37,
    delete = 0x3a,
    delete2 = 0x3b,
    define_local = 0x3c,
    call_function = 0x3d,
    @"return" = 0x3e,
    modulo = 0x3f,
    new_object = 0x40,
    define_local2 = 0x41,
    init_array = 0x42,
    init_object = 0x43,
    type_of = 0x44,
    target_path = 0x45,
    enumerate = 0x46,
    add2 = 0x47,
    less2 = 0x48,
    equals2 = 0x49,
    to_number = 0x4a,
    to_string = 0x4b,
    push_duplicate = 0x4c,
    stack_swap = 0x4d,
    get_member = 0x4e,
    set_member = 0x4f,
    increment = 0x50,
    decrement = 0x51,
    call_method = 0x52,
    new_method = 0x53,
    instance_of = 0x54,
    enumerate2 = 0x55,
    bit_and = 0x60,
    bit_or = 0x61,
    bit_xor = 0x62,
    bit_l_shift = 0x63,
    bit_r_shift = 0x64,
    bit_u_r_shift = 0x65,
    strict_equals = 0x66,
    greater = 0x67,
    string_greater = 0x68,
    extends = 0x69,
    goto_frame = 0x81,
    get_url = 0x83,
    store_register = 0x87,
    constant_pool = 0x88,
    wait_for_frame = 0x8a,
    set_target = 0x8b,
    goto_label = 0x8c,
    wait_for_frame2 = 0x8d,
    define_function2 = 0x8e,
    @"try" = 0x8f,
    with = 0x94,
    push = 0x96,
    jump = 0x99,
    get_url2 = 0x9a,
    define_function = 0x9b,
    @"if" = 0x9d,
    call = 0x9e,
    goto_frame2 = 0x9f,
    _,

    /// Whether Flash knows the action.
    pub fn known(op: Op) bool {
        return tables.known[@backingInt(op)];
    }

    /// The action's name as the specification spells it, "MBStringLength",
    /// or its hex ("0x01") for one Flash does not know, as AVM2's Op.name.
    pub fn name(op: Op) []const u8 {
        return tables.names[@backingInt(op)];
    }

    /// Whether an action of this opcode has operands, a length and its bytes.
    pub fn hasOperands(op: Op) bool {
        return @backingInt(op) >= 0x80;
    }
};

/// Push's value types.
pub const PushType = enum(u8) {
    string = 0,
    /// A float, widened to a double.
    float = 1,
    null = 2,
    undefined = 3,
    register = 4,
    boolean = 5,
    /// A double stored as two little-endian words, the high one first.
    double = 6,
    /// An i32, which AVM1 pushes as a number.
    integer = 7,
    /// A u8 index into the constant pool.
    constant8 = 8,
    /// A u16 index into the constant pool.
    constant16 = 9,
    _,
};

/// DefineFunction2's flags; the rest of the u16 is ignored.
pub const FunctionFlags = packed struct(u16) {
    preload_this: bool = false,
    suppress_this: bool = false,
    preload_arguments: bool = false,
    suppress_arguments: bool = false,
    preload_super: bool = false,
    suppress_super: bool = false,
    preload_root: bool = false,
    preload_parent: bool = false,
    preload_global: bool = false,
    _: u7 = 0,

    pub const mask: u16 = 0x1ff;
};

/// Try's flags.
pub const TryFlags = packed struct(u8) {
    catch_block: bool = false,
    finally_block: bool = false,
    /// The caught value goes to a register, not a variable.
    catch_in_register: bool = false,
    _: u5 = 0,

    pub const mask: u8 = 7;
};

/// GetUrl2's method, the low two bits of its flags, of which 3 is read as none.
pub const geturl_method_mask: u8 = 3;

const Tables = struct {
    names: [256][]const u8,
    known: [256]bool,
};

/// "mb_string_length" as the specification names it, "MBStringLength".
fn specName(comptime tag: []const u8) []const u8 {
    comptime var text: []const u8 = "";
    comptime var upper = true;
    comptime var i = 0;
    inline while (i < tag.len) : (i += 1) {
        if (tag[i] == '_') {
            upper = true;
        } else if (i == 0 and std.mem.startsWith(u8, tag, "mb_")) {
            text = text ++ "MB";
            i += 2;
            upper = true;
        } else {
            text = text ++ .{if (upper) std.ascii.toUpper(tag[i]) else tag[i]};
            upper = false;
        }
    }

    return text;
}

const tables: Tables = blk: {
    @setEvalBranchQuota(100000);
    var t: Tables = .{ .names = undefined, .known = @splat(false) };
    for (0..256) |b| {
        t.names[b] = std.fmt.comptimePrint("0x{x:0>2}", .{b});
    }

    for (std.enums.values(Op)) |op| {
        t.names[@backingInt(op)] = specName(@tagName(op));
        t.known[@backingInt(op)] = true;
    }

    break :blk t;
};

test "opcodes, their names and which are known" {
    try std.testing.expectEqualStrings("Push", Op.push.name());
    try std.testing.expectEqualStrings("PreviousFrame", Op.previous_frame.name());
    try std.testing.expectEqualStrings("MBStringLength", Op.mb_string_length.name());
    try std.testing.expectEqualStrings("BitURShift", Op.bit_u_r_shift.name());
    try std.testing.expectEqualStrings("GetUrl2", Op.get_url2.name());
    try std.testing.expect(!@as(Op, @fromBackingInt(@intCast(0x01))).known());
    try std.testing.expectEqualStrings("0x01", @as(Op, @fromBackingInt(@intCast(0x01))).name());
    try std.testing.expectEqual(100, std.enums.values(Op).len);
    try std.testing.expectEqual(@as(u16, 0x1ff), @as(u16, @bitCast(FunctionFlags{
        .preload_this = true,
        .suppress_this = true,
        .preload_arguments = true,
        .suppress_arguments = true,
        .preload_super = true,
        .suppress_super = true,
        .preload_root = true,
        .preload_parent = true,
        .preload_global = true,
    })));
}
