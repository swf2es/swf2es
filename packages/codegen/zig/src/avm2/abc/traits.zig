// traits_info, checked like avmplus' parseTraits (assembly/avm2/abc/traits.ts).
// Name clashes, overrides and slot layout (Traits::verifyBindings) need the
// base class, which may live in another ABC, so they are checked when
// classes are linked.
const std = @import("std");
const Allocator = std.mem.Allocator;
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const C = @import("constants.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const Reader = @import("reader.zig").Reader;

/// Read the traits of `owner`. Class traits may only name classes below
/// `classesDefined`: avmplus defines classes one by one while parsing.
pub fn readTraits(abc: *Abc, lists: *Lists, r: *Reader, owner: i32, classesDefined: u32) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    // Each trait's method, where it binds one, for the check after them all.
    const methods = try lists.scratch.alloc(i64, count);
    @memset(methods, -1);
    for (methods) |*method| {
        const name = r.u30_();
        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        const nameError = bindingNameError(&abc.pool, name, abc.builtin);
        if (nameError != 0) {
            return abc.fail(nameError);
        }

        const tag: u8 = @truncate(r.u8_());
        const kind = tag & 0x0f;
        var id: u32 = 0;
        var index: u32 = 0;
        var value: u32 = 0;
        var valueKind: u8 = 0;
        if (kind == C.TRAIT_Slot or kind == C.TRAIT_Const) {
            id = r.u30_();
            index = r.u30_();
            value = r.u30_();
            if (value != 0) {
                valueKind = @truncate(r.u8_());
            }
        } else if (kind == C.TRAIT_Class or kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            id = r.u30_();
            index = r.u30_();
        } else {
            return abc.fail(if (r.failed) C.kCorruptABCError else C.kUnsupportedTraitsKindError);
        }

        lists.push("traitMetadataStart", lists.len("traitMetadata"));
        if (tag & C.ATTR_Metadata != 0) {
            const metadataCount = r.u30_();
            for (0..metadataCount) |_| {
                const metadata = r.u30_();
                if (r.failed or metadata >= abc.metadataCount()) {
                    return abc.fail(C.kCorruptABCError);
                }

                lists.push("traitMetadata", metadata);
            }
        }

        if (r.failed) {
            return abc.fail(C.kCorruptABCError);
        }

        if (kind == C.TRAIT_Class) {
            if (index >= abc.classCount()) {
                return abc.fail(C.kClassInfoExceedsCountError);
            }

            if (index >= classesDefined) {
                return abc.fail(C.kClassInfoOrderError);
            }
        } else if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            if (index >= abc.methodCount()) {
                return abc.fail(C.kMethodInfoExceedsCountError);
            }
        }

        if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            method.* = index;
        }

        lists.push("traitName", name);
        lists.push("traitTag", tag);
        lists.push("traitId", id);
        lists.push("traitIndex", index);
        lists.push("traitValue", value);
        lists.push("traitValueKind", valueKind);
    }

    // As avmplus' makeMethodOf: a method belongs to at most one owner.
    for (methods) |method| {
        if (method >= 0) {
            if (abc.methodOwner[@intCast(method)] != -1) {
                return abc.fail(C.kCorruptABCError);
            }

            abc.methodOwner[@intCast(method)] = owner;
        }
    }

    return true;
}

/// 0 if multiname `index` can name a trait or class: a QName with a namespace
/// and a name, or in a builtin ABC also a Multiname with a name, whose
/// namespaces are the API versions that introduce it. A TypeName stands for
/// its base, as avmplus parses it.
pub fn bindingNameError(pool: *const ConstantPool, index: u32, builtin: bool) i32 {
    if (index == 0 or index >= pool.multinameCount()) {
        return C.kCpoolIndexRangeError;
    }

    var mn = index;
    if (pool.mnKind[mn] == C.CONSTANT_TypeName) {
        mn = pool.mnA[mn];
    }

    const kind = pool.mnKind[mn];
    if (builtin and kind == C.CONSTANT_Multiname and pool.mnB[mn] != 0) {
        return 0;
    }

    if (kind != C.CONSTANT_Qname or pool.mnA[mn] == 0 or pool.mnB[mn] == 0) {
        return C.kCpoolEntryWrongTypeError;
    }

    return 0;
}
