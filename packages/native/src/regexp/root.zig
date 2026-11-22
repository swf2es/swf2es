const arena = @import("arena");

// PCRE pops heap frames while backtracking. Mark out-of-order frees so that
// popping the last live block also reclaims the freed blocks directly below it.
const Block = extern struct { previous: ?*Block, freed: bool };
var last: ?*Block = null;

export fn resetHeap() void {
    arena.reset();
    last = null;
}

export fn avmplus_pcre_malloc(size: usize) [*]u8 {
    const at = arena.alloc(size +| @sizeOf(Block));
    if (at == 0) @trap(); // Some PCRE paths assume allocation succeeds.
    const block: *Block = @ptrFromInt(at);
    block.* = .{ .previous = last, .freed = false };
    last = block;
    return @ptrFromInt(at + @sizeOf(Block));
}

export fn avmplus_pcre_free(ptr: ?[*]u8) void {
    const data = ptr orelse return;
    const block: *Block = @ptrFromInt(@intFromPtr(data) - @sizeOf(Block));
    block.freed = true;
    while (last) |tail| {
        if (!tail.freed) break;
        arena.top = @intFromPtr(tail);
        last = tail.previous;
    }
}

export fn strncmp(a: [*]const u8, b: [*]const u8, n: usize) c_int {
    for (0..n) |i| {
        if (a[i] != b[i] or a[i] == 0) return @as(c_int, a[i]) - b[i];
    }
    return 0;
}
