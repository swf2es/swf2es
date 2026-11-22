// A parsed ABC block (AVM2 overview 4.2) as flat tables indexed like the
// ABC's own arrays (assembly/avm2/abc/abc.ts). Variable-length parts live in
// shared tables: entry i of a table owns items [start[i], start[i + 1]).
// Fixed tables are exact slices, zero where nothing was read, as
// AssemblyScript's StaticArrays are; growing ones are Rows, whose rows
// never move.
const std = @import("std");
const memory = @import("../../memory.zig");
const Rows = memory.Rows;
const ConstantPool = @import("pool.zig").ConstantPool;

const empty_u32 = @constCast(&[_]u32{});
const one_u32 = @constCast(&[_]u32{0});

pub const Abc = struct {
    /// 0, or the VerifyError number avmplus would throw; then the tables are incomplete.
    @"error": i32 = 0,
    /// Byte length of the ABC block.
    length: u32 = 0,
    minorVersion: u32 = 0,
    majorVersion: u32 = 0,
    /// Whether this is a builtin ABC, one the player ships (builtin.abc,
    /// playerglobal): it may declare native methods and name traits with
    /// several namespaces, as avmplus allows for a builtin pool.
    builtin: bool = false,
    pool: ConstantPool = .{},

    // method_info. Type indices are checked when a method is compiled, as
    // avmplus checks them when a method is first resolved.
    methodReturnType: []u32 = empty_u32,
    /// String index of the method's debug name; not checked by avmplus.
    methodName: []u32 = empty_u32,
    methodFlags: []u8 = @constCast(&[_]u8{}),
    methodParamStart: []u32 = one_u32,
    paramTypes: Rows(u32) = .{},
    methodOptionalStart: []u32 = one_u32,
    optionalValue: Rows(u32) = .{},
    optionalKind: Rows(u8) = .{},
    /// The owner (see instanceOwner .. activationOwner) a method is bound to, or -1.
    methodOwner: []i32 = @constCast(&[_]i32{}),

    // metadata_info
    metadataName: []u32 = empty_u32,
    metadataItemStart: []u32 = one_u32,
    metadataKey: Rows(u32) = .{},
    metadataValue: Rows(u32) = .{},

    // instance_info and class_info. Base classes and interfaces are checked
    // when classes are linked, since they may come from another ABC.
    instanceName: []u32 = empty_u32,
    /// Multiname of the base class; 0 if there is none.
    instanceSuper: []u32 = empty_u32,
    instanceFlags: []u8 = @constCast(&[_]u8{}),
    /// Namespace index; 0 if the class has no protected namespace.
    instanceProtectedNs: []u32 = empty_u32,
    instanceInterfaceStart: []u32 = one_u32,
    interfaces: Rows(u32) = .{},
    instanceInit: []u32 = empty_u32,
    classInit: []u32 = empty_u32,

    // script_info
    scriptInit: []u32 = empty_u32,

    // method_body_info, in ABC order.
    /// Index of each method's body, or -1 if it has none.
    methodBody: []i32 = @constCast(&[_]i32{}),
    bodyMethod: Rows(u32) = .{},
    bodyMaxStack: Rows(u32) = .{},
    bodyLocalCount: Rows(u32) = .{},
    bodyInitScopeDepth: Rows(u32) = .{},
    bodyMaxScopeDepth: Rows(u32) = .{},
    /// Offset of the bytecode from the start of the ABC.
    bodyCodeStart: Rows(u32) = .{},
    bodyCodeLength: Rows(u32) = .{},
    bodyExceptionStart: Rows(u32) = .{},
    exceptionFrom: Rows(u32) = .{},
    exceptionTo: Rows(u32) = .{},
    exceptionTarget: Rows(u32) = .{},
    /// Multiname of the caught type; 0 catches everything.
    exceptionType: Rows(u32) = .{},
    /// Multiname of the catch variable; 0 if it has none.
    exceptionName: Rows(u32) = .{},
    /// Body b's activation traits are traits [start[b] .. start[b + 1]].
    bodyTraitStart: Rows(u32) = .{},

    // traits_info of every instance, class, script and method activation, in that order.
    traitName: Rows(u32) = .{},
    /// Kind in the low 4 bits, attributes in the high 4.
    traitTag: Rows(u8) = .{},
    /// Slot id, or disp id for methods.
    traitId: Rows(u32) = .{},
    /// Type multiname (slots), class index or method index.
    traitIndex: Rows(u32) = .{},
    /// Constant pool index of a slot's default value; 0 if none.
    traitValue: Rows(u32) = .{},
    traitValueKind: Rows(u8) = .{},
    traitMetadataStart: Rows(u32) = .{},
    traitMetadata: Rows(u32) = .{},
    instanceTraitStart: []u32 = one_u32,
    classTraitStart: []u32 = one_u32,
    scriptTraitStart: []u32 = one_u32,

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
        return @intCast(i);
    }

    pub inline fn classOwner(self: *const Abc, i: u32) i32 {
        return @intCast(self.classCount() + i);
    }

    pub inline fn scriptOwner(self: *const Abc, i: u32) i32 {
        return @intCast(2 * self.classCount() + i);
    }

    /// The owner of method m's activation traits.
    pub inline fn activationOwner(self: *const Abc, m: u32) i32 {
        return @intCast(2 * self.classCount() + self.scriptCount() + m);
    }

    pub inline fn bodyCount(self: *const Abc) u32 {
        return self.bodyMethod.len;
    }

    /// Record the first error, as avmplus stops at the first throw; returns false.
    pub fn fail(self: *Abc, err: i32) bool {
        if (self.@"error" == 0) {
            self.@"error" = err;
        }

        return false;
    }
};
