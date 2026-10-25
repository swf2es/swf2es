// The Zig arena and libtess2, compiled together to wasm32-freestanding.
const std = @import("std");

const sources = [_][]const u8{
    "bucketalloc.c", "dict.c", "geom.c", "mesh.c", "priorityq.c", "sweep.c", "tess.c",
};
const exports = [_][]const u8{
    "reset",     "alloc",     "run",      "vertices",     "indices", "vertexCount", "triangleCount",
    "highWater", "allocated", "setLimit", "joinContours",
};

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        .cpu_features_add = std.Target.wasm.featureSet(&.{.bulk_memory}),
    });
    const optimize: std.builtin.Optimize = .ReleaseFast;
    const library = b.path("../../vendor/libtess2");
    const include = b.path("include");
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
        .root_source_file = b.path("src/root.zig"),
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

    const wasm = b.addExecutable(.{ .name = "tessellate", .root_module = root });
    wasm.entry = .disabled;
    wasm.stack_size = 256 * 1024;
    wasm.max_memory = 128 * 1024 * 1024;
    b.installArtifact(wasm);
}
