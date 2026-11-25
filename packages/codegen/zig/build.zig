// The compiler in Zig (docs/zig-codegen.md), built by build.ts with the
// pinned Zig into zig-out/bin/:
//
//   - codegen.wasm, the compiler, ReleaseSafe: every index, cast and
//     overflow checked, a failed check a panic (src/panic.zig);
//   - testing.wasm, the test build: the same with the tests' exports
//     (src/testing.zig);
//   - testing-poison.wasm, the test build filling every freed run and
//     rolled-back allocation with 0xAA, which must give the same output.
//
// `zig build test` runs every file's inline tests natively, once as each
// build allocates; `zig build names` writes codegen-names.wasm, the
// compiler with the name section, so that a trap's stack names functions.
const std = @import("std");

/// What the compiler exports beside its memory; it imports only env.abort.
const exports = [_][]const u8{
    "input",
    "outputLength",
    "codegenError",
    "compilerVersion",
    "abcVersion",
    "actionsModuleBytes",
    "actionsModuleEntries",
    "actionsModuleUnits",
    "actionsEmitEach",
    "actionsEmitEachBytes",
    "actionsHold",
    "actionsRelease",
    "actionsHeldCount",
    "actionsHeldEmitEachBytes",
    "actionsHeldUnitBytes",
    "actionsUnitBytes",
    "actionsUnitLimits",
    "domainReset",
    "domainAdd",
    "domainChild",
    "domainDrop",
    "domainEvict",
    "domainState",
    "domainRestore",
    "domainRevive",
    "domainFound",
    "domainLinked",
    "domainWantsCompact",
    "domainUsage",
    "domainParent",
    "domainModule",
    "domainModuleBytes",
    "domainModuleMoreBytes",
    "domainModuleDone",
    "domainModuleEntries",
    "domainSourceMap",
    "domainContext",
    "domainKeyHeaderBytes",
    "domainKeyFork",
    "domainKeyLogBytes",
    "domainRevision",
    "domainLogMark",
    "domainLogSince",
    "domainReplay",
    "lastAddLinked",
    "journalBytes",
    "replayEntry",
    "abandonRebuild",
    "loadCheckpointState",
    "domainCompact",
    "domainRebuildStep",
    "domainSaveBytes",
    "domainSavedAbcBytes",
    "domainLoad",
    "domainLoadAbc",
    "domainLoadRebuild",
};

/// What the test build exports beside them.
const testing_exports = exports ++ [_][]const u8{
    "memoryChunksUsed",
    "memoryReached",
    "memoryTopRuns",
    "memoryReserve",
    "testingPanic",
    "testingOverflow",
    "stackPaint",
    "stackDeepest",
    "domainFind",
    "domainSummary",
    "domainTraits",
    "domainResolve",
    "domainBuiltins",
    "domainSlotTypes",
    "domainTraitsCount",
    "unspecifiedReads",
    "benchParse",
    "benchDecode",
    "codeDump",
    "domainVerifyAll",
    "domainIr",
    "domainCheckIr",
    "domainIrAll",
    "domainEmit",
    "domainEmitEach",
    "domainEmitEachBytes",
    "domainPartBudget",
    "domainRebuild",
    "avm1Opcodes",
    "avm1Dump",
    "avm1Check",
    "avm1Action",
    "readAll",
    "poolDump",
    "abcDump",
    "opcodeTable",
};

/// The shadow stack, first in memory so that overflowing it traps rather
/// than writes into the static data or the heap.
const stack_size = 1 << 20;

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_model = .{ .explicit = &std.Target.wasm.cpu.generic },
        // As asc builds codegen.wasm: float-to-int conversions saturate rather than trap.
        .cpu_features_add = std.Target.wasm.featureSet(&.{ .bulk_memory, .nontrapping_fptoint, .sign_ext, .mutable_globals }),
    });

    b.installArtifact(module(b, target, "codegen", "src/root.zig", &exports, false, true));
    b.installArtifact(module(b, target, "testing", "src/testing.zig", &testing_exports, false, true));
    b.installArtifact(module(b, target, "testing-poison", "src/testing.zig", &testing_exports, true, true));

    // The release build with probes reaching what later stages will reach from its exports, for measuring.
    const probe = b.addInstallArtifact(module(b, target, "codegen-probe", "src/probe.zig", &(exports ++ [_][]const u8{"probeVerify"}), false, true), .{});
    b.step("probe", "Build the release with probes, to measure its size as the port goes").dependOn(&probe.step);

    const names = b.addInstallArtifact(module(b, target, "codegen-names", "src/root.zig", &exports, false, false), .{});
    b.step("names", "Build the compiler with the name section").dependOn(&names.step);

    const test_step = b.step("test", "Run the inline tests natively, as each build allocates");
    for ([_]bool{ false, true }) |poison| {
        const tests = b.addTest(.{
            .name = if (poison) "tests-poison" else "tests",
            .root_module = b.createModule(.{
                .root_source_file = b.path("src/testing.zig"),
                .target = b.graph.host,
                .optimize = .ReleaseSafe,
                .imports = &.{.{ .name = "options", .module = options(b, poison, true) }},
            }),
        });
        test_step.dependOn(&b.addRunArtifact(tests).step);
    }
}

/// `checks`: the test builds' and the native tests' assertions that the
/// release build leaves out, such as that a row the domain writes in place
/// is written inside a Change.
fn options(b: *std.Build, poison: bool, checks: bool) *std.Build.Module {
    const values = b.addOptions();
    values.addOption(bool, "poison", poison);
    values.addOption(bool, "checks", checks);
    values.addOption(u32, "stack_size", stack_size);
    return values.createModule();
}

fn module(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    name: []const u8,
    root: []const u8,
    names: []const []const u8,
    poison: bool,
    strip: bool,
) *std.Build.Step.Compile {
    const root_module = b.createModule(.{
        .root_source_file = b.path(root),
        .target = target,
        .optimize = .ReleaseSafe,
        .single_threaded = true,
        .strip = strip,
        .imports = &.{.{ .name = "options", .module = options(b, poison, std.mem.eql(u8, root, "src/testing.zig")) }},
    });
    root_module.export_symbol_names = names;
    const wasm = b.addExecutable(.{ .name = name, .root_module = root_module });
    wasm.entry = .disabled;
    wasm.stack_size = stack_size;
    return wasm;
}
