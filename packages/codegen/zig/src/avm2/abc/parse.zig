// The ABC block parsed (assembly/avm2/abc/parse.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const readMethodBodies = @import("bodies.zig").readMethodBodies;
const classes = @import("classes.zig");
const C = @import("constants.zig");
const methods = @import("methods.zig");
const readConstantPool = @import("pool.zig").readConstantPool;
const Reader = @import("reader.zig").Reader;

/// Parse the ABC block of `length` bytes at the start of `data`, which must
/// be followed by PADDING readable bytes (the caller copies it so, as
/// domainAdd will; Reader.init asserts it), its tables in `gpa` and what
/// only the parse needs in `scratch`; `builtin` for an ABC the player ships
/// (see Abc.builtin). Check `error` on the result: 0, or the VerifyError
/// avmplus would throw.
pub fn readAbc(gpa: Allocator, scratch: Allocator, data: []const u8, length: u32, builtin: bool) Allocator.Error!*Abc {
    const abc = try gpa.create(Abc);
    abc.* = try .init(gpa, length, builtin);
    var lists: Lists = .{ .scratch = scratch };
    try parse(gpa, abc, &lists, data, length);
    try lists.keep(gpa, abc);
    return abc;
}

/// readAbc's tables, the growing ones in `lists`; `abc.error` says where it stopped.
fn parse(gpa: Allocator, abc: *Abc, lists: *Lists, data: []const u8, length: u32) Allocator.Error!void {
    var r: Reader = .init(data, 0, length);
    abc.minorVersion = r.u16_();
    abc.majorVersion = r.u16_();
    if (r.failed) {
        _ = abc.fail(C.kCorruptABCError);
        return;
    }

    if (!isSupportedVersion(abc.majorVersion, abc.minorVersion)) {
        _ = abc.fail(C.kInvalidMagicError);
        return;
    }

    abc.pool = try readConstantPool(gpa, lists.scratch, &r, abc.hasFloatSupport());
    if (abc.pool.@"error" != 0) {
        _ = abc.fail(abc.pool.@"error");
        return;
    }

    if (!try methods.readMethods(gpa, abc, lists, &r) or
        !try methods.readMetadata(gpa, abc, lists, &r) or
        !try classes.readInstances(gpa, abc, lists, &r) or
        !try classes.readClasses(gpa, abc, lists, &r) or
        !try classes.readScripts(gpa, abc, lists, &r) or
        !try readMethodBodies(gpa, abc, lists, &r))
    {
        return;
    }

    // A read past the end returns 0, which can look like an empty table.
    if (r.failed) {
        _ = abc.fail(C.kCorruptABCError);
        return;
    }

    try lists.traitMetadataStart.append(lists.scratch, abc_.len(lists.traitMetadata));
}

/// The versions avmplus' AbcParser::canParse accepts in Flash Player builds,
/// as the oracle's avmshell does: 46.16 and 47.12 to 47.18. From 47.16,
/// AIR adds a scalar float pool; older ABCs keep the Flash layout.
fn isSupportedVersion(major: u32, minor: u32) bool {
    return (major == 46 and minor == 16) or (major == 47 and minor >= 12 and minor <= 18);
}
