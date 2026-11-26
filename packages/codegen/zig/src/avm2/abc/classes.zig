// instance_info, class_info and script_info, checked like avmplus'
// parseInstanceInfos, parseClassInfos and parseScriptInfos
// (assembly/avm2/abc/classes.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const traits = @import("traits.zig");
const bindingNameError = traits.bindingNameError;
const readTraits = traits.readTraits;

pub fn readInstances(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.instanceName = try lists.zeroed(u32, gpa, abc.instanceName, count);
    abc.instanceSuper = try lists.zeroed(u32, gpa, abc.instanceSuper, count);
    abc.instanceFlags = try lists.zeroed(u8, gpa, abc.instanceFlags, count);
    abc.instanceProtectedNs = try lists.zeroed(u32, gpa, abc.instanceProtectedNs, count);
    abc.instanceInterfaceStart = try lists.zeroed(u32, gpa, abc.instanceInterfaceStart, count + 1);
    abc.instanceInit = try lists.zeroed(u32, gpa, abc.instanceInit, count);
    abc.instanceTraitStart = try lists.zeroed(u32, gpa, abc.instanceTraitStart, count + 1);

    const pool = &abc.pool;
    for (0..count) |index| {
        const i: u32 = @intCast(index);
        const name = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        const nameError = bindingNameError(pool, name, abc.builtin);
        if (nameError != 0) {
            return abc.fail(nameError);
        }

        const base = r.u30_();
        if (base >= pool.multinameCount()) {
            return abc.fail(if (r.failed) C.kCorruptABCError else C.kCpoolIndexRangeError);
        }

        const flags: u8 = @truncate(r.u8_());
        var protectedNs: u32 = 0;
        if (flags & C.INSTANCE_ProtectedNs != 0) {
            protectedNs = r.u30_();
            if (protectedNs >= pool.nsCount()) {
                return abc.fail(if (r.failed) C.kCorruptABCError else C.kCpoolIndexRangeError);
            }
        }

        const interfaceCount = r.u30_();
        if (interfaceCount >= 0x10000000) {
            return abc.fail(C.kCorruptABCError);
        }

        abc.instanceInterfaceStart[i] = lists.len("interfaces");
        for (0..interfaceCount) |_| {
            const @"type" = r.u30_();
            if (r.failed) {
                return abc.fail(C.kCorruptABCError);
            }

            if (@"type" == 0) {
                return abc.fail(C.kCannotImplementError);
            }

            if (@"type" >= pool.multinameCount()) {
                return abc.fail(C.kCpoolIndexRangeError);
            }

            lists.push("interfaces", @"type");
        }

        const init = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (init >= abc.methodCount()) {
            return abc.fail(C.kMethodInfoExceedsCountError);
        }

        abc.instanceName[i] = name;
        abc.instanceSuper[i] = base;
        abc.instanceFlags[i] = flags;
        abc.instanceProtectedNs[i] = protectedNs;
        abc.instanceInit[i] = init;
        abc.instanceTraitStart[i] = lists.len("traitName");

        // No class is defined yet while instances are parsed.
        if (!readTraits(abc, lists, r, abc.instanceOwner(i), 0) or !bind(abc, init, abc.instanceOwner(i))) {
            return false;
        }
    }

    abc.instanceInterfaceStart[count] = lists.len("interfaces");
    abc.instanceTraitStart[count] = lists.len("traitName");
    return true;
}

pub fn readClasses(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
    const count = abc.classCount();
    abc.classInit = try lists.zeroed(u32, gpa, abc.classInit, count);
    abc.classTraitStart = try lists.zeroed(u32, gpa, abc.classTraitStart, count + 1);

    for (0..count) |index| {
        const i: u32 = @intCast(index);
        const init = readMethodIndex(abc, r);
        if (init < 0) {
            return false;
        }

        abc.classInit[i] = @intCast(init);
        abc.classTraitStart[i] = lists.len("traitName");

        // Class i's traits may name the classes before it.
        if (!readTraits(abc, lists, r, abc.classOwner(i), i) or !bind(abc, @intCast(init), abc.classOwner(i))) {
            return false;
        }
    }

    abc.classTraitStart[count] = lists.len("traitName");
    return true;
}

pub fn readScripts(gpa: Allocator, abc: *Abc, lists: *Lists, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.scriptInit = try lists.zeroed(u32, gpa, abc.scriptInit, count);
    abc.scriptTraitStart = try lists.zeroed(u32, gpa, abc.scriptTraitStart, count + 1);

    for (0..count) |index| {
        const i: u32 = @intCast(index);
        const init = readMethodIndex(abc, r);
        if (init < 0) {
            return false;
        }

        // Unlike instances and classes, a script checks its init before its traits.
        const method: u32 = @intCast(init);
        if (abc.methodOwner[method] != -1) {
            return abc.fail(C.kAlreadyBoundError);
        }

        abc.scriptInit[i] = method;
        abc.scriptTraitStart[i] = lists.len("traitName");
        if (!readTraits(abc, lists, r, abc.scriptOwner(i), abc.classCount())) {
            return false;
        }

        // A trait may already have bound the init; avmplus ignores that.
        if (abc.methodOwner[method] == -1) {
            abc.methodOwner[method] = abc.scriptOwner(i);
        }
    }

    abc.scriptTraitStart[count] = lists.len("traitName");
    return true;
}

/// A method index, or -1 after recording the error.
fn readMethodIndex(abc: *Abc, r: *Reader) i32 {
    const method = r.u30_();
    if (r.failed) {
        _ = abc.fail(C.kCorruptABCError);
        return -1;
    }

    if (method >= abc.methodCount()) {
        _ = abc.fail(C.kMethodInfoExceedsCountError);
        return -1;
    }

    return @intCast(method);
}

/// Bind an instance or class initializer to its owner.
fn bind(abc: *Abc, method: u32, owner: i32) bool {
    if (abc.methodOwner[method] != -1) {
        return abc.fail(C.kAlreadyBoundError);
    }

    abc.methodOwner[method] = owner;
    return true;
}
