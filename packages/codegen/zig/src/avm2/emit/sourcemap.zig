// A source map, version 3, from the ABC's debugfile and debugline
// instructions (assembly/avm2/emit/sourcemap.ts): where the module's code
// for each AS3 line starts. The method emitter marks the output as it
// writes it, in order; the map then finds each mark's line and column in
// the module by walking its bytes once.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const Output = output.Output;
const ConstantPool = @import("../abc/pool.zig").ConstantPool;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub const SourceMap = struct {
    gpa: Allocator,
    /// Each mark: the module offset its code starts at, its file (a string of the pool) and its line.
    offset: std.ArrayList(u32) = .empty,
    file: std.ArrayList(i32) = .empty,
    line: std.ArrayList(u32) = .empty,
    /// The files in the order the map lists them, by string, and each string's place in it.
    sources: std.ArrayList(i32) = .empty,
    sourceIndex: std.AutoHashMapUnmanaged(i32, i32) = .empty,

    pub fn reset(self: *SourceMap) void {
        self.offset.clearRetainingCapacity();
        self.file.clearRetainingCapacity();
        self.line.clearRetainingCapacity();
    }

    pub fn count(self: *const SourceMap) i32 {
        return @intCast(self.offset.items.len);
    }

    /// Forget the marks from `count` on, of code written again.
    pub fn truncate(self: *SourceMap, n: i32) void {
        const k: usize = @intCast(n);
        self.offset.shrinkRetainingCapacity(k);
        self.file.shrinkRetainingCapacity(k);
        self.line.shrinkRetainingCapacity(k);
    }

    /// Forget every mark but the last, made `by` bytes earlier, as the text
    /// before it is handed out (ModuleEmitter.step): marking compares the
    /// last mark's offset with the next's, and the two stay as far apart.
    pub fn rebase(self: *SourceMap, by: u32) void {
        const n = self.offset.items.len;
        if (n == 0) {
            return;
        }

        self.offset.items[0] = self.offset.items[n - 1] -% by;
        self.file.items[0] = self.file.items[n - 1];
        self.line.items[0] = self.line.items[n - 1];
        self.truncate(1);
    }

    /// The marks from `from` on moved `by` bytes later, for text put in before them.
    pub fn shift(self: *SourceMap, from: i32, by: u32) void {
        var m: usize = @intCast(@max(from, 0));
        while (m < self.offset.items.len) : (m += 1) {
            self.offset.items[m] +%= by;
        }
    }

    /// The code from module offset `at` on is from line `line` of `file`; nothing if either is unknown.
    pub fn mark(self: *SourceMap, at: u32, file: i32, line: u32) Allocator.Error!void {
        if (file < 0 or line == 0) {
            return;
        }

        const n = self.offset.items.len;
        if (n > 0 and self.file.items[n - 1] == file and self.line.items[n - 1] == line) {
            return;
        }

        if (n > 0 and self.offset.items[n - 1] == at) {
            self.file.items[n - 1] = file;
            self.line.items[n - 1] = line;
            return;
        }

        try self.offset.append(self.gpa, at);
        try self.file.append(self.gpa, file);
        try self.line.append(self.gpa, line);
    }

    /// The map's JSON into `out`, for the module in `module`: its sources as
    /// paths (asc names a file `directory;package;File.as`), and its mappings,
    /// columns counted in UTF-16 code units as JavaScript counts them.
    pub fn write(self: *SourceMap, out: *Output, module: *const Output, pool: *const ConstantPool, data: []const u8) Allocator.Error!void {
        self.sources.clearRetainingCapacity();
        self.sourceIndex.clearRetainingCapacity();
        for (self.file.items) |f| {
            if (!self.sourceIndex.contains(f)) {
                try self.sourceIndex.put(self.gpa, f, @intCast(self.sources.items.len));
                try self.sources.append(self.gpa, f);
            }
        }

        out.reset();
        try out.text("{\"version\":3,\"sources\":[");
        for (self.sources.items, 0..) |f, s| {
            if (s > 0) {
                try out.byte(',');
            }

            const at: u32 = @intCast(f);
            try path(out, data[pool.stringStart[at]..][0..pool.stringLength[at]]);
        }

        try out.text("],\"names\":[],\"mappings\":\"");
        var genCol: u32 = 0;
        var at: u32 = 0;
        var prevCol: i32 = 0;
        var prevSource: i32 = 0;
        var prevLine: i32 = 0;
        var first = true;
        const bytes = module.written();
        for (0..self.offset.items.len) |m| {
            const to = @min(self.offset.items[m], module.len());
            while (at < to) : (at += 1) {
                const b = bytes[at];
                if (b == '\n') {
                    try out.byte(';');
                    genCol = 0;
                    prevCol = 0;
                    first = true;
                } else if ((b & 0xc0) != 0x80) {
                    // A character's first byte; one past U+FFFF is two code units.
                    genCol += if (b >= 0xf0) 2 else 1;
                }
            }

            if (!first) {
                try out.byte(',');
            }

            first = false;
            const source = self.sourceIndex.get(self.file.items[m]).?;
            const line = @as(i32, @bitCast(self.line.items[m])) - 1;
            try vlq(out, @as(i32, @bitCast(genCol)) - prevCol);
            try vlq(out, source - prevSource);
            try vlq(out, line - prevLine);
            try vlq(out, 0);
            prevCol = @bitCast(genCol);
            prevSource = source;
            prevLine = line;
        }

        try out.text("\"}");
    }
};

/// A pool string as a JSON string of a path: each `;` a `/`, never two
/// together, and past ASCII \u escapes, as in the module.
fn path(out: *Output, bytes: []const u8) Allocator.Error!void {
    try out.byte('"');
    var slash = false;
    var i: usize = 0;
    while (i < bytes.len) {
        var b = bytes[i];
        if (b >= 0x80) {
            slash = false;
            const n = output.wellFormed(bytes[i..]);
            if (n == 0) {
                i += try out.lenient(bytes[i..]);
            } else {
                try out.point(output.codePoint(bytes[i..], n));
                i += n;
            }

            continue;
        }

        i += 1;
        if (b == ';' or b == '\\') {
            b = '/';
        }

        if (b == '/') {
            if (!slash) {
                try out.byte(b);
            }

            slash = true;
            continue;
        }

        slash = false;
        if (b == '"') {
            try out.text("\\\"");
        } else if (b < 0x20 or b == 0x7f) {
            try out.text("\\u00");
            try out.hex(b);
        } else {
            try out.byte(b);
        }
    }

    try out.byte('"');
}

/// n in base64 VLQ: its sign in the lowest bit, five bits a digit, the least first.
fn vlq(out: *Output, n: i32) Allocator.Error!void {
    var v: u32 = if (n < 0) (@as(u32, @bitCast(-%n)) << 1) | 1 else @as(u32, @bitCast(n)) << 1;
    while (true) {
        var digit = v & 31;
        v >>= 5;
        if (v != 0) {
            digit |= 32;
        }

        try out.byte(BASE64[digit]);
        if (v == 0) {
            break;
        }
    }
}
