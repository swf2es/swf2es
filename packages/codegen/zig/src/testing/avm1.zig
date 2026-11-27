// The test build's look at AVM1, for the node tests, as
// assembly/testing/avm1.ts writes it: its opcodes, and a SWF's action
// blocks as the decoder reads them and the flow divides them into regions.
// Strings are written as the bytes of the string AssemblyScript made of
// them, each decoded alone (String.UTF8.decodeUnsafe), so that the wrapper
// reads the same text.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;
const memory = @import("../memory.zig");
const output = @import("../output.zig");
const Output = output.Output;
const decode = @import("../avm1/actions/decode.zig");
const Action = decode.Action;
const Actions = decode.Actions;
const Op = @import("../avm1/actions/opcodes.zig").Op;
const regions = @import("../avm1/flow/regions.zig");
const Flow = regions.Flow;
const Region = regions.Region;

pub const Error = output.Error;

/// "0x96": a byte as the node tests expect it.
fn writeHex(w: *Writer, b: u8) Writer.Error!void {
    try w.print("0x{x:0>2}", .{b});
}

/// The AVM1 actions Flash knows, one a line: "0x96 Push".
pub fn opcodes(gpa: Allocator) Error![]const u8 {
    var out: Output = try .init(gpa);
    const w = out.writer();
    var first = true;
    for (0..256) |op| {
        const known: Op = @fromBackingInt(@intCast(op));
        if (!known.known()) {
            continue;
        }

        if (!first) {
            try w.writeByte('\n');
        }

        first = false;
        try writeHex(w, @intCast(op));
        try w.print(" {s}", .{known.name()});
    }

    return out.written();
}

/// An opcode's name, its hex for one Flash does not know.
fn writeName(w: *Writer, op: Op) Writer.Error!void {
    try w.writeAll(op.name());
}

/// A block's actions and regions, analyzed as avm1Dump and avm1Check take them.
const Analyzed = struct {
    actions: Actions,
    flow: Flow,

    fn of(gpa: Allocator, bytes: []const u8) Error!*Analyzed {
        const self = try gpa.create(Analyzed);
        self.* = .{ .actions = .{ .gpa = gpa }, .flow = undefined };
        self.flow = .{ .gpa = gpa, .actions = &self.actions };
        try self.actions.reset(bytes, 0, @intCast(bytes.len), null);
        return self;
    }

    /// Whether the flow found the block too large.
    fn tooLarge(self: *Analyzed) Allocator.Error!bool {
        self.flow.analyze(.block, 0, null, 0, null) catch |err| switch (err) {
            error.TooLarge => return true,
            error.OutOfMemory => |e| return e,
        };
        return false;
    }
};

/// An AVM1 block's regions as the flow finds them, each with its blocks and
/// their actions, one a line; only "too large" if it is.
pub fn dump(gpa: Allocator, bytes: []const u8) Error![]const u8 {
    const a = try Analyzed.of(gpa, bytes);
    if (try a.tooLarge()) {
        return "too large";
    }

    var out: Output = try .init(gpa);
    const w = out.writer();
    for (a.flow.regions.items, 0..) |region, r| {
        if (r > 0) {
            try w.writeByte('\n');
        }

        try w.print("region {d} {s} {d}-{d}", .{ r, if (region.kind == .function) "function" else "block", region.start, region.end });
        if (region.parent) |parent| {
            try w.print(" from {d} at {d}", .{ parent, a.actions.get(region.opener.?).offset });
        }

        for (0..region.blockCount()) |k| {
            try w.print("\nblock {d}", .{region.blocks.items[k]});
            for (region.blockActions(@intCast(k))) |index| {
                try w.writeByte('\n');
                try writeLine(w, &a.actions, a.actions.get(index), region, null);
            }
        }
    }

    return out.written();
}

/// What dump shows, briefly, for the fuzzer: "regions, actions, a hash of
/// every region's blocks and actions", "too large", or the first region
/// that lists an action in two of its blocks.
pub fn check(gpa: Allocator, bytes: []const u8) Error![]const u8 {
    const a = try Analyzed.of(gpa, bytes);
    if (try a.tooLarge()) {
        return "too large";
    }

    var out: Output = try .init(gpa);
    const w = out.writer();
    const seen = try memory.allocZeroed(gpa, i32, @intCast(bytes.len));
    var hash: u32 = 2166136261;
    var count: u32 = 0;
    for (a.flow.regions.items, 0..) |region, r| {
        const kind: u32 = @backingInt(region.kind);
        hash = (hash ^ (kind | (@as(u32, @bitCast(region.start)) *% 8))) *% 16777619;
        hash = (hash ^ @as(u32, @bitCast(region.end))) *% 16777619;
        for (region.blocks.items) |block| {
            hash = (hash ^ @as(u32, @bitCast(block))) *% 16777619;
        }

        for (region.order.items) |index| {
            const act = a.actions.get(index);
            const at: usize = @intCast(act.offset);
            if (seen[at] == r + 1) {
                try w.print("repeated in region {d}", .{r});
                return out.written();
            }

            seen[at] = @intCast(r + 1);
            hash = (hash ^ (@as(u32, @bitCast(act.offset)) | (@as(u32, @backingInt(act.op)) << 24))) *% 16777619;
            hash = (hash ^ @as(u32, @bitCast(target(act)))) *% 16777619;
            count += 1;
        }
    }

    try w.print("{d} {d} {d}", .{ a.flow.regions.items.len, count, hash });
    return out.written();
}

/// The action at `offset` of an AVM1 block alone, and where the next one starts.
pub fn action(gpa: Allocator, bytes: []const u8, offset: i32) Error![]const u8 {
    var actions: Actions = .{ .gpa = gpa };
    try actions.reset(bytes, 0, @intCast(bytes.len), null);
    const decoded = try actions.decode(offset);
    if (decoded.operands == .wait) {
        try actions.skip(decoded);
    }

    // AssemblyScript's skip of a Jump or an If skips none after it.
    const skipped: ?i32 = if (decoded.operands == .branch) decoded.next else null;

    // As `new Region(...)` makes it: its home empty, so every branch leaves it.
    const region: Region = .{ .kind = .block, .start = 0, .end = @intCast(bytes.len) };
    var out: Output = try .init(gpa);
    const w = out.writer();
    try writeLine(w, &actions, decoded, &region, skipped);
    try w.print(" next {d}", .{decoded.next});
    return out.written();
}

/// AssemblyScript's Action.target: where a Jump, an If or a WaitForFrame
/// goes, once set; 0 for any other, and for a Jump or If cut short.
fn target(a: *const Action) i32 {
    return switch (a.operands) {
        .branch => |to| if (a.ok()) to else 0,
        .wait => |wait| wait.target orelse 0,
        else => 0,
    };
}

fn branches(a: *const Action) bool {
    return a.ok() and switch (a.op) {
        .jump, .@"if", .wait_for_frame, .wait_for_frame2 => true,
        else => false,
    };
}

/// An action's line; `skipped` its target where Actions.skip set it again,
/// as AssemblyScript's avm1Action has it skip any action, a Jump's or an
/// If's target becoming where it would skip to.
fn writeLine(w: *Writer, actions: *const Actions, a: *const Action, region: *const Region, skipped: ?i32) Writer.Error!void {
    try w.print("{d} ", .{a.offset});
    try writeName(w, a.op);
    if (a.err) |err| {
        return w.writeAll(if (err == error.UnknownPushType) " push type" else " truncated");
    }

    switch (a.operands) {
        .frame => |frame| try w.print(" {d}", .{frame}),
        .url => |url| {
            try w.writeByte(' ');
            try writeString(w, url.url);
            try w.writeByte(' ');
            try writeString(w, url.target);
        },
        .register => |r| try w.print(" r{d}", .{r}),
        .pool => |pool| for (actions.poolStrings(pool)) |s| {
            try w.writeByte(' ');
            try writeString(w, s);
        },
        .name => |name| {
            try w.writeByte(' ');
            try writeString(w, name);
        },
        .wait => |wait| if (a.op == .wait_for_frame) {
            try w.print(" {d} skip {d}", .{ wait.frame, wait.skip });
        } else {
            try w.print(" skip {d}", .{wait.skip});
        },
        .function => |function| {
            try w.writeByte(' ');
            try writeString(w, function.name);
            if (a.op == .define_function2) {
                const flags: u16 = @bitCast(function.flags);
                try w.print(" registers {d} flags 0x{x:0>2}{x:0>2}", .{ function.registers, flags >> 8, flags & 0xff });
            }

            try w.writeAll(" (");
            for (actions.functionParams(function), 0..) |param, i| {
                if (i > 0) {
                    try w.writeAll(", ");
                }

                if (param.register != 0) {
                    try w.print("r{d}=", .{param.register});
                }

                try writeString(w, param.name);
            }
            try w.print(") body {d}-{d} region {d}", .{ function.body.start, function.body.end, @as(i64, if (function.region) |r| r else -1) });
        },
        .@"try" => |t| {
            const flags: u8 = @bitCast(t.flags);
            try w.print(" flags {d}", .{flags});
            switch (t.catch_into) {
                .register => |r| try w.print(" r{d}", .{r}),
                .variable => |name| {
                    try w.writeByte(' ');
                    try writeString(w, name);
                },
                .none => {},
            }
            try w.print(" try {d}-{d} catch {d}-{d} finally {d}-{d}", .{ t.start, t.catch_start, t.catch_start, t.finally_start, t.finally_start, t.end });
        },
        .with => |body| try w.print(" body {d}-{d}", .{ body.start, body.end }),
        .push => |push| for (actions.pushValues(push)) |value| {
            try w.writeByte(' ');
            try writeValue(w, value);
        },
        .branch => |to| try w.print(" {d}", .{to - a.next}),
        .get_url2 => |flags| {
            try w.writeByte(' ');
            try writeHex(w, flags);
        },
        .goto_frame2 => |frame2| try w.print(" play {d} bias {d}", .{ @intFromBool(frame2.play), frame2.bias }),
        .none => {},
    }

    if (branches(a)) {
        const to = skipped orelse target(a);
        if (region.runs(to)) {
            try w.print(" -> {d}", .{to});
        } else {
            try w.print(" -> exit {d}", .{to});
        }
    }
}

fn writeValue(w: *Writer, value: decode.Value) Writer.Error!void {
    switch (value) {
        .string => |s| try writeString(w, s),
        .float => |n| {
            try output.writeF64(w, n);
            try w.writeByte('f');
        },
        .double => |n| try output.writeF64(w, n),
        .null => try w.writeAll("null"),
        .undefined => try w.writeAll("undefined"),
        .register => |r| try w.print("r{d}", .{r}),
        .boolean => |b| try w.writeAll(if (b) "true" else "false"),
        .integer => |i| try w.print("{d}i", .{i}),
        .constant8 => |i| try w.print("c{d}", .{i}),
        .constant16 => |i| try w.print("C{d}", .{i}),
    }
}

/// A string as `"..."`, of the string AssemblyScript decodes its bytes to.
fn writeString(w: *Writer, s: []const u8) Writer.Error!void {
    try w.writeByte('"');
    try output.writeDecoded(w, s);
    try w.writeByte('"');
}
