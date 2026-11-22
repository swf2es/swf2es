// Domain memory, as avmplus' MOPS (assembly/avm2/emit/memory.ts): where li8
// and the other opcodes can read and write the runtime's view in place, at
// an int or uint address, and the DataView method each one uses. The view's
// own range check rejects an address avmplus rejects, with a RangeError of
// its own that the method's code turns into avmplus' (inPlaceMemory).
const ops = @import("../abc/opcodes.zig");
const traits_ = @import("../link/traits.zig");
const MethodEmitter = @import("method.zig").MethodEmitter;

/// Whether register r is a domain memory address the emitter can use as it is: an int or uint.
pub fn isAddress(em: *const MethodEmitter, r: i32) bool {
    const bt = em.builtinOf(r);
    return bt == traits_.BUILTIN_Int or bt == traits_.BUILTIN_Uint;
}

/// The DataView method that loads or stores as op does, little-endian.
pub fn viewMethod(op: u16) []const u8 {
    return switch (op) {
        ops.OP_li8 => "getUint8",
        ops.OP_li16 => "getUint16",
        ops.OP_li32 => "getInt32",
        ops.OP_lf32 => "getFloat32",
        ops.OP_lf64 => "getFloat64",
        ops.OP_si8 => "setUint8",
        ops.OP_si16 => "setUint16",
        ops.OP_si32 => "setInt32",
        ops.OP_sf32 => "setFloat32",
        else => "setFloat64",
    };
}
