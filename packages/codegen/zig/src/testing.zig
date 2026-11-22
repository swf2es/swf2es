// The test build's root: every export of the compiler's (root.zig), and
// what the tests and the parity harness read besides, as
// assembly/testing.ts adds to assembly/index.ts. Each stage of the port
// adds the dumps of what it ports here.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("options");
const memory = @import("memory.zig");
const root = @import("root.zig");
const avm1 = @import("testing/avm1.zig");
const avm1_compile = @import("avm1/compile.zig");
const abc = @import("testing/abc.zig");
const avm2 = @import("compile.zig");
const domain = @import("testing/domain.zig");
const link = @import("avm2/link/domain.zig");

pub const panic = root.panic;

comptime {
    _ = root;
}

const wasm = builtin.cpu.arch.isWasm();

/// How many of the page allocator's chunks are in use.
export fn memoryChunksUsed() u32 {
    return memory.pages().used;
}

/// How many runs the call's arena took from the top, and so on.
export fn memoryTopRuns() u32 {
    return memory.top_runs;
}

/// The reserve of free chunks a run from the top leaves below it, set for measuring.
export fn memoryReserve(chunks: u32) void {
    memory.reserve = chunks;
}

/// How far memory reaches past the static data, in bytes: only grows.
export fn memoryReached() u32 {
    return memory.pages().reached();
}

/// A panic, as a failed safety check would be, for the wrapper's tests.
export fn testingPanic() void {
    @panic("a panic for the tests");
}

/// Recursion until the stack overflows, a trap that is not a panic, for the wrapper's tests.
export fn testingOverflow(depth: u32) u32 {
    var frame: [4096]u8 = undefined;
    frame[depth % frame.len] = @truncate(depth);
    std.mem.doNotOptimizeAway(&frame);
    return @call(.never_inline, testingOverflow, .{depth + 1}) +% frame[(depth * 7) % frame.len];
}

/// The byte the unused stack is painted with.
const paint: u8 = 0x5A;
/// The stack's lowest address the painting starts at: the stack is first
/// in memory and grows down towards 0, where no pointer may point.
const stack_floor = 16;

/// The stack below the caller painted, for stackDeepest to find how deep
/// the calls after reach: what the fuzzers and the corpus size it by.
export fn stackPaint() void {
    if (!wasm) {
        return;
    }

    var marker: u8 = 0;
    std.mem.doNotOptimizeAway(&marker);
    const below = @intFromPtr(&marker) - 1024;
    const stack: [*]volatile u8 = @ptrFromInt(stack_floor);
    for (0..below - stack_floor) |i| {
        stack[i] = paint;
    }
}

/// How many bytes deep the stack has reached since stackPaint, of its options.stack_size.
export fn stackDeepest() u32 {
    if (!wasm) {
        return 0;
    }

    const stack: [*]volatile u8 = @ptrFromInt(stack_floor);
    var at: u32 = 0;
    while (at < options.stack_size - stack_floor and stack[at] == paint) {
        at += 1;
    }

    return options.stack_size - stack_floor - at;
}

/// The AVM1 actions Flash knows, one a line (assembly/testing/avm1.ts).
export fn avm1Opcodes() usize {
    return root.handOut(avm1.opcodes(root.gpa()) catch |err| return root.failWriting(err));
}

/// An AVM1 block's regions as the flow finds them.
export fn avm1Dump(bytes: [*]const u8, len: u32) usize {
    return root.handOut(avm1.dump(root.gpa(), bytes[0..len]) catch |err| return root.failWriting(err));
}

/// avm1Dump briefly, for the fuzzer.
export fn avm1Check(bytes: [*]const u8, len: u32) usize {
    return root.handOut(avm1.check(root.gpa(), bytes[0..len]) catch |err| return root.failWriting(err));
}

/// The action at `offset` of an AVM1 block alone.
export fn avm1Action(bytes: [*]const u8, len: u32, offset: i32) usize {
    return root.handOut(avm1.action(root.gpa(), bytes[0..len], offset) catch |err| return root.failWriting(err));
}

// The ABC reader's and parser's dumps (assembly/testing/abc.ts).

/// The values `kinds` read in order from `bytes`, then the position and whether the reader failed, as f64s.
export fn readAll(bytes: [*]const u8, len: u32, kinds: [*]const u8, kinds_len: u32) usize {
    const values = abc.readAll(root.gpa(), bytes[0..len], kinds[0..kinds_len]) catch |err| return root.fail(err);
    return root.handOut(std.mem.sliceAsBytes(values));
}

/// The constant pool of an ABC block, one entry a line.
export fn poolDump(bytes: [*]const u8, len: u32) usize {
    return root.handOut(abc.poolDump(root.gpa(), bytes[0..len]) catch |err| return root.failWriting(err));
}

/// An ABC block's tables after the constant pool, one entry a line.
export fn abcDump(bytes: [*]const u8, len: u32, is_builtin: bool) usize {
    return root.handOut(abc.abcDump(root.gpa(), bytes[0..len], is_builtin) catch |err| return root.failWriting(err));
}

/// AVM2's opcode table.
export fn opcodeTable() usize {
    return root.handOut(abc.opcodeTable(root.gpa()) catch |err| return root.failWriting(err));
}

// The domain's dumps (assembly/testing/domain.ts).

export fn domainFind(type_: i32, uri: [*]const u8, uri_len: u32, name: [*]const u8, name_len: u32, version: i32, appDomain: i32) usize {
    return root.handOut(domain.domainFind(root.gpa(), @truncate(@as(u32, @bitCast(type_))), uri[0..uri_len], name[0..name_len], version, appDomain) catch |err| return root.fail(err));
}

export fn domainSummary() usize {
    return root.handOut(domain.domainSummary(root.gpa()) catch |err| return root.fail(err));
}

export fn domainTraits(first: i32) usize {
    return root.handOut(domain.domainTraits(root.gpa(), first) catch |err| return root.fail(err));
}

export fn domainResolve(first: i32) i32 {
    return avm2.changed(domain.domainResolve, .{first}) catch |err| {
        _ = root.fail(err);
        return 0;
    };
}

export fn domainBuiltins() usize {
    return root.handOut(domain.domainBuiltins(root.gpa()) catch |err| return root.fail(err));
}

export fn domainSlotTypes(index: i32, cls: i32) usize {
    return root.handOut(avm2.changed(domain.domainSlotTypes, .{ root.gpa(), index, cls }) catch |err| return root.fail(err));
}

export fn domainTraitsCount() i32 {
    return domain.domainTraitsCount() catch |err| {
        _ = root.fail(err);
        return 0;
    };
}

export fn codeDump(bytes: [*]const u8, len: u32, is_builtin: bool) usize {
    return root.handOut(abc.codeDump(root.gpa(), bytes[0..len], is_builtin) catch |err| return root.failWriting(err));
}

export fn domainVerifyAll() usize {
    return root.handOut(avm2.changed(domain.domainVerifyAll, .{root.gpa()}) catch |err| return root.fail(err));
}

export fn domainIr(body: u32) usize {
    return root.handOut(avm2.changed(domain.domainIr, .{ root.gpa(), body }) catch |err| return root.fail(err));
}

export fn domainEmit(body: u32) usize {
    return root.handOut(avm2.changed(domain.domainEmit, .{ root.gpa(), body }) catch |err| return root.fail(err));
}

export fn domainEmitEach(bodies: [*]const u8, bodies_len: u32, reuse: bool, which: i32) usize {
    return root.handOut(avm2.domainEmitEach(root.gpa(), bodies[0..bodies_len], reuse, which) catch |err| return root.fail(err));
}

export fn domainEmitEachBytes(bodies: [*]const u8, bodies_len: u32, reuse: bool, which: i32) usize {
    return root.handOut(avm2.domainEmitEach(root.gpa(), bodies[0..bodies_len], reuse, which) catch |err| return root.fail(err));
}

export fn domainPartBudget(bytes: i32) void {
    avm2.domainPartBudget(bytes);
}

export fn domainIrAll() usize {
    return root.handOut(avm2.changed(domain.domainIrAll, .{root.gpa()}) catch |err| return root.fail(err));
}

export fn domainCheckIr() usize {
    return root.handOut(avm2.changed(domain.domainCheckIr, .{root.gpa()}) catch |err| return root.fail(err));
}

/// How many reads past the end of a namespace set the calls since the last
/// asked made (see domain.zig's `unspecified`), for the parity harness to
/// take their cases as unspecified.
export fn unspecifiedReads() u32 {
    defer link.unspecified = 0;
    return link.unspecified;
}

/// What the exports keep and hold let go, and the call's and the global
/// arena given back, as when the module starts.
fn letGo() void {
    avm1_compile.forget();
    avm1_compile.releaseAll();
    avm2.release();
    memory.call.reset();
    memory.global.reset();
}

/// `bytes` staged at `at` in the room input() gave, 8-aligned as the wrapper stages them.
fn put(room: usize, at: *usize, bytes: []const u8) usize {
    at.* = std.mem.alignForward(usize, at.*, 8);
    const to: [*]u8 = @ptrFromInt(room + at.*);
    @memcpy(to[0..bytes.len], bytes);
    defer at.* += bytes.len;
    return room + at.*;
}

/// The AVM1 exports and the dumps, called through the byte ABI as the
/// wrapper calls them, over the module's pages replaced by `p`'s: from
/// staging to handing out, every allocation they make may fail.
fn throughExports(_: std.mem.Allocator, p: *memory.Pages) !void {
    memory.arenas();
    letGo();
    const saved = memory.swapPages(p.*);
    defer {
        letGo();
        p.* = memory.swapPages(saved);
    }

    const block = &@import("avm1/emit/block.zig").test_block;
    const len: u32 = block.len;
    const ranges = [_]i32{ 0, @intCast(len) };
    const list = "0,0,1";
    const Swf = struct { swf: usize, offsets: usize, lengths: usize, list: usize };
    const stage = struct {
        fn call(size: usize) error{OutOfMemory}!Swf {
            const room = root.input(@intCast(size));
            if (room == 0) {
                return error.OutOfMemory;
            }

            var at: usize = 0;
            return .{
                .swf = put(room, &at, block),
                .offsets = put(room, &at, std.mem.asBytes(&ranges[0])),
                .lengths = put(room, &at, std.mem.asBytes(&ranges[1])),
                .list = put(room, &at, list),
            };
        }
    };
    const size = len + 64;
    const failed = struct {
        fn check() error{OutOfMemory}!void {
            if (root.codegenError() != 0) {
                return error.OutOfMemory;
            }
        }
    };

    var s = try stage.call(size);
    _ = root.actionsModuleBytes(@ptrFromInt(s.swf), len, @ptrFromInt(s.offsets), 1, @ptrFromInt(s.lengths), 1, 6, true);
    try failed.check();
    _ = root.input(0);
    _ = root.actionsModuleEntries();
    try failed.check();
    _ = root.input(0);
    _ = root.actionsModuleUnits();
    try failed.check();
    s = try stage.call(size);
    _ = root.actionsEmitEachBytes(@ptrFromInt(s.swf), len, @ptrFromInt(s.offsets), 1, @ptrFromInt(s.lengths), 1, 6, @ptrFromInt(s.list), list.len, false);
    try failed.check();
    for (1..4) |handle| {
        s = try stage.call(size);
        root.actionsHold(@intCast(handle), @ptrFromInt(s.swf), len, @ptrFromInt(s.offsets), 1, @ptrFromInt(s.lengths), 1);
        try failed.check();
    }

    s = try stage.call(size);
    _ = root.actionsHeldEmitEachBytes(2, 6, @ptrFromInt(s.list), list.len);
    try failed.check();
    _ = root.input(0);
    _ = root.actionsHeldUnitBytes(3, 6, 0, @intCast(len), @intCast(len), false);
    try failed.check();
    s = try stage.call(size);
    _ = root.actionsUnitBytes(@ptrFromInt(s.swf), len, @ptrFromInt(s.offsets), 1, @ptrFromInt(s.lengths), 1, 6, 0, @intCast(len), @intCast(len), false);
    try failed.check();
    s = try stage.call(size);
    _ = avm1Dump(@ptrFromInt(s.swf), len);
    try failed.check();
    s = try stage.call(size);
    _ = avm1Check(@ptrFromInt(s.swf), len);
    try failed.check();
    s = try stage.call(size);
    _ = avm1Action(@ptrFromInt(s.swf), len, 0);
    try failed.check();
    _ = root.input(0);
    _ = avm1Opcodes();
    try failed.check();
    const rich = &abc.rich_abc;
    for ([_]bool{ false, true }) |is_builtin| {
        var room = root.input(rich.len);
        if (room == 0) {
            return error.OutOfMemory;
        }

        var at: usize = 0;
        _ = put(room, &at, rich);
        _ = poolDump(@ptrFromInt(room), rich.len);
        try failed.check();
        room = root.input(rich.len);
        if (room == 0) {
            return error.OutOfMemory;
        }

        at = 0;
        _ = put(room, &at, rich);
        _ = abcDump(@ptrFromInt(room), rich.len, is_builtin);
        try failed.check();
    }

    s = try stage.call(size);
    _ = readAll(@ptrFromInt(s.swf), len, @ptrFromInt(s.swf), len);
    try failed.check();
    _ = root.input(0);
    _ = opcodeTable();
    try failed.check();

    // The domain's exports, the link ABCs staged as the wrapper stages them.
    const staging = struct {
        fn call(bytes: []const u8) error{OutOfMemory}![*]const u8 {
            const room = root.input(@intCast(bytes.len));
            if (room == 0) {
                return error.OutOfMemory;
            }

            var at: usize = 0;
            return @ptrFromInt(put(room, &at, bytes));
        }
    };
    _ = root.input(0);
    root.domainReset(50);
    try failed.check();
    for ([_]struct { []const u8, bool, i32 }{
        .{ &domain.link_builtin, true, 0 },
        .{ &domain.link_user, false, 1 },
        .{ &domain.link_failing, false, 0 },
    }, 0..) |added, k| {
        if (k == 1) {
            _ = root.input(0);
            _ = root.domainChild(0);
            try failed.check();
        }

        _ = root.domainAdd(try staging.call(added[0]), @intCast(added[0].len), added[1], added[2]);
        try failed.check();
    }

    const names = try staging.call("A");
    root.domainFound(1, 0, names, 0, names, 1, 0, true);
    try failed.check();
    _ = domainFind(0, names, 0, names, 1, 52, 1);
    try failed.check();
    for ([_]*const fn () callconv(.c) usize{ domainSummary, domainBuiltins, root.domainUsage }) |dump| {
        _ = root.input(0);
        _ = dump();
        try failed.check();
    }

    _ = root.input(0);
    _ = domainTraits(0);
    try failed.check();
    _ = root.input(0);
    _ = domainSlotTypes(1, 0);
    try failed.check();
    _ = root.input(0);
    _ = domainResolve(0);
    try failed.check();
    _ = root.input(0);
    _ = root.domainLinked(-1);
    try failed.check();
    _ = root.input(0);
    _ = root.domainWantsCompact(0);
    try failed.check();
    _ = root.input(0);
    root.domainEvict(1);
    _ = root.domainRevive(1, false);
    _ = root.domainState(1);
    _ = root.domainParent(1);
    root.domainDrop(1);
    try failed.check();
    _ = root.domainRestore(0, try staging.call(&domain.link_user), domain.link_user.len);
    try failed.check();

    // The modules' exports, whole and a part a method, and the bodies alone.
    _ = root.domainModule(try staging.call("own\nfirst"), 9, -1, true, false);
    try failed.check();
    for ([_]*const fn () callconv(.c) usize{ root.domainSourceMap, root.domainModuleEntries }) |dump| {
        _ = root.input(0);
        _ = dump();
        try failed.check();
    }

    domainPartBudget(1);
    defer domainPartBudget(0);
    _ = root.domainModuleBytes(try staging.call(""), 0, -1, true, true);
    try failed.check();
    while (!root.domainModuleDone()) {
        _ = root.input(0);
        _ = root.domainModuleMoreBytes();
        try failed.check();
    }

    _ = root.input(0);
    _ = domainEmit(0);
    try failed.check();
    _ = domainEmitEach(try staging.call("0,1"), 3, false, -1);
    try failed.check();
}

test "the exports, staging to handing out, may run out of memory anywhere and keep nothing" {
    try memory.atEveryMemorySize(throughExports);
}

test {
    _ = root;
    _ = avm1;
    _ = abc;
    _ = domain;
}
