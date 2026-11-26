// The ABC block parsed: the constant pool, then each section in the
// order avmplus' AbcParser reads them.
const std = @import("std");
const Allocator = std.mem.Allocator;
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const errors = @import("errors.zig");
const Diagnostics = errors.Diagnostics;
const Error = errors.Error;
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
    var diag: Diagnostics = .{};
    parse(gpa, scratch, abc, data, length, &diag) catch |err| switch (err) {
        // A rejected ABC is a value its readers ask for its error: kept, not unwound.
        error.Verify => abc.@"error" = diag.code,
        error.OutOfMemory => return error.OutOfMemory,
    };
    return abc;
}

fn parse(gpa: Allocator, scratch: Allocator, abc: *Abc, data: []const u8, length: u32, diag: *Diagnostics) Error!void {
    var r: Reader = .init(data, 0, length);
    abc.minorVersion = r.u16_();
    abc.majorVersion = r.u16_();
    if (r.failed) {
        return diag.fail(.kCorruptABCError);
    }

    if (!isSupportedVersion(abc.majorVersion, abc.minorVersion)) {
        return diag.fail(.kInvalidMagicError);
    }

    try readConstantPool(gpa, scratch, &r, abc.hasFloatSupport(), &abc.pool, diag);

    // What follows the pool twice: once counting the growing tables' rows,
    // then, for an ABC the first pass accepts, filling them, allocated exact
    // from the counts (Lists).
    var counter: Lists = .counter;
    var again = r;
    try tables(gpa, abc, &counter, &again, diag);
    var lists: Lists = try .filler(gpa, abc, &counter);
    tables(gpa, abc, &lists, &r, diag) catch |err| switch (err) {
        error.Verify => unreachable, // the first pass, reading the same, accepted it
        error.OutOfMemory => return error.OutOfMemory,
    };
    std.debug.assert(lists.full());
}

/// The tables after the pool, the growing ones in `lists`.
fn tables(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader, diag: *Diagnostics) Error!void {
    try methods.readMethods(gpa, abc, lists, r, diag);
    try methods.readMetadata(gpa, abc, lists, r, diag);
    try classes.readInstances(gpa, abc, lists, r, diag);
    try classes.readClasses(gpa, abc, lists, r, diag);
    try classes.readScripts(gpa, abc, lists, r, diag);
    try readMethodBodies(gpa, abc, lists, r, diag);

    // A read past the end returns 0, which can look like an empty table.
    if (r.failed) {
        return diag.fail(.kCorruptABCError);
    }

    lists.push("traitMetadataStart", lists.len("traitMetadata"));
}

/// The versions avmplus' AbcParser::canParse accepts in Flash Player builds,
/// as the oracle's avmshell does: 46.16 and 47.12 to 47.18. From 47.16,
/// AIR adds a scalar float pool; older ABCs keep the Flash layout.
fn isSupportedVersion(major: u32, minor: u32) bool {
    return (major == 46 and minor == 16) or (major == 47 and minor >= 12 and minor <= 18);
}
