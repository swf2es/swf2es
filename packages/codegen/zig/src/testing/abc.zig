// The test build's look at ABCs, for the node tests: the reader, the
// constant pool, an ABC's tables as the parser reads them, and AVM2's
// opcode table. Strings are written as output.writeDecoded writes them, so
// the wrapper reads each as the JavaScript string it decodes to.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;
const memory = @import("../memory.zig");
const output = @import("../output.zig");
const Output = output.Output;
const Abc = @import("../avm2/abc/abc.zig").Abc;
const ops = @import("../avm2/abc/opcodes.zig");
const readAbc = @import("../avm2/abc/parse.zig").readAbc;
const readConstantPool = @import("../avm2/abc/pool.zig").readConstantPool;
const ConstantPool = @import("../avm2/abc/pool.zig").ConstantPool;
const Diagnostics = @import("../avm2/abc/errors.zig").Diagnostics;
const reader = @import("../avm2/abc/reader.zig");
const Reader = reader.Reader;
const Rows = memory.Rows;
const BodyDecoder = @import("../avm2/abc/code.zig").BodyDecoder;

pub const Error = output.Error;

pub const U8: u8 = 0;
pub const U16: u8 = 1;
pub const S24: u8 = 2;
pub const U30: u8 = 3;
pub const U32: u8 = 4;
pub const S32: u8 = 5;
pub const D64: u8 = 6;
pub const UTF8: u8 = 7;

/// `bytes` followed by the PADDING zero bytes the reader may read past them.
pub fn padded(gpa: Allocator, bytes: []const u8) Allocator.Error![]u8 {
    const data = try memory.allocZeroed(gpa, u8, @intCast(bytes.len + reader.PADDING));
    @memcpy(data[0..bytes.len], bytes);
    return data;
}

/// Read `kinds` in order from `bytes`: the values, then the final position
/// and 1 if the reader failed. UTF8 yields the string's byte length and
/// skips its bytes.
pub fn readAll(gpa: Allocator, bytes: []const u8, kinds: []const u8) Allocator.Error![]f64 {
    const data = try padded(gpa, bytes);
    var r: Reader = .init(data, 0, bytes.len);
    const values = try memory.allocZeroed(gpa, f64, @intCast(kinds.len + 2));
    for (kinds, 0..) |kind, i| {
        values[i] = switch (kind) {
            U8 => @floatFromInt(r.u8_()),
            U16 => @floatFromInt(r.u16_()),
            S24 => @floatFromInt(r.s24()),
            U30 => @floatFromInt(r.u30_()),
            U32 => @floatFromInt(r.u32_()),
            S32 => @floatFromInt(r.s32()),
            D64 => r.d64(),
            UTF8 => blk: {
                const length = r.utf8Length();
                r.skip(length);
                break :blk @floatFromInt(length);
            },
            else => 0,
        };
    }

    values[kinds.len] = @floatFromInt(r.pos);
    values[kinds.len + 1] = if (r.failed) 1 else 0;
    return values;
}

/// "0x16": a byte as the node tests expect it.
fn writeHex(w: *Writer, b: u8) Writer.Error!void {
    try w.print("0x{x:0>2}", .{b});
}

/// The constant pool of a whole ABC block, one entry a line: "int 1 -5",
/// "string 2 foo", "ns 1 0x16 2", "nsset 1 1,2", "mn 3 0x07 1 2", then
/// "error N" if avmplus would reject it.
pub fn poolDump(gpa: Allocator, bytes: []const u8) Error![]const u8 {
    const data = try padded(gpa, bytes);
    var r: Reader = .init(data, 0, bytes.len);
    const minor = r.u16_();
    const major = r.u16_();
    var pool: ConstantPool = try .init(gpa);
    var diag: Diagnostics = .{};
    readConstantPool(gpa, gpa, &r, major == 47 and minor >= 16, &pool, &diag) catch |err| switch (err) {
        error.Verify => {},
        error.OutOfMemory => return error.OutOfMemory,
    };

    var out: Output = try .init(gpa);
    const w = out.writer();
    for (1..pool.ints.len) |i| {
        try w.print("int {d} {d}\n", .{ i, pool.ints[i] });
    }
    for (1..pool.uints.len) |i| {
        try w.print("uint {d} {d}\n", .{ i, pool.uints[i] });
    }
    for (1..pool.doubles.len) |i| {
        try w.print("double {d} ", .{i});
        try output.writeF64(w, pool.doubles[i]);
        try w.writeByte('\n');
    }
    for (1..pool.floats.len) |i| {
        try w.print("float {d} ", .{i});
        try output.writeF64(w, pool.floats[i]);
        try w.writeByte('\n');
    }
    for (1..pool.strings.len) |i| {
        try w.print("string {d} ", .{i});
        try output.writeDecoded(w, pool.string(data, @intCast(i)));
        try w.writeByte('\n');
    }
    for (1..pool.nsKind.len) |i| {
        try w.print("ns {d} ", .{i});
        try writeHex(w, pool.nsKind[i]);
        try w.print(" {d}\n", .{pool.nsName[i]});
    }
    for (1..pool.nsSetCount()) |i| {
        try w.print("nsset {d} ", .{i});
        // A set past the members read, as when a later set failed, ends at
        // the table's end: nothing is written past it.
        const end = @min(pool.nsSetStart[i + 1], pool.nsSetMembers.len);
        var j = pool.nsSetStart[i];
        while (j < end) : (j += 1) {
            if (j > pool.nsSetStart[i]) {
                try w.writeByte(',');
            }

            try w.print("{d}", .{pool.nsSetMembers[j]});
        }
        try w.writeByte('\n');
    }
    for (1..pool.mnKind.len) |i| {
        try w.print("mn {d} ", .{i});
        try writeHex(w, pool.mnKind[i]);
        try w.print(" {d} {d}\n", .{ pool.mnA[i], pool.mnB[i] });
    }
    if (diag.code != 0) {
        try w.print("error {d}\n", .{diag.code});
    }

    return out.written();
}

/// The tables of a whole ABC block after the constant pool, one entry a
/// line; just "error N" if avmplus would reject it. `builtin` parses it as
/// an ABC the player ships.
pub fn abcDump(gpa: Allocator, bytes: []const u8, builtin: bool) Error![]const u8 {
    const data = try padded(gpa, bytes);
    const abc = try readAbc(gpa, gpa, data, @intCast(bytes.len), builtin);
    var out: Output = try .init(gpa);
    const w = out.writer();
    if (abc.@"error" != 0) {
        try w.print("error {d}", .{abc.@"error"});
        return out.written();
    }

    var lines: Lines = .{ .w = w };
    for (0..abc.methodCount()) |i| {
        try lines.next();
        try w.print("method {d} ret={d} params=", .{ i, abc.methodReturnType[i] });
        try join(w, abc.paramTypes, abc.methodParamStart[i], abc.methodParamStart[i + 1]);
        try w.print(" name={d} flags=", .{abc.methodName[i]});
        try writeHex(w, abc.methodFlags[i]);
        const start = abc.methodOptionalStart[i];
        const end = abc.methodOptionalStart[i + 1];
        if (end > start) {
            try w.writeAll(" optional=");
            var j = start;
            while (j < end) : (j += 1) {
                if (j > start) {
                    try w.writeByte(',');
                }

                try w.print("{d}:", .{abc.optionalValue[j]});
                try writeHex(w, abc.optionalKind[j]);
            }
        }
    }

    for (0..abc.metadataCount()) |i| {
        try lines.next();
        try w.print("metadata {d} name={d} items=", .{ i, abc.metadataName[i] });
        var j = abc.metadataItemStart[i];
        while (j < abc.metadataItemStart[i + 1]) : (j += 1) {
            if (j > abc.metadataItemStart[i]) {
                try w.writeByte(',');
            }

            try w.print("{d}:{d}", .{ abc.metadataKey[j], abc.metadataValue[j] });
        }
    }

    for (0..abc.classCount()) |i| {
        try lines.next();
        try w.print("instance {d} name={d} super={d} flags=", .{ i, abc.instanceName[i], abc.instanceSuper[i] });
        try writeHex(w, abc.instanceFlags[i]);
        try w.print(" protectedNs={d} interfaces=", .{abc.instanceProtectedNs[i]});
        try join(w, abc.interfaces, abc.instanceInterfaceStart[i], abc.instanceInterfaceStart[i + 1]);
        try w.print(" init={d}", .{abc.instanceInit[i]});
        try dumpTraits(&lines, abc, "instance", @intCast(i), abc.instanceTraitStart[i], abc.instanceTraitStart[i + 1]);
    }

    for (0..abc.classInit.len) |i| {
        try lines.next();
        try w.print("class {d} init={d}", .{ i, abc.classInit[i] });
        try dumpTraits(&lines, abc, "class", @intCast(i), abc.classTraitStart[i], abc.classTraitStart[i + 1]);
    }

    for (0..abc.scriptCount()) |i| {
        try lines.next();
        try w.print("script {d} init={d}", .{ i, abc.scriptInit[i] });
        try dumpTraits(&lines, abc, "script", @intCast(i), abc.scriptTraitStart[i], abc.scriptTraitStart[i + 1]);
    }

    for (0..abc.bodyCount()) |index| {
        const b: u32 = @intCast(index);
        const method = abc.bodyMethod[b];
        try lines.next();
        try w.print("body {d} method={d} stack={d} locals={d}", .{ b, method, abc.bodyMaxStack[b], abc.bodyLocalCount[b] });
        try w.print(" scope={d}..{d}", .{ abc.bodyInitScopeDepth[b], abc.bodyMaxScopeDepth[b] });
        try w.print(" code={d}+{d}", .{ abc.bodyCode[b].start, abc.bodyCode[b].len });
        const start = abc.bodyExceptionStart[b];
        const end = abc.bodyExceptionStart[b + 1];
        if (end > start) {
            try w.writeAll(" exceptions=");
            var e = start;
            while (e < end) : (e += 1) {
                if (e > start) {
                    try w.writeByte(',');
                }

                try w.print("{d}-{d}>{d}:{d}:{d}", .{ abc.exceptionFrom[e], abc.exceptionTo[e], abc.exceptionTarget[e], abc.exceptionType[e], abc.exceptionName[e] });
            }
        }

        try dumpTraits(&lines, abc, "activation", method, abc.bodyTraitStart[b], abc.bodyTraitStart[b + 1]);
    }

    for (0..abc.methodCount()) |i| {
        const owner = abc.methodOwner[i];
        if (owner >= 0) {
            try lines.next();
            try w.print("bound method {d} to ", .{i});
            try writeOwner(w, abc, owner);
        }
    }

    return out.written();
}

/// Lines joined by newlines, as `out.join("\n")` joins them.
const Lines = struct {
    w: *Writer,
    first: bool = true,

    fn next(self: *Lines) Writer.Error!void {
        if (!self.first) {
            try self.w.writeByte('\n');
        }

        self.first = false;
    }
};

fn dumpTraits(lines: *Lines, abc: *const Abc, owner: []const u8, index: u32, start: u32, end: u32) Writer.Error!void {
    const w = lines.w;
    var t = start;
    while (t < end) : (t += 1) {
        const tag = abc.traitTag[t];
        try lines.next();
        try w.print("  trait {s} {d} name={d} kind={d} attr=", .{ owner, index, abc.traitName[t], tag & 0x0f });
        try writeHex(w, tag & 0xf0);
        try w.print(" id={d} index={d}", .{ abc.traitId[t], abc.traitIndex[t] });
        if (abc.traitValue[t] != 0) {
            try w.print(" value={d}:", .{abc.traitValue[t]});
            try writeHex(w, abc.traitValueKind[t]);
        }

        const metadataStart = abc.traitMetadataStart[t];
        const metadataEnd = abc.traitMetadataStart[t + 1];
        if (metadataEnd > metadataStart) {
            try w.writeAll(" metadata=");
            try join(w, abc.traitMetadata, metadataStart, metadataEnd);
        }
    }
}

fn writeOwner(w: *Writer, abc: *const Abc, owner: i32) Writer.Error!void {
    const classes: i32 = @intCast(abc.classCount());
    if (owner < classes) {
        return w.print("instance {d}", .{owner});
    }

    if (owner < 2 * classes) {
        return w.print("class {d}", .{owner - classes});
    }

    const scripts: i32 = @intCast(abc.scriptCount());
    if (owner < 2 * classes + scripts) {
        return w.print("script {d}", .{owner - 2 * classes});
    }

    try w.print("activation {d}", .{owner - 2 * classes - scripts});
}

fn join(w: *Writer, items: []const u32, start: u32, end: u32) Writer.Error!void {
    var i = start;
    while (i < end) : (i += 1) {
        if (i > start) {
            try w.writeByte(',');
        }

        try w.print("{d}", .{items[i]});
    }
}

/// The opcode table, one "opcode name layout flags" line per opcode.
/// Decode every method body without types: "body B method M", then one
/// "offset name a b c" line per reachable instruction (lookupswitch adds
/// its case offsets), then "unreachable N" bytes, or "error N" if avmplus'
/// verifier would reject it.
pub fn codeDump(gpa: Allocator, bytes: []const u8, builtin: bool) Error![]const u8 {
    const data = try padded(gpa, bytes);
    const abc = try readAbc(gpa, gpa, data, @intCast(bytes.len), builtin);
    var out: Output = try .init(gpa);
    const w = out.writer();
    if (abc.@"error" != 0) {
        try w.print("error {d}", .{abc.@"error"});
        return out.written();
    }

    var lines: Lines = .{ .w = w };
    var decoder: BodyDecoder = try .init(gpa, abc, data, null, 0);
    for (0..abc.bodyCount()) |b| {
        const body: u32 = @intCast(b);
        try lines.next();
        try w.print("body {d} method {d}", .{ body, abc.bodyMethod[body] });
        const code = try decoder.decode(body, null);
        if (code.@"error" != 0) {
            try lines.next();
            try w.print("  error {d}", .{code.@"error"});
            continue;
        }

        var decoded: u32 = 0;
        for (0..code.count) |i| {
            const opcode = code.opcode[i];
            try lines.next();
            try w.print("  {d} {s} {d} {d} {d}", .{ code.offset[i], ops.opcodeNames[opcode], code.a[i], code.b[i], code.c[i] });
            if (opcode == ops.OP_lookupswitch) {
                try w.writeAll(" [");
                var j = code.c[i];
                while (j <= code.c[i] + code.b[i]) : (j += 1) {
                    if (j > code.c[i]) {
                        try w.writeByte(',');
                    }

                    try w.print("{d}", .{code.cases[j]});
                }

                try w.writeByte(']');
            }

            decoded += code.next[i] - code.offset[i];
        }

        try lines.next();
        try w.print("  unreachable {d}", .{abc.bodyCode[body].len - decoded});
    }

    return out.written();
}

/// Parse `bytes` `rounds` times, for tests/bench/bench.ts: the methods an
/// ABC has. Each round's tables are given back before the next.
pub fn benchParse(gpa: Allocator, bytes: []const u8, rounds: i32) Allocator.Error!i32 {
    const data = try padded(gpa, bytes);
    var methods: i32 = 0;
    for (0..@intCast(@max(rounds, 0))) |_| {
        const saved = memory.call.mark();
        defer memory.call.restore(saved);
        const abc = try readAbc(gpa, gpa, data, @intCast(bytes.len), false);
        methods +%= @intCast(abc.methodCount());
    }

    return methods;
}

/// Parse `bytes` once, then decode every body `rounds` times, for
/// tests/bench/bench.ts: the instructions a round decodes.
pub fn benchDecode(gpa: Allocator, bytes: []const u8, rounds: i32) Allocator.Error!i32 {
    const data = try padded(gpa, bytes);
    const abc = try readAbc(gpa, gpa, data, @intCast(bytes.len), false);
    if (abc.@"error" != 0) {
        return 0;
    }

    var decoder: BodyDecoder = try .init(gpa, abc, data, null, 0);
    var instructions: i32 = 0;
    for (0..@intCast(@max(rounds, 0))) |_| {
        instructions = 0;
        // The decoder keeps its scratch from one body to the next.
        for (0..abc.bodyCount()) |b| {
            const code = try decoder.decode(@intCast(b), null);
            instructions +%= @intCast(code.count);
        }
    }

    return instructions;
}

pub fn opcodeTable(gpa: Allocator) Error![]const u8 {
    var out: Output = try .init(gpa);
    const w = out.writer();
    for (0..256) |op| {
        if (op > 0) {
            try w.writeByte('\n');
        }

        try w.print("{d} {s} {d} {d}", .{ op, ops.opcodeNames[op], ops.opcodeOperands[op], ops.opcodeFlags[op] });
    }

    return out.written();
}

/// The smallest ABC with something in each table: a string, a namespace, a
/// QName, a method, a script with a slot, and a body.
const tiny_abc = [_]u8{
    16, 0, 46, 0, // minor 16, major 46
    0, 0, 0, // no ints, uints, doubles
    2, 1, 'x', // strings: "x"
    2, 0x16, 1, // namespaces: package "x"
    0, // no namespace sets
    2, 0x07, 1, 1, // multinames: QName(x, x)
    1, 0, 0, 0, 0, // method 0: no params, returns *, no name, no flags
    0, // no metadata
    0, // no classes
    1, 0, 1, 1, 0, 0, 0, 0, // script 0: init 0, a slot x
    1, 0, 1, 1, 0, 1, 1, 0x47, 0, 0, // body of method 0: returnvoid
};

test "a tiny ABC's tables dump as abcDump writes them" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(
        \\method 0 ret=0 params= name=0 flags=0x00
        \\script 0 init=0
        \\  trait script 0 name=1 kind=0 attr=0x00 id=0 index=0
        \\body 0 method=0 stack=1 locals=1 scope=0..1 code=40+1
        \\bound method 0 to script 0
    , try abcDump(arena.allocator(), &tiny_abc, false));
    try std.testing.expectEqualStrings("string 1 x\nns 1 0x16 1\nmn 1 0x07 1 1\n", try poolDump(arena.allocator(), &tiny_abc));
}

/// Every dump of the tiny ABC, in an arena over `source`.
fn dumpTiny(source: Allocator, _: *memory.Pages) !void {
    var arena: memory.Arena = .init(source);
    defer arena.deinit();
    tinyDumps(arena.allocator()) catch |err| switch (err) {
        // The writer fails only as its buffer cannot grow.
        error.OutOfMemory, error.WriteFailed => return error.OutOfMemory,
    };
}

fn tinyDumps(gpa: Allocator) Error!void {
    _ = try poolDump(gpa, &tiny_abc);
    _ = try abcDump(gpa, &tiny_abc, true);
    _ = try readAll(gpa, &tiny_abc, &.{ U16, U16, U30, UTF8, D64 });
    _ = try opcodeTable(gpa);
}

test "the ABC parser and its dumps may run out of memory anywhere, and keep nothing" {
    try memory.atEveryMemorySize(dumpTiny);
}

/// tests/parity/rich-abc.ts's ABC at 47.16: something of every kind the
/// parser reads, floats, namespace sets, metadata, a class, optional
/// values, exceptions and activation traits among them.
pub const rich_abc = [_]u8{
    0x10, 0x00, 0x2f, 0x00, 0x04, 0x01, 0xfb, 0xff, 0xff, 0xff, 0x0f, 0xff, 0xff, 0xff, 0xff, 0x07,
    0x03, 0x07, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x04, 0x9a, 0x99, 0x99, 0x99, 0x99, 0x99, 0xb9, 0x3f,
    0x9c, 0x75, 0x00, 0x88, 0x3c, 0xe4, 0x37, 0x7e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
    0x03, 0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x80, 0x4b, 0x08, 0x01, 0x78, 0x00, 0x06, 0x68, 0xc3,
    0xa9, 0x6c, 0x6c, 0x6f, 0x06, 0x56, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x02, 0x6e, 0x73, 0x01, 0x79,
    0x01, 0x7a, 0x08, 0x16, 0x01, 0x08, 0x05, 0x05, 0x00, 0x17, 0x02, 0x18, 0x05, 0x19, 0x05, 0x1a,
    0x05, 0x04, 0x01, 0x01, 0x03, 0x01, 0x02, 0x03, 0x01, 0x04, 0x0f, 0x07, 0x01, 0x01, 0x0d, 0x01,
    0x06, 0x0f, 0x01, 0x10, 0x01, 0x11, 0x12, 0x09, 0x01, 0x01, 0x0e, 0x07, 0x02, 0x1b, 0x01, 0x1c,
    0x03, 0x1d, 0x01, 0x01, 0x02, 0x1d, 0x01, 0x01, 0x0b, 0x07, 0x01, 0x06, 0x07, 0x01, 0x07, 0x07,
    0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x01, 0x02, 0x01, 0x88, 0x02, 0x01, 0x03, 0x02, 0x06, 0x01,
    0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01, 0x02, 0x01, 0x02, 0x00, 0x03, 0x02, 0x00, 0x01,
    0x01, 0x0d, 0x08, 0x02, 0x02, 0x0d, 0x0e, 0x02, 0x03, 0x0d, 0x40, 0x01, 0x01, 0x01, 0x03, 0x02,
    0x00, 0x01, 0x0e, 0x06, 0x02, 0x00, 0x00, 0x01, 0x01, 0x00, 0x03, 0x04, 0x01, 0x0d, 0x02, 0x00,
    0x05, 0x01, 0x00, 0x02, 0x01, 0x04, 0x01, 0x00, 0x0e, 0x03, 0x00, 0x06, 0x03, 0x00, 0x01, 0x01,
    0x00, 0x01, 0x03, 0xd0, 0x30, 0x47, 0x02, 0x00, 0x01, 0x02, 0x01, 0x0d, 0x00, 0x02, 0x02, 0x00,
    0x00, 0x00, 0x01, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x01, 0x0d, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x47, 0x00, 0x00,
};

fn richDumps(gpa: Allocator) Error!void {
    _ = try poolDump(gpa, &rich_abc);
    _ = try abcDump(gpa, &rich_abc, false);
    _ = try abcDump(gpa, &rich_abc, true);
}

test "the rich ABC parses whole" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const tables = try abcDump(arena.allocator(), &rich_abc, false);
    try std.testing.expect(std.mem.indexOf(u8, tables, "error") == null);
    try std.testing.expect(std.mem.indexOf(u8, tables, "exceptions=") != null);
}

test "every allocation the parser and its dumps make may fail, each in turn, and leave nothing" {
    const t = try memory.TestPages.init(64 << 20);
    defer t.deinit();
    var total: usize = 0;
    {
        var arena: memory.Arena = .init(t.pages.allocator());
        defer arena.deinit();
        var counting = std.testing.FailingAllocator.init(arena.allocator(), .{});
        try richDumps(counting.allocator());
        total = counting.alloc_index;
    }

    try std.testing.expect(total > 50);
    for (0..total) |index| {
        var arena: memory.Arena = .init(t.pages.allocator());
        var failing = std.testing.FailingAllocator.init(arena.allocator(), .{ .fail_index = index });
        if (richDumps(failing.allocator())) |_| {
            return error.TestUnexpectedResult;
        } else |err| switch (err) {
            error.OutOfMemory, error.WriteFailed => {},
        }

        arena.deinit();
        try std.testing.expectEqual(0, t.pages.used);
    }
}
