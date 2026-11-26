// instance_info, class_info and script_info, checked like avmplus'
// parseInstanceInfos, parseClassInfos and parseScriptInfos
// (assembly/avm2/abc/classes.ts).
const std = @import("std");
const Allocator = std.mem.Allocator;
const memory = @import("../../memory.zig");
const Abc = @import("abc.zig").Abc;
const C = @import("constants.zig");
const Reader = @import("reader.zig").Reader;
const traits = @import("traits.zig");
const bindingNameError = traits.bindingNameError;
const readTraits = traits.readTraits;

pub fn readInstances(gpa: Allocator, abc: *Abc, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.instanceName = try memory.allocZeroed(gpa, u32, count);
    abc.instanceSuper = try memory.allocZeroed(gpa, u32, count);
    abc.instanceFlags = try memory.allocZeroed(gpa, u8, count);
    abc.instanceProtectedNs = try memory.allocZeroed(gpa, u32, count);
    abc.instanceInterfaceStart = try memory.allocZeroed(gpa, u32, count + 1);
    abc.instanceInit = try memory.allocZeroed(gpa, u32, count);
    abc.instanceTraitStart = try memory.allocZeroed(gpa, u32, count + 1);

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

        abc.instanceInterfaceStart[i] = abc.interfaces.len;
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

            _ = try abc.interfaces.append(gpa, @"type");
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
        abc.instanceTraitStart[i] = abc.traitName.len;

        // No class is defined yet while instances are parsed.
        if (!try readTraits(gpa, abc, r, abc.instanceOwner(i), 0) or !bind(abc, init, abc.instanceOwner(i))) {
            return false;
        }
    }

    abc.instanceInterfaceStart[count] = abc.interfaces.len;
    abc.instanceTraitStart[count] = abc.traitName.len;
    return true;
}

pub fn readClasses(gpa: Allocator, abc: *Abc, r: *Reader) Allocator.Error!bool {
    const count = abc.classCount();
    abc.classInit = try memory.allocZeroed(gpa, u32, count);
    abc.classTraitStart = try memory.allocZeroed(gpa, u32, count + 1);

    for (0..count) |index| {
        const i: u32 = @intCast(index);
        const init = readMethodIndex(abc, r);
        if (init < 0) {
            return false;
        }

        abc.classInit[i] = @intCast(init);
        abc.classTraitStart[i] = abc.traitName.len;

        // Class i's traits may name the classes before it.
        if (!try readTraits(gpa, abc, r, abc.classOwner(i), i) or !bind(abc, @intCast(init), abc.classOwner(i))) {
            return false;
        }
    }

    abc.classTraitStart[count] = abc.traitName.len;
    return true;
}

pub fn readScripts(gpa: Allocator, abc: *Abc, r: *Reader) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    abc.scriptInit = try memory.allocZeroed(gpa, u32, count);
    abc.scriptTraitStart = try memory.allocZeroed(gpa, u32, count + 1);

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
        abc.scriptTraitStart[i] = abc.traitName.len;
        if (!try readTraits(gpa, abc, r, abc.scriptOwner(i), abc.classCount())) {
            return false;
        }

        // A trait may already have bound the init; avmplus ignores that.
        if (abc.methodOwner[method] == -1) {
            abc.methodOwner[method] = abc.scriptOwner(i);
        }
    }

    abc.scriptTraitStart[count] = abc.traitName.len;
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
