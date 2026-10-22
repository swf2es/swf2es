// zlib and the LZMA SDK for wasm32-freestanding, behind the few calls
// src/index.ts makes. Each call works in a bump arena that the host resets
// first; outputs grow in place at the arena's top, so a buffer of unknown
// size is never copied as it grows. The C libraries are compiled unchanged
// beside this file; memcpy and the rest of what they call come from Zig's
// compiler-rt, and their allocations from the arena, through callbacks.
const std = @import("std");
// zlib.h, LzmaEnc.h and LzmaDec.h, as build.zig translates them.
const c = @import("c");

pub const panic = std.debug.no_panic;

const page = 65536;

// Statuses; a call returns one, and its output is at resultPointer().
const DONE = 0;
const FULL = 1;
const CORRUPT = -1;
const TRUNCATED = -2;
const NO_MEMORY = -3;
const DICTIONARY = -4;

var base: usize = 0;
var top: usize = 0;
var last: usize = 0;

var result: usize = 0;
var result_length: usize = 0;
var consumed: usize = 0;
var message: ?[*:0]const u8 = null;

/// Memory up to `end`, grown if need be.
fn reserve(end: u64) bool {
    const have: u64 = @as(u64, @wasmMemorySize(0)) * page;
    if (end <= have) {
        return true;
    }

    if (end > 0xffff_0000) {
        return false;
    }

    return @wasmMemoryGrow(0, @intCast((end - have + page - 1) / page)) >= 0;
}

/// Forget everything allocated; memory is kept for the next call.
export fn reset() void {
    // The arena starts where memory first ended, past the data and the stack.
    if (base == 0) {
        base = @wasmMemorySize(0) * page;
    }

    top = base;
    last = 0;
    result = 0;
    result_length = 0;
    consumed = 0;
    message = null;
}

/// `n` bytes, 16-aligned, growing memory as needed; 0 when it cannot.
export fn alloc(n: usize) usize {
    if (base == 0) {
        reset();
    }

    const start = std.mem.alignForward(u64, top, 16);
    if (!reserve(start + n)) {
        return 0;
    }

    last = @intCast(start);
    top = @intCast(start + n);
    return last;
}

/// The arena's top allocation, made `n` bytes long where it is.
fn extend(p: usize, n: usize) bool {
    if (p != last or !reserve(@as(u64, last) + n)) {
        return false;
    }

    top = last + n;
    return true;
}

export fn resultPointer() usize {
    return result;
}

export fn resultSize() usize {
    return result_length;
}

export fn inputUsed() usize {
    return consumed;
}

export fn errorMessage() usize {
    return if (message) |m| @intFromPtr(m) else 0;
}

fn finish(out: usize, length: usize, used: usize, status: i32) i32 {
    result = out;
    result_length = length;
    consumed = used;
    return status;
}

// Saturating: a product past 4 GB fails in alloc as NO_MEMORY.
fn zalloc(_: c.voidpf, items: c.uInt, size: c.uInt) callconv(.c) c.voidpf {
    return @ptrFromInt(alloc(@as(usize, items) *| size));
}

fn zfree(_: c.voidpf, _: c.voidpf) callconv(.c) void {}

// What zlib allocates once its stream has begun: inflate's window, which
// updatewindow asks for at the end of the first inflate() call that wrote
// output (short of Z_FINISH). Reserved below the output so the output stays
// at the arena's top.
var window: usize = 0;

fn windowAlloc(_: c.voidpf, items: c.uInt, size: c.uInt) callconv(.c) c.voidpf {
    if (window != 0 and @as(usize, items) *| size <= 1 << 15) {
        const p = window;
        window = 0;
        return @ptrFromInt(p);
    }

    return null;
}

/// Inflate `length` bytes at `input`, zlib's (`window_bits` 15) or raw
/// (-15), into at most `limit` bytes: DONE at the stream's end, FULL if the
/// limit came first.
export fn inflateData(input: usize, length: usize, window_bits: c_int, limit: usize) i32 {
    var s = std.mem.zeroes(c.z_stream);
    s.zalloc = zalloc;
    s.zfree = zfree;
    if (c.inflateInit2_(&s, window_bits, c.ZLIB_VERSION, @sizeOf(c.z_stream)) != c.Z_OK) {
        return NO_MEMORY;
    }

    window = alloc(1 << 15);
    s.zalloc = windowAlloc;
    // A first guess of four times the input, between 64 KB and 16 MB, then
    // doubling: a large input need not reserve memory its output never uses.
    var capacity: usize = @min(limit, std.math.clamp(length *| 4, 65536, 16 << 20));
    const out = alloc(capacity);
    if (window == 0 or out == 0) {
        return NO_MEMORY;
    }

    s.next_in = @ptrFromInt(input);
    s.avail_in = @intCast(length);
    s.next_out = @ptrFromInt(out);
    s.avail_out = @intCast(capacity);
    var status: i32 = undefined;
    while (true) {
        const z = c.inflate(&s, c.Z_NO_FLUSH);
        const written = @intFromPtr(s.next_out) - out;
        if (z == c.Z_STREAM_END) {
            status = DONE;
            break;
        }

        if (z == c.Z_NEED_DICT) {
            status = DICTIONARY;
            break;
        }

        if (z == c.Z_DATA_ERROR) {
            message = s.msg;
            status = CORRUPT;
            break;
        }

        if (z == c.Z_MEM_ERROR) {
            status = NO_MEMORY;
            break;
        }

        if (s.avail_out != 0) {
            // Every byte read, and the stream not ended.
            status = TRUNCATED;
            break;
        }

        if (written == limit) {
            status = FULL;
            break;
        }

        const grown = if (capacity > limit / 2) limit else capacity * 2;
        if (!extend(out, grown)) {
            status = NO_MEMORY;
            break;
        }

        s.next_out = @ptrFromInt(out + written);
        s.avail_out = @intCast(grown - written);
        capacity = grown;
    }

    return finish(out, @intFromPtr(s.next_out) - out, @intFromPtr(s.next_in) - input, status);
}

/// Deflate `length` bytes at `input` at `level`, as a zlib stream
/// (`window_bits` 15) or a raw one (-15).
export fn deflateData(input: usize, length: usize, level: c_int, window_bits: c_int) i32 {
    var s = std.mem.zeroes(c.z_stream);
    s.zalloc = zalloc;
    s.zfree = zfree;
    if (c.deflateInit2_(&s, level, c.Z_DEFLATED, window_bits, 8, c.Z_DEFAULT_STRATEGY, c.ZLIB_VERSION, @sizeOf(c.z_stream)) != c.Z_OK) {
        return NO_MEMORY;
    }

    const bound: usize = c.deflateBound(&s, @intCast(length));
    const out = alloc(bound);
    if (out == 0) {
        return NO_MEMORY;
    }

    s.next_in = @ptrFromInt(input);
    s.avail_in = @intCast(length);
    s.next_out = @ptrFromInt(out);
    s.avail_out = @intCast(bound);
    if (c.deflate(&s, c.Z_FINISH) != c.Z_STREAM_END) {
        return NO_MEMORY;
    }

    return finish(out, @intFromPtr(s.next_out) - out, length, DONE);
}

fn szAlloc(_: c.ISzAllocPtr, size: usize) callconv(.c) ?*anyopaque {
    return @ptrFromInt(alloc(size));
}

fn szFree(_: c.ISzAllocPtr, _: ?*anyopaque) callconv(.c) void {}

const arena: c.ISzAlloc = .{ .Alloc = szAlloc, .Free = szFree };

/// Decode the LZMA stream of `length` bytes at `input`, its 5 property bytes
/// at `properties`, to `size` bytes, or fewer if its end marker comes first:
/// DONE either way, TRUNCATED if the input ends first. As LzmaDec reads a
/// whole stream: properties past 224 and a first byte not 0 are corrupt, a
/// dictionary is at least 4 KB, and a distance past it or the output is
/// corrupt.
export fn lzmaDecode(properties: usize, input: usize, length: usize, size: usize) i32 {
    var d: c.CLzmaDec = undefined;
    d.dic = null;
    d.probs = null;
    const r = c.LzmaDec_AllocateProbs(&d, @ptrFromInt(properties), c.LZMA_PROPS_SIZE, &arena);
    if (r != c.SZ_OK) {
        return if (r == c.SZ_ERROR_MEM) NO_MEMORY else CORRUPT;
    }

    // The dictionary is the whole output, never wrapped, and the arena's top
    // allocation: growing it moves nothing.
    var capacity: usize = @min(size, 65536);
    const out = alloc(capacity);
    if (out == 0) {
        return NO_MEMORY;
    }

    d.dic = @ptrFromInt(out);
    d.dicBufSize = capacity;
    c.LzmaDec_Init(&d);
    var at: usize = 0;
    var status: i32 = DONE;
    while (true) {
        var in: usize = length - at;
        var s: c.ELzmaStatus = undefined;
        const step = c.LzmaDec_DecodeToDic(&d, capacity, @ptrFromInt(input + at), &in, c.LZMA_FINISH_ANY, &s);
        at += in;
        if (step != c.SZ_OK) {
            status = CORRUPT;
            break;
        }

        if (s == c.LZMA_STATUS_FINISHED_WITH_MARK or d.dicPos == size) {
            break;
        }

        if (s == c.LZMA_STATUS_NEEDS_MORE_INPUT) {
            status = TRUNCATED;
            break;
        }

        const grown = if (capacity > size / 2) size else capacity * 2;
        if (!extend(out, grown)) {
            status = NO_MEMORY;
            break;
        }

        d.dicBufSize = grown;
        capacity = grown;
    }

    return finish(out, d.dicPos, at, status);
}

/// `length` bytes at `input` as ByteArray's LZMA, as avmplus' ByteArray
/// writes it: 5 property bytes, the length in 8 bytes, and the stream,
/// encoded at level 9 with a 1 MB dictionary, or one no larger than the
/// input needs.
export fn lzmaEncode(input: usize, length: usize) i32 {
    var props: c.CLzmaEncProps = undefined;
    c.LzmaEncProps_Init(&props);
    props.level = 9;
    props.dictSize = 1 << 20;
    // A smaller input, a smaller dictionary: the match finder's tables, some
    // 12 times the dictionary, are allocated and cleared for every call.
    props.reduceSize = length;
    props.numThreads = 1;
    // Never more than the input and a little: what does not compress is stored
    // as literals. Saturating, so a length near 4 GB fails in alloc.
    const bound = length +| length / 3 +| 256;
    const header: usize = c.LZMA_PROPS_SIZE + 8;
    const out = alloc(header +| bound);
    if (out == 0) {
        return NO_MEMORY;
    }

    var props_size: usize = c.LZMA_PROPS_SIZE;
    var written: usize = bound;
    const bytes: [*]u8 = @ptrFromInt(out);
    const r = c.LzmaEncode(bytes + header, &written, @ptrFromInt(input), length, &props, bytes, &props_size, 0, null, &arena, &arena);
    if (r != c.SZ_OK) {
        return NO_MEMORY;
    }

    std.mem.writeInt(u64, bytes[c.LZMA_PROPS_SIZE..][0..8], length, .little);
    return finish(out, header + written, length, DONE);
}
