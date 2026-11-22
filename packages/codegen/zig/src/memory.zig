// Memory for the compiler, with no general-purpose allocator and no free
// of single objects. Every allocation takes an arena named for how long it
// lives (docs/zig-codegen.md, section 2):
//
//   - `call`, reset as the next call starts: scratch, output, everything a
//     call hands out, which stays until then;
//   - a domain's, freed whole: M1 has one per Domain, and a rebuild makes
//     the new Domain in a new arena before the old one is freed;
//   - `global`: what outlives domains, small or freed explicitly.
//
// All take runs of chunks from one page allocator, `Pages`, over the
// module's memory: fixed chunks, a bitmap of the free ones, runs of
// adjacent chunks for anything larger, and memory.grow by what is needed,
// never by doubling. A freed run's chunks are free chunks again, adjacent
// ones one run, whoever freed them. The call arena takes its runs from the
// top, so that its last allocation (the output, a decoder's scratch) grows
// in place by growing memory; domains take theirs first-fit from below.
//
// Nothing here zeroes memory: an arena hands back the bytes of whatever
// was there before, so code that relied on AssemblyScript's zeroed
// allocations allocates zeroed (`allocZeroed`). The poison build fills
// every freed run and every rolled-back allocation with 0xAA, and must give
// the same output: what does not is reading memory it never wrote.
//
// Sizes and indices are u32, as wasm32's are, so that a native build (the
// tests) computes what the module does.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("options");
const Allocator = std.mem.Allocator;
const Alignment = std.mem.Alignment;

pub const chunk_size: u32 = 16 * 1024;
/// What memory.grow adds at least: a wasm page, in chunks.
const grow_chunks: u32 = std.wasm.page_size / chunk_size;
/// wasm32's 4 GiB, in chunks.
const max_chunks: u32 = 1 << 18;

/// Whether this is the poison build, and the byte it fills freed memory with.
pub const poison = options.poison;
pub const poison_byte: u8 = 0xAA;

const wasm = builtin.cpu.arch.isWasm();

/// Chunks of memory, each in use or free, from `base` up to as far as
/// memory reaches, which grows by what a run needs and never shrinks.
pub const Pages = struct {
    /// Where chunk 0 starts, chunk-aligned.
    base: usize,
    /// How many chunks memory reaches.
    chunks: u32 = 0,
    /// The most chunks memory may reach.
    limit: u32,
    /// How many chunks are in use.
    used: u32 = 0,
    /// A bit a chunk, set where it is free; clear past `chunks`.
    free_bits: []u64,

    /// Pages over the module's memory past its static data and stack.
    fn ofModule(bits: []u64) Pages {
        const heap = @intFromPtr(&__heap_base);
        const base = std.mem.alignForward(usize, heap, chunk_size);
        var end = @wasmMemorySize(0) * std.wasm.page_size;
        if (end < base) {
            const grown = (base - end + std.wasm.page_size - 1) / std.wasm.page_size;
            if (@wasmMemoryGrow(0, grown) < 0) {
                @panic("cannot grow memory past the static data");
            }

            end += grown * std.wasm.page_size;
        }

        var self: Pages = .{ .base = base, .limit = moduleLimit(base), .free_bits = bits };
        const chunks: u32 = @intCast((end - base) / chunk_size);
        if (poison) {
            const at: [*]u8 = @ptrFromInt(base);
            @memset(at[0 .. @as(usize, chunks) * chunk_size], poison_byte);
        }

        self.mark(0, chunks, true);
        self.chunks = chunks;
        return self;
    }

    /// The most chunks memory past `base` may reach: all but the last of
    /// wasm32's 4 GiB, so that no run's end, an address one past it, is
    /// 2^32, which a u32 address cannot hold.
    fn moduleLimit(base: usize) u32 {
        return max_chunks - @as(u32, @intCast(base / chunk_size)) - 1;
    }

    /// Pages over `region`, which memory may grow to fill: natively, for
    /// the tests, as the module's memory is grown on wasm.
    pub fn ofRegion(region: []align(chunk_size) u8, bits: []u64) Pages {
        @memset(bits, 0);
        const limit: u32 = @intCast(@min(region.len / chunk_size, bits.len * 64));
        return .{ .base = @intFromPtr(region.ptr), .limit = limit, .free_bits = bits };
    }

    pub fn address(self: *const Pages, chunk: u32) usize {
        return self.base + @as(usize, chunk) * chunk_size;
    }

    fn chunkOf(self: *const Pages, ptr: [*]u8) u32 {
        return @intCast((@intFromPtr(ptr) - self.base) / chunk_size);
    }

    /// The bytes memory reaches past `base`, which only grows.
    pub fn reached(self: *const Pages) u32 {
        return self.chunks *| chunk_size;
    }

    fn isFree(self: *const Pages, chunk: u32) bool {
        return (self.free_bits[chunk >> 6] >> @as(u6, @truncate(chunk))) & 1 != 0;
    }

    fn mark(self: *Pages, start: u32, count: u32, free: bool) void {
        var at = start;
        const end = start + count;
        while (at < end) {
            const bit: u6 = @truncate(at);
            const span = @min(64 - @as(u32, bit), end - at);
            const ones: u64 = if (span == 64) ~@as(u64, 0) else (@as(u64, 1) << @intCast(span)) - 1;
            if (free) {
                self.free_bits[at >> 6] |= ones << bit;
            } else {
                self.free_bits[at >> 6] &= ~(ones << bit);
            }

            at += span;
        }
    }

    /// The first run of `count` free chunks, if there is one.
    fn firstFit(self: *const Pages, count: u32) ?u32 {
        var start: u32 = 0;
        var run: u32 = 0;
        var at: u32 = 0;
        while (at < self.chunks) {
            if (at & 63 == 0 and at + 64 <= self.chunks) {
                const word = self.free_bits[at >> 6];
                if (word == 0) {
                    run = 0;
                    at += 64;
                    continue;
                }

                if (word == ~@as(u64, 0)) {
                    if (run == 0) {
                        start = at;
                    }

                    run += 64;
                    at += 64;
                    if (run >= count) {
                        return start;
                    }

                    continue;
                }
            }

            if (self.isFree(at)) {
                if (run == 0) {
                    start = at;
                }

                run += 1;
                if (run >= count) {
                    return start;
                }
            } else {
                run = 0;
            }

            at += 1;
        }

        return null;
    }

    /// How many chunks at the end of memory are free.
    fn freeAtEnd(self: *const Pages) u32 {
        var count: u32 = 0;
        while (count < self.chunks and self.isFree(self.chunks - 1 - count)) {
            count += 1;
        }

        return count;
    }

    /// Memory grown by at least `count` chunks, by whole wasm pages: whether it could be.
    fn grow(self: *Pages, count: u32) bool {
        const more = std.mem.alignForward(u32, count, grow_chunks);
        if (more > self.limit - self.chunks) {
            return false;
        }

        if (wasm and @wasmMemoryGrow(0, more / grow_chunks) < 0) {
            return false;
        }

        // Fresh memory is zero, which code may come to rely on as much as on what it freed.
        if (poison) {
            const at: [*]u8 = @ptrFromInt(self.address(self.chunks));
            @memset(at[0 .. @as(usize, more) * chunk_size], poison_byte);
        }

        self.mark(self.chunks, more, true);
        self.chunks += more;
        return true;
    }

    /// A run of `count` chunks: the first that fits, or, `top`, past every
    /// chunk in use and `reserve` chunks more, so that it can grow in
    /// place while what other arenas take meanwhile fits below it.
    pub fn take(self: *Pages, count: u32, top: bool) ?u32 {
        const start = found: {
            if (!top) {
                if (self.firstFit(count)) |start| {
                    break :found start;
                }
            }

            const free = self.freeAtEnd();
            const gap = if (top) @min(reserve, self.limit -| (self.chunks - free + count)) else 0;
            const start = self.chunks - free + gap;
            if (gap + count > free and !self.grow(gap + count - free)) {
                return null;
            }

            if (top) {
                top_runs +%= 1;
            }

            break :found start;
        };
        self.mark(start, count, false);
        self.used += count;
        return start;
    }

    /// The run at `start` grown from `count` chunks to `wanted`, where the
    /// chunks after it are free or memory can grow: whether it was.
    pub fn extend(self: *Pages, start: u32, count: u32, wanted: u32) bool {
        const end = start + count;
        const reach = @min(start + wanted, self.chunks);
        var at = end;
        while (at < reach) : (at += 1) {
            if (!self.isFree(at)) {
                return false;
            }
        }

        if (start + wanted > self.chunks and !self.grow(start + wanted - self.chunks)) {
            return false;
        }

        self.mark(end, wanted - count, false);
        self.used += wanted - count;
        return true;
    }

    pub fn release(self: *Pages, start: u32, count: u32) void {
        if (poison) {
            const at: [*]u8 = @ptrFromInt(self.address(start));
            @memset(at[0 .. @as(usize, count) * chunk_size], poison_byte);
        }

        self.mark(start, count, true);
        self.used -= count;
    }

    /// Runs first-fit from below, as domains and the global arena take them.
    pub fn allocator(self: *Pages) Allocator {
        return .{ .ptr = self, .vtable = &low_vtable };
    }

    /// Runs from the top, as the call arena takes them.
    pub fn topAllocator(self: *Pages) Allocator {
        return .{ .ptr = self, .vtable = &top_vtable };
    }

    const low_vtable: Allocator.VTable = .{ .alloc = allocLow, .resize = resize, .remap = remap, .free = freeRun };
    const top_vtable: Allocator.VTable = .{ .alloc = allocTop, .resize = resize, .remap = remap, .free = freeRun };

    fn chunksFor(len: usize) ?u32 {
        const count = std.math.divCeil(usize, len, chunk_size) catch unreachable;
        return if (count > max_chunks) null else @intCast(count);
    }

    fn allocRun(ctx: *anyopaque, len: usize, alignment: Alignment, top: bool) ?[*]u8 {
        const self: *Pages = @ptrCast(@alignCast(ctx));
        if (alignment.toByteUnits() > chunk_size) {
            return null;
        }

        const start = self.take(chunksFor(len) orelse return null, top) orelse return null;
        return @ptrFromInt(self.address(start));
    }

    fn allocLow(ctx: *anyopaque, len: usize, alignment: Alignment, _: usize) ?[*]u8 {
        return allocRun(ctx, len, alignment, false);
    }

    fn allocTop(ctx: *anyopaque, len: usize, alignment: Alignment, _: usize) ?[*]u8 {
        return allocRun(ctx, len, alignment, true);
    }

    fn resize(ctx: *anyopaque, memory: []u8, _: Alignment, new_len: usize, _: usize) bool {
        const self: *Pages = @ptrCast(@alignCast(ctx));
        const count = chunksFor(memory.len).?;
        const wanted = chunksFor(new_len) orelse return false;
        const start = self.chunkOf(memory.ptr);
        if (wanted < count) {
            self.release(start + wanted, count - wanted);
            return true;
        }

        return wanted == count or self.extend(start, count, wanted);
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ra: usize) ?[*]u8 {
        return if (resize(ctx, memory, alignment, new_len, ra)) memory.ptr else null;
    }

    fn freeRun(ctx: *anyopaque, memory: []u8, _: Alignment, _: usize) void {
        const self: *Pages = @ptrCast(@alignCast(ctx));
        self.release(self.chunkOf(memory.ptr), chunksFor(memory.len).?);
    }
};

/// How many free chunks a run taken from the top leaves below it, for the
/// runs domains take during a call (docs/zig-codegen.md, section 2).
pub var reserve: u32 = 0;
/// How many runs were taken from the top, for measuring the reserve.
pub var top_runs: u32 = 0;

/// A bump arena over runs taken from `source`, each run's first bytes its
/// header. The last allocation grows and shrinks in place, past its run's
/// end where the chunks after it are free; the others wait for the arena
/// to be reset, restored or freed whole.
pub const Arena = struct {
    source: Allocator,
    /// The run allocations come from, which links to the older ones.
    newest: ?*Run = null,
    /// Where the next allocation goes, and where the newest run ends.
    top: usize = 0,
    end: usize = 0,
    /// The start of the last allocation.
    last: usize = 0,

    const Run = struct {
        older: ?*Run,
        /// The run's bytes, its header's included: whole chunks.
        len: usize,

        fn bytes(run: *Run) []u8 {
            const at: [*]u8 = @ptrCast(run);
            return at[0..run.len];
        }
    };

    const header = std.mem.alignForward(usize, @sizeOf(Run), 16);
    /// The largest a run may be, whole chunks short of wasm32's 4 GiB.
    const largest_run: usize = std.math.maxInt(u32) - chunk_size;
    const run_alignment: Alignment = .@"16";

    pub fn init(source: Allocator) Arena {
        return .{ .source = source };
    }

    /// Everything given back to the source.
    pub fn reset(self: *Arena) void {
        while (self.newest) |run| {
            self.newest = run.older;
            self.source.rawFree(run.bytes(), run_alignment, @returnAddress());
        }

        self.top = 0;
        self.end = 0;
        self.last = 0;
    }

    pub const deinit = reset;

    /// Where the arena is, to restore it to: valid until it is reset, or
    /// restored to an earlier mark. Restoring a mark no longer valid is a
    /// bug, which panics: its run is not among the arena's.
    pub const Mark = struct {
        run: ?*Run,
        run_len: usize,
        top: usize,
        last: usize,
    };

    pub fn mark(self: *const Arena) Mark {
        return .{
            .run = self.newest,
            .run_len = if (self.newest) |run| run.len else 0,
            .top = self.top,
            .last = self.last,
        };
    }

    /// Everything allocated since `saved` given back, as a link that fails rolls back.
    pub fn restore(self: *Arena, saved: Mark) void {
        while (self.newest != saved.run) {
            const run = self.newest orelse @panic("an arena restored to a mark no longer valid");
            self.newest = run.older;
            self.source.rawFree(run.bytes(), run_alignment, @returnAddress());
        }

        const run = saved.run orelse {
            self.top = 0;
            self.end = 0;
            self.last = 0;
            return;
        };
        if (run.len > saved.run_len and self.source.rawResize(run.bytes(), run_alignment, saved.run_len, @returnAddress())) {
            run.len = saved.run_len;
        }

        self.end = @intFromPtr(run) + run.len;
        self.top = saved.top;
        self.last = saved.last;
        if (poison) {
            const at: [*]u8 = @ptrFromInt(self.top);
            @memset(at[0 .. self.end - self.top], poison_byte);
        }
    }

    pub fn allocator(self: *Arena) Allocator {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: Allocator.VTable = .{ .alloc = alloc, .resize = resize, .remap = remap, .free = free };

    /// The newest run grown in place to reach `to`: whether it could be.
    fn reach(self: *Arena, to: usize) bool {
        const run = self.newest orelse return false;
        const len = to - @intFromPtr(run);
        if (len > largest_run) {
            return false;
        }

        const wanted = std.mem.alignForward(usize, len, chunk_size);
        if (!self.source.rawResize(run.bytes(), run_alignment, wanted, @returnAddress())) {
            return false;
        }

        run.len = wanted;
        self.end = @intFromPtr(run) + wanted;
        return true;
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: Alignment, _: usize) ?[*]u8 {
        const self: *Arena = @ptrCast(@alignCast(ctx));
        const start = placed: {
            if (self.newest != null) {
                const start = alignment.forward(self.top);
                const to = std.math.add(usize, start, len) catch return null;
                if (to <= self.end or self.reach(to)) {
                    break :placed start;
                }
            }

            const size = std.math.add(usize, header + alignment.toByteUnits(), len) catch return null;
            if (size > largest_run) {
                return null;
            }

            // The old run's whole chunks past its last allocation go back, for any run to take.
            if (self.newest) |old| {
                const used = std.mem.alignForward(usize, self.top - @intFromPtr(old), chunk_size);
                if (used < old.len and self.source.rawResize(old.bytes(), run_alignment, used, @returnAddress())) {
                    old.len = used;
                    self.end = @intFromPtr(old) + used;
                }
            }

            const run_len = std.mem.alignForward(usize, size, chunk_size);
            const bytes = self.source.rawAlloc(run_len, run_alignment, @returnAddress()) orelse return null;

            const run: *Run = @ptrCast(@alignCast(bytes));
            run.* = .{ .older = self.newest, .len = run_len };
            self.newest = run;
            self.end = @intFromPtr(bytes) + run.len;
            break :placed alignment.forward(@intFromPtr(bytes) + header);
        };
        self.last = start;
        self.top = start + len;
        return @ptrFromInt(start);
    }

    fn resize(ctx: *anyopaque, memory: []u8, _: Alignment, new_len: usize, _: usize) bool {
        const self: *Arena = @ptrCast(@alignCast(ctx));
        const start = @intFromPtr(memory.ptr);
        if (start != self.last or self.newest == null) {
            return new_len <= memory.len;
        }

        const to = std.math.add(usize, start, new_len) catch return false;
        if (to > self.end and !self.reach(to)) {
            return false;
        }

        if (poison and new_len < memory.len) {
            @memset(memory[new_len..], poison_byte);
        }

        self.top = start + new_len;
        return true;
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: Alignment, new_len: usize, ra: usize) ?[*]u8 {
        return if (resize(ctx, memory, alignment, new_len, ra)) memory.ptr else null;
    }

    /// Only the last allocation is given back at once.
    fn free(ctx: *anyopaque, memory: []u8, _: Alignment, _: usize) void {
        const self: *Arena = @ptrCast(@alignCast(ctx));
        if (@intFromPtr(memory.ptr) == self.last and self.newest != null) {
            if (poison) {
                @memset(memory, poison_byte);
            }

            self.top = self.last;
        }
    }
};

/// `count` items, zero: what AssemblyScript's `new StaticArray<T>(count)` gave.
pub fn allocZeroed(gpa: Allocator, comptime T: type, count: u32) Allocator.Error![]T {
    const items = try gpa.alloc(T, count);
    @memset(std.mem.sliceAsBytes(items), 0);
    return items;
}

/// A table whose rows never move: shelves that double from a few rows up
/// to a chunk's worth of rows, then shelves of that many each (a run of
/// two chunks, with its arena run's header, where a shelf is the only
/// thing in its run). Grown in a bump arena,
/// it leaves no old copy behind but its directory of shelves, a pointer a
/// shelf; a link that fails rolls it back with `restore`, after its arena.
pub fn Rows(comptime T: type) type {
    return struct {
        const Self = @This();

        /// Rows a full shelf holds: a chunk's worth of bytes, rounded down to a power of two.
        const full: u32 = std.math.floorPowerOfTwo(u32, @max(1, chunk_size / @sizeOf(T)));
        const first: u32 = @min(full, 8);
        /// How many shelves double, and the rows they hold together.
        const doubling: u5 = std.math.log2_int(u32, full / first);
        const in_doubling: u32 = full - first;

        directory: [*][*]T = undefined,
        capacity: u32 = 0,
        shelves: u32 = 0,
        len: u32 = 0,

        pub const State = struct {
            directory: [*][*]T,
            capacity: u32,
            shelves: u32,
            len: u32,
        };

        fn shelfSize(shelf: u32) u32 {
            return if (shelf < doubling) first << @intCast(shelf) else full;
        }

        pub inline fn at(self: *const Self, index: u32) *T {
            std.debug.assert(index < self.len);
            if (index < in_doubling) {
                const shelf = std.math.log2_int(u32, index / first + 1);
                return &self.directory[shelf][index + first - (first << shelf)];
            }

            const past = index - in_doubling;
            return &self.directory[doubling + past / full][past % full];
        }

        pub inline fn get(self: *const Self, index: u32) T {
            return self.at(index).*;
        }

        pub inline fn set(self: *const Self, index: u32, row: T) void {
            self.at(index).* = row;
        }

        /// `row` at the end.
        pub fn push(self: *Self, gpa: Allocator, row: T) Allocator.Error!void {
            (try self.addOne(gpa)).* = row;
        }

        /// The rows from `count` on forgotten, their shelves kept: as
        /// AssemblyScript's `length = count`, never a longer table.
        pub fn truncate(self: *Self, count: u32) void {
            std.debug.assert(count <= self.len);
            self.len = count;
        }

        /// A new row at the end, undefined.
        pub fn addOne(self: *Self, gpa: Allocator) Allocator.Error!*T {
            const room = if (self.shelves <= doubling) first * ((@as(u32, 1) << @intCast(self.shelves)) - 1) else in_doubling + (self.shelves - doubling) * full;
            if (self.len == room) {
                if (self.shelves == self.capacity) {
                    // The old directory stays where it is: a state saved before still names it.
                    const capacity = @max(8, self.capacity * 2);
                    const directory = try gpa.alloc([*]T, capacity);
                    @memcpy(directory[0..self.shelves], self.directory[0..self.shelves]);
                    self.directory = directory.ptr;
                    self.capacity = capacity;
                }

                self.directory[self.shelves] = (try gpa.alloc(T, shelfSize(self.shelves))).ptr;
                self.shelves += 1;
            }

            self.len += 1;
            return self.at(self.len - 1);
        }

        pub fn addOneZeroed(self: *Self, gpa: Allocator) Allocator.Error!*T {
            const row = try self.addOne(gpa);
            @memset(std.mem.asBytes(row), 0);
            return row;
        }

        /// `row` at the end: its index.
        pub fn append(self: *Self, gpa: Allocator, row: T) Allocator.Error!u32 {
            (try self.addOne(gpa)).* = row;
            return self.len - 1;
        }

        /// No rows, the shelves kept for the rows that come next.
        pub fn clearRetainingCapacity(self: *Self) void {
            self.len = 0;
        }

        /// The shelves and the directory given back, as an arena takes them:
        /// the directories it outgrew stay, for a state saved before.
        pub fn deinit(self: *Self, gpa: Allocator) void {
            for (0..self.shelves) |shelf| {
                gpa.free(self.directory[shelf][0..shelfSize(@intCast(shelf))]);
            }

            if (self.capacity > 0) {
                gpa.free(self.directory[0..self.capacity]);
            }

            self.* = .{};
        }

        pub fn save(self: *const Self) State {
            return .{ .directory = self.directory, .capacity = self.capacity, .shelves = self.shelves, .len = self.len };
        }

        pub fn restore(self: *Self, state: State) void {
            self.directory = state.directory;
            self.capacity = state.capacity;
            self.shelves = state.shelves;
            self.len = state.len;
        }
    };
}

extern const __heap_base: u8;

/// The module's pages: on wasm its memory; natively, for the tests of
/// what uses the arenas below, a region reserved once.
var module_bits: [max_chunks / 64]u64 = @splat(0);
var pages_state: ?Pages = null;

pub fn pages() *Pages {
    if (pages_state == null) {
        if (wasm) {
            pages_state = Pages.ofModule(&module_bits);
        } else {
            const region = std.heap.page_allocator.alignedAlloc(u8, .fromByteUnits(chunk_size), 256 << 20) catch @panic("cannot reserve memory");
            pages_state = Pages.ofRegion(region, &module_bits);
        }
    }

    return &pages_state.?;
}

/// The module's pages replaced by `other`, for a test that runs the exports
/// over pages of its own; the replaced ones returned, to put back. The
/// arenas must hold nothing then, since they name the pages by address.
pub fn swapPages(other: Pages) Pages {
    const old = pages().*;
    pages_state = other;
    return old;
}

fn moduleAllocator(top: bool) Allocator {
    return if (top) pages().topAllocator() else pages().allocator();
}

/// The call's arena, reset as each call starts.
pub var call: Arena = undefined;
/// What outlives domains.
pub var global: Arena = undefined;
var arenas_ready = false;

pub fn arenasReady() bool {
    return arenas_ready;
}

/// The arenas over the module's pages, made the first time.
pub fn arenas() void {
    if (!arenas_ready) {
        call = .init(moduleAllocator(true));
        global = .init(moduleAllocator(false));
        arenas_ready = true;
    }
}

const testing = std.testing;

/// Pages over a region of their own, as the module's memory but smaller, for tests.
pub const TestPages = struct {
    region: []align(chunk_size) u8,
    bits: []u64,
    pages: Pages,

    pub fn init(len: usize) !*TestPages {
        const self = try testing.allocator.create(TestPages);
        self.region = try std.heap.page_allocator.alignedAlloc(u8, .fromByteUnits(chunk_size), len);
        self.bits = try testing.allocator.alloc(u64, len / chunk_size / 64 + 1);
        self.pages = .ofRegion(self.region, self.bits);
        return self;
    }

    pub fn deinit(self: *TestPages) void {
        std.heap.page_allocator.free(self.region);
        testing.allocator.free(self.bits);
        testing.allocator.destroy(self);
    }
};

test "memory grows by what a run needs, a wasm page at a time, never by doubling" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    const p = &t.pages;

    try testing.expectEqual(0, p.take(1, false));
    try testing.expectEqual(grow_chunks, p.chunks);
    try testing.expectEqual(1, p.take(3, false));
    try testing.expectEqual(grow_chunks, p.chunks);
    const big = p.take(100, false).?;
    try testing.expectEqual(4, big);
    try testing.expectEqual(104, p.chunks);
    try testing.expectEqual(104, p.used);
}

test "freed chunks are one run again and serve any later run, whoever freed them" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    const p = &t.pages;

    const a = p.take(2, false).?;
    const b = p.take(3, false).?;
    const c = p.take(1, false).?;
    const reached = p.chunks;
    p.release(a, 2);
    p.release(b, 3);
    try testing.expectEqual(a, p.take(5, false));
    try testing.expectEqual(reached, p.chunks);
    try testing.expect(c == 5);
}

test "a run from the top is past every chunk in use, and grows in place" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    const p = &t.pages;

    const low = p.take(1, false).?;
    const hole = p.take(1, false).?;
    const kept = p.take(1, false).?;
    p.release(hole, 1);
    const top = p.take(1, true).?;
    try testing.expect(top > kept and top > low);
    try testing.expect(p.extend(top, 1, 40));
    try testing.expectEqual(std.mem.alignForward(u32, top + 40, grow_chunks), p.chunks);
    // The hole below goes to the next run from below.
    try testing.expectEqual(hole, p.take(1, false));
    try testing.expect(!p.extend(low, 1, 2));
}

test "memory never grows past its limit" {
    const t = try TestPages.init(1 << 20);
    defer t.deinit();
    const p = &t.pages;

    try testing.expectEqual(null, p.take(65, false));
    const all = p.take(64, false).?;
    try testing.expectEqual(null, p.take(1, true));
    p.release(all, 64);
    try testing.expectEqual(0, p.used);
}

test "no run ends past the last whole chunk below 4 GiB" {
    inline for (.{ 1 << 20, (1 << 20) + 34 * 1024 * 1024 }) |heap| {
        const base = std.mem.alignForward(u64, heap, chunk_size);
        const limit = Pages.moduleLimit(base);
        try testing.expectEqual((1 << 32) - @as(u64, chunk_size), base + @as(u64, limit) * chunk_size);
    }
}

test "the arena's last allocation grows in place at the top, past its first run" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.topAllocator());
    defer arena.deinit();
    const gpa = arena.allocator();

    var list: std.ArrayList(u32) = .empty;
    for (0..100_000) |i| {
        try list.append(gpa, @intCast(i));
    }

    // One run throughout: nothing was left behind it.
    try testing.expectEqual(null, arena.newest.?.older);
    try testing.expectEqual(@intFromPtr(list.items.ptr) + list.capacity * 4, arena.top);
    try testing.expectEqual(std.math.divCeil(u32, @intCast(arena.end - @intFromPtr(arena.newest.?)), chunk_size), t.pages.used);
    arena.reset();
    try testing.expectEqual(0, t.pages.used);
}

test "an arena restored to a mark gives back every chunk taken since" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.allocator());
    defer arena.deinit();
    const gpa = arena.allocator();

    const kept = try gpa.dupe(u8, "kept");
    const used = t.pages.used;
    const saved = arena.mark();
    _ = try gpa.alloc(u8, 3 * chunk_size);
    var list: std.ArrayList(u8) = .empty;
    try list.appendNTimes(gpa, 7, 5 * chunk_size);
    arena.restore(saved);
    try testing.expectEqual(used, t.pages.used);
    try testing.expectEqualStrings("kept", kept);
    try testing.expectEqualStrings("next", try gpa.dupe(u8, "next"));
}

test "a domain rebuilt into a new arena and freed whole keeps memory where it was" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var domain = Arena.init(t.pages.allocator());
    var rows: Rows(u64) = .{};
    for (0..50_000) |i| {
        _ = try rows.append(domain.allocator(), i);
    }

    var reached: u32 = 0;
    for (0..5) |cycle| {
        var next = Arena.init(t.pages.allocator());
        var copy: Rows(u64) = .{};
        for (0..rows.len) |i| {
            _ = try copy.append(next.allocator(), rows.at(@intCast(i)).*);
        }

        domain.deinit();
        domain = next;
        rows = copy;
        if (cycle == 1) {
            reached = t.pages.chunks;
        } else if (cycle > 1) {
            try testing.expectEqual(reached, t.pages.chunks);
        }
    }

    try testing.expectEqual(49_999, rows.at(49_999).*);
    domain.deinit();
    try testing.expectEqual(0, t.pages.used);
}

test "rows never move as the table grows, and each lands where at() finds it" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.allocator());
    defer arena.deinit();

    inline for (.{ u8, u32, [3]u32, [5000]u8, [20000]u8 }) |T| {
        var rows: Rows(T) = .{};
        const first = try rows.addOne(arena.allocator());
        const count: u32 = if (@sizeOf(T) > 1000) 40 else 70_000;
        for (1..count) |_| {
            _ = try rows.addOne(arena.allocator());
        }

        try testing.expectEqual(first, rows.at(0));
        // Every row its own bytes: no two indices share one.
        if (@sizeOf(T) <= 12) {
            for (0..count) |i| {
                @memset(std.mem.asBytes(rows.at(@intCast(i))), @truncate(i));
            }

            for (0..count) |i| {
                try testing.expectEqual(@as(u8, @truncate(i)), std.mem.asBytes(rows.at(@intCast(i)))[0]);
            }
        }
    }
}

test "freed memory is poisoned in the poison build" {
    if (!poison) {
        return error.SkipZigTest;
    }

    const t = try TestPages.init(4 << 20);
    defer t.deinit();
    var arena: Arena = .init(t.pages.allocator());
    const bytes = try arena.allocator().alloc(u8, 100);
    @memset(bytes, 0);
    const saved = arena.mark();
    const later = try arena.allocator().alloc(u8, 100);
    @memset(later, 1);
    arena.restore(saved);
    try testing.expectEqual(poison_byte, later[0]);
    arena.deinit();
    try testing.expectEqual(poison_byte, bytes[0]);
}

/// Tables as a domain's will be: rows added to several by one entry, all
/// or none, and a scratch buffer grown in place meanwhile.
const TestDomain = struct {
    names: Rows(u32) = .{},
    pairs: Rows([2]u64) = .{},

    fn add(self: *TestDomain, arena: *Arena, count: u32, seed: u32) Allocator.Error!void {
        const saved = arena.mark();
        const names = self.names.save();
        const pairs = self.pairs.save();
        errdefer {
            arena.restore(saved);
            self.names.restore(names);
            self.pairs.restore(pairs);
        }

        const gpa = arena.allocator();
        var scratch: std.ArrayList(u8) = .empty;
        for (0..count) |i| {
            _ = try self.names.append(gpa, seed +% @as(u32, @intCast(i)));
            (try self.pairs.addOne(gpa)).* = .{ i, seed };
            try scratch.appendNTimes(gpa, @truncate(i), 1000);
        }
    }

    fn check(self: *const TestDomain, entries: []const [2]u32) !void {
        var row: u32 = 0;
        for (entries) |entry| {
            for (0..entry[0]) |i| {
                try testing.expectEqual(entry[1] +% @as(u32, @intCast(i)), self.names.at(row).*);
                try testing.expectEqual([2]u64{ i, entry[1] }, self.pairs.at(row).*);
                row += 1;
            }
        }

        try testing.expectEqual(row, self.names.len);
        try testing.expectEqual(row, self.pairs.len);
    }
};

const test_entries = [_][2]u32{ .{ 3, 10 }, .{ 900, 20 }, .{ 1, 30 }, .{ 5000, 40 }, .{ 40, 50 } };

/// Entries added one after another, as domainAdd adds ABCs: one that runs
/// out of memory leaves the domain, and its memory, as they were before it.
fn addEntries(source: Allocator, p: *Pages) !void {
    var arena: Arena = .init(source);
    defer arena.deinit();
    var domain: TestDomain = .{};
    for (test_entries, 0..) |entry, done| {
        const used = p.used;
        domain.add(&arena, entry[0], entry[1]) catch |err| {
            // Fewer where a run before the entry gave back what it did not use.
            try testing.expect(p.used <= used);
            try domain.check(test_entries[0..done]);
            return err;
        };
    }

    try domain.check(&test_entries);
}

test "every run an entry takes may fail, and leaves the domain as it was, its memory no larger" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    try testing.checkAllAllocationFailures(t.pages.allocator(), addEntries, .{&t.pages});
    try testing.expectEqual(0, t.pages.used);
}

/// Memory of every size from one wasm page to 120, so that memory runs
/// out at every point of the entries: where a run can neither grow in
/// place nor be taken, as when memory.grow fails. Each entry a later stage
/// ports, which changes a domain, is held to this as `addEntries` is.
pub fn atEveryMemorySize(comptime entries: fn (Allocator, *Pages) anyerror!void) !void {
    var ran_out: u32 = 0;
    for (1..121) |size| {
        const t = try TestPages.init(size * std.wasm.page_size);
        defer t.deinit();
        entries(t.pages.allocator(), &t.pages) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            ran_out += 1;
        };
        try testing.expectEqual(0, t.pages.used);
    }

    try testing.expect(ran_out > 0);
}

test "entries that run out of memory anywhere, a run neither grown nor taken, roll back" {
    try atEveryMemorySize(addEntries);
}

test "a run that cannot grow in place is replaced by a new one, with the same rows" {
    const t = try TestPages.init(64 << 20);
    defer t.deinit();
    var count = std.testing.FailingAllocator.init(t.pages.allocator(), .{});
    try addEntries(count.allocator(), &t.pages);
    for (0..count.resize_index + 1) |index| {
        var failing = std.testing.FailingAllocator.init(t.pages.allocator(), .{ .resize_fail_index = index });
        try addEntries(failing.allocator(), &t.pages);
        try testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    }

    try testing.expectEqual(0, t.pages.used);
}
