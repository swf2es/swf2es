const std = @import("std");

pub fn build(b: *std.Build) void {
    const test_step = b.step("test", "Run the kernel's tests on the host, scalar and SIMD");
    for ([_][]const u8{ "scalar", "simd" }) |name| {
        const simd = !std.mem.eql(u8, name, "scalar");
        const target = b.resolveTargetQuery(.{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
            .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
            .cpu_features_add = if (simd) std.Target.wasm.featureSet(&.{ .bulk_memory, .simd128 }) else std.Target.wasm.featureSet(&.{.bulk_memory}),
        });
        const options = b.addOptions();
        options.addOption(bool, "simd", simd);
        const root = b.createModule(.{
            .root_source_file = b.path("src/bitmap.zig"),
            .target = target,
            .optimize = .ReleaseFast,
            .single_threaded = true,
            .strip = true,
        });
        root.addOptions("options", options);
        root.export_symbol_names = &.{ "resetArena", "convolve", "capacity" };
        const wasm = b.addExecutable(.{ .name = name, .root_module = root });
        wasm.entry = .disabled;
        wasm.stack_size = 64 * 1024;
        wasm.max_memory = 128 * 1024 * 1024;
        b.installArtifact(wasm);

        const tests = b.createModule(.{
            .root_source_file = b.path("src/convolve.zig"),
            .target = b.graph.host,
        });
        tests.addOptions("options", options);
        test_step.dependOn(&b.addRunArtifact(b.addTest(.{ .name = name, .root_module = tests })).step);
    }
}
