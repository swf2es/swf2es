// The compression module: src/root.zig, zlib and the LZMA SDK compiled
// together to wasm32-freestanding, into zig-out/bin/compress.wasm. build.ts
// runs this with the pinned Zig and checks the result in as base64.
const std = @import("std");

/// Defines for the C and for the headers translated for compress.zig alike,
/// so that no define can change a struct's layout on one side only: zlib
/// without its own allocator or gzip, the SDK without threads.
const defines = [_][]const u8{ "Z_SOLO", "NO_GZIP", "HAVE_MEMCPY", "Z7_ST" };

const zlib_sources = [_][]const u8{
    "adler32.c", "deflate.c", "inflate.c", "inftrees.c", "inffast.c", "trees.c", "zutil.c",
};
const sdk_sources = [_][]const u8{ "LzmaEnc.c", "LzFind.c", "LzmaDec.c" };

/// What the module exports; nothing else is, and it imports nothing.
const exports = [_][]const u8{
    "reset",       "alloc",       "resultPointer", "resultSize", "inputUsed",
    "errorMessage", "inflateData", "deflateData",  "lzmaDecode", "lzmaEncode",
};

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        .cpu_features_add = std.Target.wasm.featureSet(&.{.bulk_memory}),
    });
    const optimize: std.builtin.Optimize = .ReleaseFast;

    const zlib = b.path("../../vendor/zlib");
    const sdk = b.path("../../vendor/lzma-sdk/C");
    // Declarations of the libc functions the C calls, which Zig's compiler-rt
    // defines: wasm32-freestanding has no libc headers.
    const include = b.path("include");

    // The C API compress.zig calls, translated: Zig 0.17 has no @cImport.
    const headers = b.addWriteFiles().add("c.h",
        \\#include "zlib.h"
        \\#include "LzmaEnc.h"
        \\#include "LzmaDec.h"
        \\
    );
    const translate = b.addTranslateC(.{
        .root_source_file = headers,
        .target = target,
        .optimize = optimize,
        .link_libc = false,
    });
    for ([_]std.Build.LazyPath{ include, zlib, sdk }) |dir| {
        translate.addIncludePath(dir);
    }

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
    for ([_]std.Build.LazyPath{ include, zlib, sdk }) |dir| {
        root.addIncludePath(dir);
    }

    var flags: std.ArrayList([]const u8) = .empty;
    flags.appendSlice(b.allocator, &.{
        "-O2",
        "-mbulk-memory",
        "-fno-stack-protector",
        // Z_SOLO keeps zlib from including string.h, whose functions it still
        // calls: include/'s, relative to the package, where zig build runs.
        "-include",
        "include/string.h",
    }) catch @panic("OOM");
    for (defines) |name| {
        flags.append(b.allocator, b.fmt("-D{s}", .{name})) catch @panic("OOM");
    }

    root.addCSourceFiles(.{ .root = zlib, .files = &zlib_sources, .flags = flags.items });
    root.addCSourceFiles(.{ .root = sdk, .files = &sdk_sources, .flags = flags.items });

    const wasm = b.addExecutable(.{ .name = "compress", .root_module = root });
    wasm.entry = .disabled;
    wasm.stack_size = 128 * 1024;
    b.installArtifact(wasm);
}
