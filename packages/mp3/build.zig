// The MP3 decoder: src/root.zig and minimp3 compiled together to
// wasm32-freestanding, into zig-out/bin/mp3.wasm. build.ts runs this with
// the pinned Zig and checks the result in as base64.
const std = @import("std");

/// Defines for the C and for the header translated for root.zig alike, so
/// that no define can change a type on one side only: MP3 alone, scalar
/// code, and float samples (mp3d_sample_t is float only with the last).
const defines = [_][]const u8{ "MINIMP3_ONLY_MP3", "MINIMP3_NO_SIMD", "MINIMP3_FLOAT_OUTPUT" };

/// What the module exports beside its memory; it imports nothing.
const exports = [_][]const u8{ "input", "output", "decode", "channels", "rate" };

/// The whole memory, fixed: a frame's bytes and PCM never grow it.
const memory = 128 * 1024;

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        .cpu_features_add = std.Target.wasm.featureSet(&.{.bulk_memory}),
    });
    const optimize: std.builtin.Optimize = .ReleaseFast;

    const minimp3 = b.path("../../vendor/minimp3");
    // The libc headers minimp3 includes, which wasm32-freestanding lacks.
    const include = b.path("include");

    // minimp3 is a single header: its declarations, translated for root.zig
    // (Zig 0.17 has no @cImport), and its implementation, compiled by clang
    // from a one-line unit that asks the header for it.
    const files = b.addWriteFiles();
    const header = files.add("c.h", "#include \"minimp3.h\"\n");
    const implementation = files.add("minimp3.c",
        \\#define MINIMP3_IMPLEMENTATION
        \\#include "minimp3.h"
        \\
    );

    const translate = b.addTranslateC(.{
        .root_source_file = header,
        .target = target,
        .optimize = optimize,
        .link_libc = false,
    });
    translate.addIncludePath(minimp3);
    for (defines) |name| {
        translate.defineCMacro(name, null);
    }

    const root = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
        .single_threaded = true,
        .strip = true,
        .imports = &.{.{ .name = "c", .module = translate.createModule() }},
    });
    root.export_symbol_names = &exports;
    root.addIncludePath(include);
    root.addIncludePath(minimp3);

    var flags: std.ArrayList([]const u8) = .empty;
    flags.appendSlice(b.allocator, &.{
        "-O3",
        // Samples must not depend on whether the compiler fuses a multiply
        // and an add.
        "-ffp-contract=off",
        "-fno-stack-protector",
    }) catch @panic("OOM");
    for (defines) |name| {
        flags.append(b.allocator, b.fmt("-D{s}", .{name})) catch @panic("OOM");
    }

    root.addCSourceFile(.{ .file = implementation, .flags = flags.items });

    const wasm = b.addExecutable(.{ .name = "mp3", .root_module = root });
    wasm.entry = .disabled;
    // minimp3 keeps a frame's scratch, some 16 KiB, on the stack.
    wasm.stack_size = 64 * 1024;
    wasm.initial_memory = memory;
    wasm.max_memory = memory;
    b.installArtifact(wasm);
}
