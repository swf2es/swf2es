// The compiler's exports, as assembly/index.ts gives them, behind a byte
// ABI that packages/codegen/src/zig.ts lifts to the signatures of asc's
// glue (docs/zig-codegen.md, section 3).
//
// Every call starts with input(), which the host calls before each export
// with room for the call's arrays and strings (0 bytes when it has none),
// and no export starts a call itself: one place resets the call's arena
// and the last call's failure, so no export can forget to, and none can
// free what input() staged. The host writes the arrays and strings there
// and passes each as its address and length. What a call hands out (an
// address, outputLength() bytes) stays where it is until the next call's
// input(). outputLength() and codegenError() read the last call and start
// none. Inside, everything returns errors; here they become
// codegenError()'s code, set by the call that failed, which then hands out
// nothing: running out of memory never traps. Compiling is a pure function
// of the calls: no import but env.abort, no clock, no randomness.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const memory = @import("memory.zig");
const options = @import("options");
const output = @import("output.zig");
const avm1 = @import("avm1/compile.zig");
const avm2 = @import("compile.zig");
const units = @import("avm1/emit/units.zig");

pub const panic = if (builtin.cpu.arch.isWasm()) @import("panic.zig") else std.debug.FullPanic(std.debug.defaultPanic);

/// Must equal COMPILER_VERSION in packages/codegen/src/index.ts.
const compiler_version = "0.0.0";

/// codegenError()'s codes.
const out_of_memory = 1;

var handed_length: u32 = 0;
var failure: u32 = 0;

/// The call's allocator, which input() reset.
pub fn gpa() Allocator {
    std.debug.assert(memory.arenasReady());
    return memory.call.allocator();
}

pub fn handOut(bytes: []const u8) usize {
    handed_length = @intCast(bytes.len);
    return @intFromPtr(bytes.ptr);
}

/// Nothing handed out, and why.
pub fn fail(err: Allocator.Error) usize {
    switch (err) {
        error.OutOfMemory => failure = out_of_memory,
    }

    handed_length = 0;
    return 0;
}

/// Start a call: all the last call held given back, and room for `size`
/// bytes of its arrays and strings, 8-aligned; 0 if memory cannot grow.
pub export fn input(size: u32) usize {
    memory.arenas();
    failure = 0;
    handed_length = 0;
    memory.call.reset();
    avm2.callStarts();
    const room = gpa().alignedAlloc(u8, .@"8", @max(size, 8)) catch |err| return fail(err);
    return @intFromPtr(room.ptr);
}

/// How many bytes the last call that handed some out gave.
pub export fn outputLength() u32 {
    return handed_length;
}

/// Why the last call failed: 0 if it did not, 1 out of memory.
pub export fn codegenError() u32 {
    return failure;
}

pub export fn compilerVersion() usize {
    return handOut(compiler_version);
}

/// The version at the start of an ABC block, major << 16 | minor; -1 if it is too short.
pub export fn abcVersion(abc: [*]const u8, length: u32) i32 {
    if (length < 4) {
        return -1;
    }

    const minor: u32 = std.mem.readInt(u16, abc[0..2], .little);
    const major: u32 = std.mem.readInt(u16, abc[2..4], .little);
    // Wrapped, as an i32 shift does: a major of 0x8000 or more is negative.
    return @bitCast((major << 16) | minor);
}

/// Nothing handed out, as AssemblyScript's handOut(null): address 0.
fn handOutNone() usize {
    handed_length = 0;
    return 0;
}

/// A staged array: its address and length, as the wrapper passes it.
fn staged(comptime T: type, at: [*]const T, len: u32) []const T {
    return at[0..len];
}

/// A SWF's bytes and its blocks' ranges, as many as there are both offsets and lengths.
fn swfOf(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32) Allocator.Error!avm1.Swf {
    const count = @min(offsets_len, lengths_len);
    const blocks = try gpa().alloc(units.BlockRange, count);
    for (blocks, staged(i32, offsets, count), staged(i32, lengths, count)) |*block, offset, length| {
        block.* = .{ .offset = offset, .length = length };
    }

    return .{ .bytes = staged(u8, swf, swf_len), .blocks = blocks };
}

/// What writing a module fails with, as codegenError() reports it: the
/// writer fails only as its buffer cannot grow.
pub fn failWriting(err: output.Error) usize {
    return fail(switch (err) {
        error.OutOfMemory, error.WriteFailed => error.OutOfMemory,
    });
}

// The AVM1 compiler (avm1/compile.zig), as assembly/avm1/compile.ts exports it.

pub export fn actionsModuleBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, keep: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    return handOut(avm1.moduleBytes(gpa(), memory.pages().allocator(), s, version, keep) catch |err| return failWriting(err));
}

pub export fn actionsModuleEntries() usize {
    return handOut(avm1.moduleEntries(gpa()) catch |err| return failWriting(err));
}

pub export fn actionsModuleUnits() usize {
    return handOut(avm1.moduleUnits(gpa()) catch |err| return failWriting(err));
}

pub export fn actionsEmitEach(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, blocks: [*]const u8, blocks_len: u32, reuse: bool) usize {
    return actionsEmitEachBytes(swf, swf_len, offsets, offsets_len, lengths, lengths_len, version, blocks, blocks_len, reuse);
}

pub export fn actionsEmitEachBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, blocks: [*]const u8, blocks_len: u32, reuse: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    return handOut(avm1.emitEach(gpa(), s, version, staged(u8, blocks, blocks_len), reuse) catch |err| return failWriting(err));
}

pub export fn actionsHold(handle: i32, swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32) void {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| {
        _ = fail(err);
        return;
    };
    avm1.hold(memory.pages().allocator(), handle, s) catch |err| {
        _ = fail(err);
    };
}

pub export fn actionsRelease(handle: i32) void {
    avm1.release(handle);
}

pub export fn actionsHeldCount() i32 {
    return @intCast(avm1.heldCount());
}

pub export fn actionsHeldEmitEachBytes(handle: i32, version: i32, blocks: [*]const u8, blocks_len: u32) usize {
    const text = avm1.heldEmitEach(gpa(), handle, version, staged(u8, blocks, blocks_len)) catch |err| return failWriting(err);
    return if (avm1.heldAt(handle) == null) handOutNone() else handOut(text);
}

pub export fn actionsHeldUnitBytes(handle: i32, version: i32, at: i32, end: i32, bound: i32, five: bool) usize {
    const key: units.UnitKey = .{ .at = at, .end = end, .bound = bound, .five = five };
    const code = avm1.heldUnitBytes(gpa(), handle, version, key) catch |err| return failWriting(err);
    return if (code) |text| handOut(text) else handOutNone();
}

pub export fn actionsUnitBytes(swf: [*]const u8, swf_len: u32, offsets: [*]const i32, offsets_len: u32, lengths: [*]const i32, lengths_len: u32, version: i32, at: i32, end: i32, bound: i32, five: bool) usize {
    const s = swfOf(swf, swf_len, offsets, offsets_len, lengths, lengths_len) catch |err| return fail(err);
    const key: units.UnitKey = .{ .at = at, .end = end, .bound = bound, .five = five };
    return handOut(avm1.unitBytes(gpa(), s, version, key) catch |err| return failWriting(err));
}

/// Where the high and reach of the unit compiled last are, two f64s.
pub export fn actionsUnitLimits() usize {
    return @intFromPtr(&avm1.unit_limits);
}

// The AVM2 compiler (compile.zig), as assembly/compile.ts exports it. A
// call that fails hands out nothing, and its result is not read.

/// `result`, or what a failed call returns: codegenError() says why.
fn orFailed(comptime T: type, result: Allocator.Error!T) T {
    return result catch |err| {
        _ = fail(err);
        return std.mem.zeroes(T);
    };
}

pub export fn domainReset(apiVersion: i32) void {
    orFailed(void, avm2.domainReset(apiVersion));
}

pub export fn domainAdd(bytes: [*]const u8, len: u32, is_builtin: bool, appDomain: i32) i32 {
    // For the wrapper's tests of recovery: a load that panics, or traps.
    if (options.checks) {
        const abc = staged(u8, bytes, len);
        if (std.mem.eql(u8, abc, "\x00panic")) {
            @panic("a panic for the tests");
        }

        if (std.mem.eql(u8, abc, "\x00overflow")) {
            _ = overflow(0);
        }
    }

    return orFailed(i32, avm2.domainAdd(staged(u8, bytes, len), is_builtin, appDomain));
}

pub export fn domainChild(parent: i32) i32 {
    return orFailed(i32, avm2.domainChild(parent));
}

pub export fn domainDrop(appDomain: i32) void {
    orFailed(void, avm2.domainDrop(appDomain));
}

pub export fn domainEvict(appDomain: i32) void {
    orFailed(void, avm2.domainEvict(appDomain));
}

pub export fn domainState(appDomain: i32) i32 {
    return orFailed(i32, avm2.domainState(appDomain));
}

pub export fn domainRestore(index: i32, bytes: [*]const u8, len: u32) i32 {
    return orFailed(i32, avm2.domainRestore(index, staged(u8, bytes, len)));
}

pub export fn domainRevive(appDomain: i32, stepped: bool) i32 {
    return orFailed(i32, avm2.domainRevive(appDomain, stepped));
}

pub export fn domainFound(appDomain: i32, nsKind: i32, uri: [*]const u8, uri_len: u32, name: [*]const u8, name_len: u32, abc: i32, asType: bool) void {
    orFailed(void, avm2.domainFound(appDomain, nsKind, staged(u8, uri, uri_len), staged(u8, name, name_len), abc, asType));
}

pub export fn domainLinked(index: i32) usize {
    return handOut(avm2.domainLinked(gpa(), index) catch |err| return fail(err));
}

pub export fn domainWantsCompact(want: i32) bool {
    return orFailed(bool, avm2.domainWantsCompact(want));
}

pub export fn domainModule(hashes: [*]const u8, hashes_len: u32, index: i32, keep: bool, linkedOnly: bool) usize {
    return handOut(avm2.domainModule(gpa(), staged(u8, hashes, hashes_len), index, keep, linkedOnly) catch |err| return fail(err));
}

pub export fn domainModuleBytes(hashes: [*]const u8, hashes_len: u32, index: i32, keep: bool, linkedOnly: bool) usize {
    const bytes = avm2.domainModuleBytes(gpa(), staged(u8, hashes, hashes_len), index, keep, linkedOnly) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn domainModuleMoreBytes() usize {
    const bytes = avm2.domainModuleMoreBytes(gpa()) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn domainModuleDone() bool {
    return avm2.domainModuleDone();
}

pub export fn domainModuleEntries() usize {
    return handOut(avm2.domainModuleEntries(gpa()) catch |err| return fail(err));
}

pub export fn domainSourceMap() usize {
    return handOut(avm2.domainSourceMap(gpa()) catch |err| return fail(err));
}

pub export fn domainContext(index: i32, after: i32, upTo: i32) usize {
    return handOut(avm2.domainContext(gpa(), index, after, upTo) catch |err| return fail(err));
}

pub export fn domainKeyHeaderBytes(index: i32) usize {
    const bytes = avm2.domainKeyHeaderBytes(gpa(), index) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn domainKeyFork(appDomain: i32) i32 {
    return orFailed(i32, avm2.domainKeyFork(appDomain));
}

pub export fn domainKeyLogBytes(appDomain: i32, after: i32, from: i32, to: i32, block: i32, filled: i32) usize {
    const bytes = avm2.domainKeyLogBytes(gpa(), appDomain, after, from, to, block, filled) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn domainRevision() usize {
    return handOut(avm2.domainRevision(gpa()) catch |err| return fail(err));
}

pub export fn domainLogMark() i32 {
    return orFailed(i32, avm2.domainLogMark());
}

pub export fn domainLogSince(mark: i32, index: i32) usize {
    return handOut(avm2.domainLogSince(gpa(), mark, index) catch |err| return fail(err));
}

pub export fn lastAddLinked() bool {
    return avm2.last_add_linked;
}

pub export fn journalBytes(mark: u32) usize {
    const bytes = avm2.journalBytes(gpa(), mark) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn replayEntry(kind: u32, index: u32, a: u32, b: u32) bool {
    return orFailed(bool, avm2.replayEntry(kind, index, a, b));
}

pub export fn abandonRebuild() void {
    avm2.leaveRebuild();
}

pub export fn domainReplay(log: [*]const u8, log_len: u32, index: i32) bool {
    return orFailed(bool, avm2.domainReplay(gpa(), staged(u8, log, log_len), index));
}

pub export fn domainCompact(stepped: bool) bool {
    return orFailed(bool, avm2.domainCompact(stepped));
}

pub export fn domainRebuild(stepped: bool) bool {
    return orFailed(bool, avm2.domainRebuild(stepped));
}

pub export fn domainRebuildStep() i32 {
    return avm2.domainRebuildStep() catch |err| {
        _ = fail(err);
        return -1;
    };
}

pub export fn domainSaveBytes() usize {
    return handOut(avm2.domainSaveBytes(gpa()) catch |err| return fail(err));
}

pub export fn domainSavedAbcBytes(index: i32) usize {
    const bytes = avm2.domainSavedAbcBytes(index) catch |err| return fail(err);
    return if (bytes) |b| handOut(b) else handOutNone();
}

pub export fn domainLoad(words: [*]const u8, len: u32) bool {
    return orFailed(bool, avm2.domainLoad(staged(u8, words, len), false));
}

pub export fn loadCheckpointState(words: [*]const u8, len: u32) bool {
    return orFailed(bool, avm2.domainLoad(staged(u8, words, len), true));
}

pub export fn domainLoadAbc(index: i32, bytes: [*]const u8, len: u32) i32 {
    return orFailed(i32, avm2.domainLoadAbc(index, staged(u8, bytes, len)));
}

pub export fn domainLoadRebuild() bool {
    return orFailed(bool, avm2.domainLoadRebuild());
}

pub export fn domainUsage() usize {
    return handOut(avm2.domainUsage(gpa()) catch |err| return fail(err));
}

pub export fn domainParent(appDomain: i32) i32 {
    return orFailed(i32, avm2.domainParent(appDomain));
}

/// Bytes staged as the wrapper stages them, for the tests.
fn stage(bytes: []const u8) [*]const u8 {
    const at: [*]u8 = @ptrFromInt(input(@intCast(bytes.len)));
    @memcpy(at[0..bytes.len], bytes);
    return at;
}

test "a call hands out what stays until the next one starts" {
    _ = input(0);
    const at: [*]const u8 = @ptrFromInt(compilerVersion());
    try std.testing.expectEqualStrings(compiler_version, at[0..outputLength()]);
    try std.testing.expectEqual(0, codegenError());
}

test "abcVersion reads the minor and major versions, little-endian, as assembly/index.ts does" {
    try std.testing.expectEqual((46 << 16) | 16, abcVersion(stage(&.{ 16, 0, 46, 0, 99 }), 5));
    try std.testing.expectEqual(@as(i32, @bitCast(@as(u32, 0xffff_fffe))), abcVersion(stage(&.{ 0xfe, 0xff, 0xff, 0xff }), 4));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{ 16, 0, 46 }), 3));
    try std.testing.expectEqual(-1, abcVersion(stage(&.{}), 0));
}

test "input starts a call: the last one's arena and failure are given back" {
    try std.testing.expectEqual(0, input(0xffff_ffff));
    try std.testing.expectEqual(1, codegenError());
    _ = input(3 * memory.chunk_size);
    try std.testing.expectEqual(0, codegenError());
    const used = memory.pages().used;
    _ = input(10);
    try std.testing.expect(memory.pages().used < used);
}

test {
    _ = memory;
    _ = output;
    _ = @import("dtoa.zig");
    _ = @import("parse.zig");
    _ = @import("avm1/actions/opcodes.zig");
    _ = @import("avm1/actions/offsets.zig");
    _ = @import("avm1/actions/decode.zig");
    _ = @import("avm1/flow/regions.zig");
    _ = @import("avm1/flow/pool.zig");
    _ = @import("avm1/emit/strings.zig");
    _ = @import("avm1/emit/units.zig");
    _ = @import("avm1/emit/block.zig");
    _ = @import("avm1/emit/actions.zig");
    _ = @import("avm1/emit/control.zig");
    _ = @import("avm1/emit/stack.zig");
    _ = @import("avm1/emit/module.zig");
    _ = avm1;
    _ = @import("avm2/abc/reader.zig");
    _ = @import("avm2/abc/constants.zig");
    _ = @import("avm2/abc/opcodes.zig");
    _ = @import("avm2/abc/pool.zig");
    _ = @import("avm2/abc/abc.zig");
    _ = @import("avm2/abc/methods.zig");
    _ = @import("avm2/abc/traits.zig");
    _ = @import("avm2/abc/classes.zig");
    _ = @import("avm2/abc/bodies.zig");
    _ = @import("avm2/abc/parse.zig");
    // Every declaration of the linker's, and of its tables, analysed:
    // much of it is called only from stage 4's verifier on.
    inline for (.{
        @import("avm2/link/table.zig"),
        @import("avm2/link/namespaces.zig"),
        @import("avm2/link/domain.zig"),
        @import("avm2/link/classes.zig"),
        @import("avm2/link/typenames.zig"),
        @import("avm2/link/traits.zig"),
        @import("avm2/link/bindings.zig"),
        @import("avm2/link/types.zig"),
        @import("avm2/link/signatures.zig"),
        @import("avm2/link/lifetime.zig"),
        @import("avm2/ir/ir.zig"),
        @import("avm2/abc/code.zig"),
        @import("avm2/abc/targets.zig"),
        @import("avm2/abc/verify.zig"),
        @import("avm2/abc/typing.zig"),
        @import("avm2/abc/properties.zig"),
        @import("avm2/emit/sourcemap.zig"),
        @import("avm2/emit/stack-names.zig"),
        @import("avm2/emit/method.zig"),
        @import("avm2/emit/refs.zig"),
        @import("avm2/emit/values.zig"),
        @import("avm2/emit/copies.zig"),
        @import("avm2/emit/floats.zig"),
        @import("avm2/emit/handlers.zig"),
        @import("avm2/emit/structure.zig"),
        @import("avm2/emit/blocks.zig"),
        @import("avm2/emit/instructions.zig"),
        @import("avm2/emit/objects.zig"),
        @import("avm2/emit/memory.zig"),
        @import("avm2/emit/module.zig"),
    }) |file| {
        std.testing.refAllDecls(file);
        inline for (comptime std.meta.declarations(file)) |name| {
            const field = @field(file, name);
            if (@TypeOf(field) == type and @typeInfo(field) == .@"struct") {
                std.testing.refAllDecls(field);
            }
        }
    }
    _ = avm2;
}

/// Recursion until the stack overflows, a trap that is not a panic, for the wrapper's tests.
fn overflow(depth: u32) u32 {
    var frame: [4096]u8 = undefined;
    frame[depth % frame.len] = @truncate(depth);
    std.mem.doNotOptimizeAway(&frame);
    return @call(.never_inline, overflow, .{depth + 1}) +% frame[(depth * 7) % frame.len];
}
