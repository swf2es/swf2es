// Every binary of the package, each its own wasm32-freestanding module in
// zig-out/bin/: bitmap's SIMD kernels, mp3 (minimp3), compress
// (zlib and the LZMA SDK) and tessellate (libtess2). build.ts runs this with
// the pinned Zig and checks the results in as base64; `zig build test` runs
// the bitmap kernel's and the fill flattener's tests on the host.
const std = @import("std");

/// The C libraries are pinned git submodules of the repository, under
/// ../../vendor, read by relative path.
const vendor = "../../vendor/";

pub fn build(b: *std.Build) void {
    const optimize: std.builtin.Optimize = .ReleaseFast;
    // The libc headers the C includes, which wasm32-freestanding lacks.
    const include = b.path("include");

    bitmap(b, optimize);
    mp3(b, wasm(b, &.{.bulk_memory}), optimize, include);
    compress(b, wasm(b, &.{.bulk_memory}), optimize, include);
    tessellate(b, wasm(b, &.{.bulk_memory}), optimize, include);
}

fn wasm(b: *std.Build, features: []const std.Target.wasm.Feature) std.Build.ResolvedTarget {
    return b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        .cpu_features_add = std.Target.wasm.featureSet(features),
    });
}

/// The bitmap kernels, with wasm SIMD: every current browser has it, and an
/// engine without it refuses the module, which leaves the filters to JS.
fn bitmap(b: *std.Build, optimize: std.builtin.Optimize) void {
    const root = b.createModule(.{
        .root_source_file = b.path("src/bitmap/root.zig"),
        .target = wasm(b, &.{ .bulk_memory, .simd128 }),
        .optimize = optimize,
        .single_threaded = true,
        .strip = true,
    });
    root.export_symbol_names = &.{ "resetArena", "convolve", "capacity" };
    const module = b.addExecutable(.{ .name = "bitmap", .root_module = root });
    module.entry = .disabled;
    module.stack_size = 64 * 1024;
    module.max_memory = 128 * 1024 * 1024;
    b.installArtifact(module);

    const tests = b.createModule(.{
        .root_source_file = b.path("src/bitmap/convolve.zig"),
        .target = b.graph.host,
    });
    const test_step = b.step("test", "Run the bitmap kernel's and the fill flattener's tests on the host");
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .name = "bitmap", .root_module = tests })).step);
    const flatten = b.createModule(.{
        .root_source_file = b.path("src/tessellate/flatten.zig"),
        .target = b.graph.host,
    });
    test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .name = "flatten", .root_module = flatten })).step);
}

/// The MP3 decoder: src/mp3/root.zig and minimp3, unchanged.
fn mp3(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.Optimize, include: std.Build.LazyPath) void {
    // Defines for the C and for the header translated for root.zig alike, so
    // that no define can change a type on one side only: MP3 alone, scalar
    // code, and float samples (mp3d_sample_t is float only with the last).
    const defines = [_][]const u8{ "MINIMP3_ONLY_MP3", "MINIMP3_NO_SIMD", "MINIMP3_FLOAT_OUTPUT" };
    // What the module exports beside its memory; it imports nothing.
    const exports = [_][]const u8{ "input", "output", "decode", "channels", "rate" };
    // The whole memory, fixed: a frame's bytes and PCM never grow it.
    const memory = 128 * 1024;

    const minimp3 = b.path(vendor ++ "minimp3");

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
        .root_source_file = b.path("src/mp3/root.zig"),
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

    const module = b.addExecutable(.{ .name = "mp3", .root_module = root });
    module.entry = .disabled;
    // minimp3 keeps a frame's scratch, some 16 KiB, on the stack.
    module.stack_size = 64 * 1024;
    module.initial_memory = memory;
    module.max_memory = memory;
    b.installArtifact(module);
}

/// Compression: src/compress/root.zig, zlib and the LZMA SDK, unchanged.
fn compress(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.Optimize, include: std.Build.LazyPath) void {
    // Defines for the C and for the headers translated for root.zig alike,
    // so that no define can change a struct's layout on one side only: zlib
    // without its own allocator or gzip, the SDK without threads.
    const defines = [_][]const u8{ "Z_SOLO", "NO_GZIP", "HAVE_MEMCPY", "Z7_ST" };
    const zlib_sources = [_][]const u8{
        "adler32.c", "deflate.c", "inflate.c", "inftrees.c", "inffast.c", "trees.c", "zutil.c",
    };
    const sdk_sources = [_][]const u8{ "LzmaEnc.c", "LzFind.c", "LzmaDec.c" };
    // What the module exports; nothing else is, and it imports nothing.
    const exports = [_][]const u8{
        "reset",        "alloc",       "resultPointer", "resultSize", "inputUsed",
        "errorMessage", "inflateData", "deflateData",   "lzmaDecode", "lzmaEncode",
    };

    const zlib = b.path(vendor ++ "zlib");
    const sdk = b.path(vendor ++ "lzma-sdk/C");

    // The C API root.zig calls, translated: Zig 0.17 has no @cImport.
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
        .root_source_file = b.path("src/compress/root.zig"),
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

    const module = b.addExecutable(.{ .name = "compress", .root_module = root });
    module.entry = .disabled;
    module.stack_size = 128 * 1024;
    b.installArtifact(module);
}

/// Fill tessellation: src/tessellate/root.zig's arena and libtess2.
fn tessellate(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.Optimize, include: std.Build.LazyPath) void {
    const sources = [_][]const u8{
        "bucketalloc.c", "dict.c", "geom.c", "mesh.c", "priorityq.c", "sweep.c", "tess.c",
    };
    const exports = [_][]const u8{
        "reset",     "alloc",     "run",      "vertices", "indices", "vertexCount", "triangleCount",
        "highWater", "allocated", "setLimit", "layer",
    };

    const library = b.path(vendor ++ "libtess2");
    const api = library.path(b, "Include");
    const header = b.addWriteFiles().add("c.h", "#include \"tesselator.h\"\n");
    const translate = b.addTranslateC(.{
        .root_source_file = header,
        .target = target,
        .optimize = optimize,
        .link_libc = false,
    });
    translate.addIncludePath(api);

    const root = b.createModule(.{
        .root_source_file = b.path("src/tessellate/root.zig"),
        .target = target,
        .optimize = optimize,
        .single_threaded = true,
        .strip = true,
        .imports = &.{.{ .name = "c", .module = translate.createModule() }},
    });
    root.export_symbol_names = &exports;
    root.addIncludePath(include);
    root.addIncludePath(api);
    root.addCSourceFiles(.{
        .root = library.path(b, "Source"),
        .files = &sources,
        .flags = &.{ "-O2", "-DNDEBUG", "-mbulk-memory", "-fno-stack-protector" },
    });

    const module = b.addExecutable(.{ .name = "tessellate", .root_module = root });
    module.entry = .disabled;
    module.stack_size = 256 * 1024;
    module.max_memory = 128 * 1024 * 1024;
    b.installArtifact(module);
}
