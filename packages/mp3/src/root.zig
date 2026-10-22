// minimp3 for wasm32-freestanding, behind the calls src/index.ts makes. The
// host writes a whole frame at input(), calls decode() and reads the PCM at
// output(). Every buffer is static, so memory never grows; minimp3 is
// compiled unchanged beside this file. Its memcpy, memset and memmove are
// clang's builtins by include/string.h, so they become bulk memory
// instructions and none of compiler-rt's is linked.
const std = @import("std");
// minimp3.h, as build.zig translates it.
const c = @import("c");

pub const panic = std.debug.no_panic;

// Zeroed, as mp3dec_init would leave it: no frame decoded yet.
var decoder: c.mp3dec_t = std.mem.zeroes(c.mp3dec_t);
var info: c.mp3dec_frame_info_t = std.mem.zeroes(c.mp3dec_frame_info_t);
// The largest frame Flash plays, free format included, fits.
var encoded: [4096]u8 = undefined;
var pcm: [c.MINIMP3_MAX_SAMPLES_PER_FRAME]f32 = undefined;

export fn input() [*]u8 {
    return &encoded;
}

export fn output() [*]f32 {
    return &pcm;
}

/// The samples per channel of the frame of `length` bytes at input(), 0 for
/// none; its bit reservoir and synthesis state carry over to the next.
export fn decode(length: i32) i32 {
    if (length < 0 or length > encoded.len) {
        return 0;
    }

    return c.mp3dec_decode_frame(&decoder, &encoded, length, &pcm, &info);
}

export fn channels() i32 {
    return info.channels;
}

export fn rate() i32 {
    return info.hz;
}
