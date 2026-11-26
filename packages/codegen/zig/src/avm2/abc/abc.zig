// A parsed ABC block (AVM2 overview 4.2) as flat tables indexed like the
// ABC's own arrays (assembly/avm2/abc/abc.ts). Variable-length parts live in
// shared tables: entry i of a table owns items [start[i], start[i + 1]).
// Fixed tables are exact slices, zero where nothing was read, as
// AssemblyScript's StaticArrays are; the growing ones are counted, then
// allocated exact and filled (Lists). A table the parse did not reach is
// empty, but those AssemblyScript starts with one entry (the start
// tables), which `init` gives each ABC of its own.
const std = @import("std");
const memory = @import("../../memory.zig");
const ConstantPool = @import("pool.zig").ConstantPool;

/// How many rows each table of Lists holds.
pub const Counts = struct {
    paramTypes: u32 = 0,
    optionalValue: u32 = 0,
    optionalKind: u32 = 0,
    metadataKey: u32 = 0,
    metadataValue: u32 = 0,
    interfaces: u32 = 0,
    bodyMethod: u32 = 0,
    bodyMaxStack: u32 = 0,
    bodyLocalCount: u32 = 0,
    bodyInitScopeDepth: u32 = 0,
    bodyMaxScopeDepth: u32 = 0,
    bodyCodeStart: u32 = 0,
    bodyCodeLength: u32 = 0,
    bodyExceptionStart: u32 = 0,
    exceptionFrom: u32 = 0,
    exceptionTo: u32 = 0,
    exceptionTarget: u32 = 0,
    exceptionType: u32 = 0,
    exceptionName: u32 = 0,
    bodyTraitStart: u32 = 0,
    traitName: u32 = 0,
    traitTag: u32 = 0,
    traitId: u32 = 0,
    traitIndex: u32 = 0,
    traitValue: u32 = 0,
    traitValueKind: u32 = 0,
    traitMetadataStart: u32 = 0,
    traitMetadata: u32 = 0,
};

/// Lists' tables.
pub const Items = struct {
    paramTypes: []u32 = &.{},
    optionalValue: []u32 = &.{},
    optionalKind: []u8 = &.{},
    metadataKey: []u32 = &.{},
    metadataValue: []u32 = &.{},
    interfaces: []u32 = &.{},
    bodyMethod: []u32 = &.{},
    bodyMaxStack: []u32 = &.{},
    bodyLocalCount: []u32 = &.{},
    bodyInitScopeDepth: []u32 = &.{},
    bodyMaxScopeDepth: []u32 = &.{},
    bodyCodeStart: []u32 = &.{},
    bodyCodeLength: []u32 = &.{},
    bodyExceptionStart: []u32 = &.{},
    exceptionFrom: []u32 = &.{},
    exceptionTo: []u32 = &.{},
    exceptionTarget: []u32 = &.{},
    exceptionType: []u32 = &.{},
    exceptionName: []u32 = &.{},
    bodyTraitStart: []u32 = &.{},
    traitName: []u32 = &.{},
    traitTag: []u8 = &.{},
    traitId: []u32 = &.{},
    traitIndex: []u32 = &.{},
    traitValue: []u32 = &.{},
    traitValueKind: []u8 = &.{},
    traitMetadataStart: []u32 = &.{},
    traitMetadata: []u32 = &.{},
};

/// The tables an ABC's parse grows across entries, whose sizes the ABC does
/// not write up front (each method's parameters, each owner's traits): a
/// first pass over what follows the pool only counts their rows, and the
/// second fills them, allocated exact in the ABC's arena from those counts.
/// The tables of a size the ABC writes first are allocated by the first
/// pass and filled again, alike, by the second (zeroed).
pub const Lists = struct {
    /// Where a pass keeps what only it needs, as each owner's methods.
    scratch: std.mem.Allocator,
    /// Whether this pass only counts.
    counting: bool,
    lens: Counts = .{},
    items: Items = .{},

    /// Lists for the first pass, which counts.
    pub fn counter(scratch: std.mem.Allocator) Lists {
        return .{ .scratch = scratch, .counting = true };
    }

    /// Lists for the second pass, of the rows `counts` holds, in `gpa`.
    pub fn filler(gpa: std.mem.Allocator, scratch: std.mem.Allocator, counts: Counts) std.mem.Allocator.Error!Lists {
        var self: Lists = .{ .scratch = scratch, .counting = false };
        inline for (@typeInfo(Items).@"struct".field_names) |name| {
            @field(self.items, name) = try gpa.alloc(@typeInfo(@TypeOf(@field(self.items, name))).pointer.child, @field(counts, name));
        }

        return self;
    }

    /// A table of `rows` rows the ABC gives the count of first, zero: made by
    /// the first pass, and `made`, which it made, zeroed again for the second.
    pub fn zeroed(self: *const Lists, comptime T: type, gpa: std.mem.Allocator, made: []T, rows: u32) std.mem.Allocator.Error![]T {
        if (self.counting) {
            return memory.allocZeroed(gpa, T, rows);
        }

        std.debug.assert(made.len == rows);
        @memset(made, 0);
        return made;
    }

    /// Row `value` at the end of table `name`.
    pub inline fn push(self: *Lists, comptime name: []const u8, value: @typeInfo(@FieldType(Items, name)).pointer.child) void {
        const at = @field(self.lens, name);
        if (!self.counting) {
            @field(self.items, name)[at] = value;
        }

        @field(self.lens, name) = at + 1;
    }

    pub inline fn len(self: *const Lists, comptime name: []const u8) u32 {
        return @field(self.lens, name);
    }

    /// The tables filled, as the ABC's: each exactly as long as the first pass counted.
    pub fn keep(self: *const Lists, abc: *Abc) void {
        inline for (@typeInfo(Items).@"struct".field_names) |name| {
            std.debug.assert(@field(self.lens, name) == @field(self.items, name).len);
            @field(abc, name) = @field(self.items, name);
        }
    }
};

pub const Abc = struct {
    /// 0, or the VerifyError number avmplus would throw; then the tables are incomplete.
    @"error": i32 = 0,
    /// Byte length of the ABC block.
    length: u32 = 0,
    /// Bytes its padded input and parsed tables take in the domain arena.
    parsed_bytes: u32 = 0,
    minorVersion: u32 = 0,
    majorVersion: u32 = 0,
    /// Whether this is a builtin ABC, one the player ships (builtin.abc,
    /// playerglobal): it may declare native methods and name traits with
    /// several namespaces, as avmplus allows for a builtin pool.
    builtin: bool = false,
    pool: ConstantPool = .{},

    // method_info. Type indices are checked when a method is compiled, as
    // avmplus checks them when a method is first resolved.
    methodReturnType: []u32 = &.{},
    /// String index of the method's debug name; not checked by avmplus.
    methodName: []u32 = &.{},
    methodFlags: []u8 = &.{},
    methodParamStart: []u32 = &.{},
    paramTypes: []u32 = &.{},
    methodOptionalStart: []u32 = &.{},
    optionalValue: []u32 = &.{},
    optionalKind: []u8 = &.{},
    /// The owner (see instanceOwner .. activationOwner) a method is bound to, or -1.
    methodOwner: []i32 = &.{},

    // metadata_info
    metadataName: []u32 = &.{},
    metadataItemStart: []u32 = &.{},
    metadataKey: []u32 = &.{},
    metadataValue: []u32 = &.{},

    // instance_info and class_info. Base classes and interfaces are checked
    // when classes are linked, since they may come from another ABC.
    instanceName: []u32 = &.{},
    /// Multiname of the base class; 0 if there is none.
    instanceSuper: []u32 = &.{},
    instanceFlags: []u8 = &.{},
    /// Namespace index; 0 if the class has no protected namespace.
    instanceProtectedNs: []u32 = &.{},
    instanceInterfaceStart: []u32 = &.{},
    interfaces: []u32 = &.{},
    instanceInit: []u32 = &.{},
    classInit: []u32 = &.{},

    // script_info
    scriptInit: []u32 = &.{},

    // method_body_info, in ABC order.
    /// Index of each method's body, or -1 if it has none.
    methodBody: []i32 = &.{},
    bodyMethod: []u32 = &.{},
    bodyMaxStack: []u32 = &.{},
    bodyLocalCount: []u32 = &.{},
    bodyInitScopeDepth: []u32 = &.{},
    bodyMaxScopeDepth: []u32 = &.{},
    /// Offset of the bytecode from the start of the ABC.
    bodyCodeStart: []u32 = &.{},
    bodyCodeLength: []u32 = &.{},
    bodyExceptionStart: []u32 = &.{},
    exceptionFrom: []u32 = &.{},
    exceptionTo: []u32 = &.{},
    exceptionTarget: []u32 = &.{},
    /// Multiname of the caught type; 0 catches everything.
    exceptionType: []u32 = &.{},
    /// Multiname of the catch variable; 0 if it has none.
    exceptionName: []u32 = &.{},
    /// Body b's activation traits are traits [start[b] .. start[b + 1]].
    bodyTraitStart: []u32 = &.{},

    // traits_info of every instance, class, script and method activation, in that order.
    traitName: []u32 = &.{},
    /// Kind in the low 4 bits, attributes in the high 4.
    traitTag: []u8 = &.{},
    /// Slot id, or disp id for methods.
    traitId: []u32 = &.{},
    /// Type multiname (slots), class index or method index.
    traitIndex: []u32 = &.{},
    /// Constant pool index of a slot's default value; 0 if none.
    traitValue: []u32 = &.{},
    traitValueKind: []u8 = &.{},
    traitMetadataStart: []u32 = &.{},
    traitMetadata: []u32 = &.{},
    instanceTraitStart: []u32 = &.{},
    classTraitStart: []u32 = &.{},
    scriptTraitStart: []u32 = &.{},

    /// An ABC of defaults only, in `gpa`.
    pub fn init(gpa: std.mem.Allocator, length: u32, builtin: bool) std.mem.Allocator.Error!Abc {
        return .{
            .length = length,
            .builtin = builtin,
            .pool = try .init(gpa),
            .methodParamStart = try memory.allocZeroed(gpa, u32, 1),
            .methodOptionalStart = try memory.allocZeroed(gpa, u32, 1),
            .metadataItemStart = try memory.allocZeroed(gpa, u32, 1),
            .instanceInterfaceStart = try memory.allocZeroed(gpa, u32, 1),
            .instanceTraitStart = try memory.allocZeroed(gpa, u32, 1),
            .classTraitStart = try memory.allocZeroed(gpa, u32, 1),
            .scriptTraitStart = try memory.allocZeroed(gpa, u32, 1),
        };
    }

    pub fn hasFloatSupport(self: *const Abc) bool {
        return self.majorVersion == 47 and self.minorVersion >= 16;
    }

    pub inline fn methodCount(self: *const Abc) u32 {
        return @intCast(self.methodFlags.len);
    }

    pub inline fn metadataCount(self: *const Abc) u32 {
        return @intCast(self.metadataName.len);
    }

    pub inline fn classCount(self: *const Abc) u32 {
        return @intCast(self.instanceName.len);
    }

    pub inline fn scriptCount(self: *const Abc) u32 {
        return @intCast(self.scriptInit.len);
    }

    pub inline fn instanceOwner(_: *const Abc, i: u32) i32 {
        return @bitCast(i);
    }

    // Wrapped, as AssemblyScript's u32 sums cast to i32 are.

    pub inline fn classOwner(self: *const Abc, i: u32) i32 {
        return @bitCast(self.classCount() +% i);
    }

    pub inline fn scriptOwner(self: *const Abc, i: u32) i32 {
        return @bitCast(2 *% self.classCount() +% i);
    }

    /// The owner of method m's activation traits.
    pub inline fn activationOwner(self: *const Abc, m: u32) i32 {
        return @bitCast(2 *% self.classCount() +% self.scriptCount() +% m);
    }

    pub inline fn bodyCount(self: *const Abc) u32 {
        return @intCast(self.bodyMethod.len);
    }

    /// Record the first error, as avmplus stops at the first throw; returns false.
    pub fn fail(self: *Abc, err: i32) bool {
        if (self.@"error" == 0) {
            self.@"error" = err;
        }

        return false;
    }
};
