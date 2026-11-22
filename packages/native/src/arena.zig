//! A 16-byte-aligned bump arena private to each Wasm instance, starting
//! beyond its static data and stack. Reset keeps the pages for the next use.
const std = @import("std");

const page = 65536;
var base: usize = 0;
pub var top: usize = 0;

/// Memory up to `end`, grown if need be.
pub fn reserve(end: u64) bool {
    const have: u64 = @as(u64, @wasmMemorySize(0)) * page;
    if (end <= have) {
        return true;
    }

    if (end > 0xffff_0000) {
        return false;
    }

    return @wasmMemoryGrow(0, @intCast((end - have + page - 1) / page)) >= 0;
}

pub fn reset() void {
    if (base == 0) base = @wasmMemorySize(0) * page;
    top = base;
}

/// `n` bytes, 16-aligned, growing memory as needed; 0 when it cannot.
pub fn alloc(n: usize) usize {
    if (base == 0) {
        reset();
    }

    const start = std.mem.alignForward(u64, top, 16);
    if (!reserve(start +| n)) {
        return 0;
    }

    top = @intCast(start + n);
    return @intCast(start);
}
