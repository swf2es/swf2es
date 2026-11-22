// PCRE frees its heap-backed match frames as it backtracks. Keep their
// allocation sizes for Zig's allocator; a failed allocation aborts this
// instance, including compilation paths which assume allocation succeeds.
const std = @import("std");
const allocator = std.heap.wasm_allocator;
const header = 8;

export fn avmplus_pcre_malloc(size: usize) [*]u8 {
    const bytes = allocator.alignedAlloc(u8, .@"8", std.math.add(usize, size, header) catch @trap()) catch @trap();
    const length: *usize = @ptrCast(bytes.ptr);
    length.* = bytes.len;
    return bytes.ptr + header;
}

export fn avmplus_pcre_free(ptr: ?[*]u8) void {
    const data = ptr orelse return;
    const bytes: [*]align(8) u8 = @alignCast(data - header);
    const length: *const usize = @ptrCast(bytes);
    allocator.free(bytes[0..length.*]);
}

export fn strncmp(a: [*]const u8, b: [*]const u8, n: usize) c_int {
    for (0..n) |i| {
        if (a[i] != b[i] or a[i] == 0) return @as(c_int, a[i]) - b[i];
    }
    return 0;
}
