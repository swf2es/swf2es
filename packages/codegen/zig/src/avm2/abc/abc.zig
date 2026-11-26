// A parsed ABC block (AVM2 overview 4.2) as flat tables indexed like the
// ABC's own arrays. Variable-length parts live in shared tables: entry i of
// a table owns items [start[i], start[i + 1]). Fixed tables are exact
// slices, zero where nothing was read; the growing ones are counted, then
// allocated exact and filled (Lists). A table the parse did not reach is
// empty, but a start table keeps its one entry, which `init` gives each
// ABC of its own: start[n] ends the last of n entries, so a section never
// read is one of no entries.
const std = @import("std");
const memory = @import("../../memory.zig");
const C = @import("constants.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const Range = @import("pool.zig").Range;

/// The ABC's tables that its parse grows across entries, whose sizes it
/// does not write up front (each method's parameters, each owner's traits).
const growing = [_][]const u8{
    "paramTypes",
    "optionalValue",
    "optionalKind",
    "metadataKey",
    "metadataValue",
    "interfaces",
    "bodyMethod",
    "bodyMaxStack",
    "bodyLocalCount",
    "bodyInitScopeDepth",
    "bodyMaxScopeDepth",
    "bodyCode",
    "bodyExceptionStart",
    "exceptionFrom",
    "exceptionTo",
    "exceptionTarget",
    "exceptionType",
    "exceptionName",
    "bodyTraitStart",
    "traitName",
    "traitTag",
    "traitId",
    "traitIndex",
    "traitValue",
    "traitValueKind",
    "traitMetadataStart",
    "traitMetadata",
};

/// The growing tables, written by a parse that reads what follows the pool
/// twice: the first pass only counts their rows, and the second fills
/// them, each allocated exact in the ABC's arena from its count, so that
/// the arena holds no more than they take. The tables of a size the ABC
/// writes first are allocated by the first pass and filled again, alike,
/// by the second (zeroed). A rejected ABC is not read a second time.
pub const Lists = struct {
    /// The ABC filled, null while the first pass counts.
    filling: ?*Abc,
    lens: [growing.len]u32 = @splat(0),

    pub const counter: Lists = .{ .filling = null };

    /// Lists for the second pass, the growing tables of `abc` allocated in
    /// `gpa` as long as the first pass, `counted`, counted them.
    pub fn filler(gpa: std.mem.Allocator, abc: *Abc, counted: *const Lists) std.mem.Allocator.Error!Lists {
        inline for (growing, 0..) |name, k| {
            @field(abc, name) = try gpa.alloc(@typeInfo(@FieldType(Abc, name)).pointer.child, counted.lens[k]);
        }

        return .{ .filling = abc };
    }

    fn index(comptime name: []const u8) usize {
        inline for (growing, 0..) |g, k| {
            if (comptime std.mem.eql(u8, g, name)) return k;
        }

        @compileError("not a growing table: " ++ name);
    }

    /// A table of `rows` rows the ABC gives the count of first, zero: made by
    /// the first pass, and `made`, which it made, zeroed again for the second.
    pub fn zeroed(self: *const Lists, comptime T: type, gpa: std.mem.Allocator, made: []T, rows: u32) std.mem.Allocator.Error![]T {
        if (self.filling == null) {
            return memory.allocZeroed(gpa, T, rows);
        }

        std.debug.assert(made.len == rows);
        @memset(std.mem.sliceAsBytes(made), 0);
        return made;
    }

    /// Row `value` at the end of growing table `name`.
    pub inline fn push(self: *Lists, comptime name: []const u8, value: @typeInfo(@FieldType(Abc, name)).pointer.child) void {
        const k = comptime index(name);
        if (self.filling) |abc| {
            @field(abc, name)[self.lens[k]] = value;
        }

        self.lens[k] += 1;
    }

    pub inline fn len(self: *const Lists, comptime name: []const u8) u32 {
        return self.lens[comptime index(name)];
    }

    /// Whether the second pass filled each growing table to the length the first counted.
    pub fn full(self: *const Lists) bool {
        const abc = self.filling orelse return false;
        inline for (growing, 0..) |name, k| {
            if (@field(abc, name).len != self.lens[k]) return false;
        }

        return true;
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
    methodFlags: []C.MethodFlags = &.{},
    methodParamStart: []u32 = &.{},
    paramTypes: []u32 = &.{},
    methodOptionalStart: []u32 = &.{},
    optionalValue: []u32 = &.{},
    optionalKind: []C.Constant = &.{},
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
    instanceFlags: []C.InstanceFlags = &.{},
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
    /// Each body's bytecode in the ABC.
    bodyCode: []Range = &.{},
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
    traitTag: []C.TraitTag = &.{},
    /// Slot id, or disp id for methods.
    traitId: []u32 = &.{},
    /// Type multiname (slots), class index or method index.
    traitIndex: []u32 = &.{},
    /// Constant pool index of a slot's default value; 0 if none.
    traitValue: []u32 = &.{},
    traitValueKind: []C.Constant = &.{},
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

    // Wrapped: on a hostile count the sum passes 2^32 and is read as the
    // i32 it wraps to, an owner no trait has.

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

    /// Trait `t`'s kind.
    pub inline fn traitKind(self: *const Abc, t: u32) C.TraitKind {
        return self.traitTag[t].kind;
    }

    pub inline fn bodyCount(self: *const Abc) u32 {
        return @intCast(self.bodyMethod.len);
    }
};
