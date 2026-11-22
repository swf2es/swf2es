// traits_info, checked like avmplus' parseTraits (assembly/avm2/abc/traits.ts).
// Name clashes, overrides and slot layout (Traits::verifyBindings) need the
// base class, which may live in another ABC, so they are checked when
// classes are linked.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Abc = @import("abc.zig").Abc;
const C = @import("constants.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const Reader = @import("reader.zig").Reader;

/// Read the traits of `owner`. Class traits may only name classes below
/// `classesDefined`: avmplus defines classes one by one while parsing.
pub fn readTraits(gpa: Allocator, abc: *Abc, r: *Reader, owner: i32, classesDefined: u32) Allocator.Error!bool {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return abc.fail(C.kCorruptABCError);
    }

    const first = abc.traitName.len;
    for (0..count) |_| {
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

        _ = try abc.traitMetadataStart.append(gpa, abc.traitMetadata.len);
        if (tag & C.ATTR_Metadata != 0) {
            const metadataCount = r.u30_();
            for (0..metadataCount) |_| {
                const metadata = r.u30_();
                if (r.failed or metadata >= abc.metadataCount()) {
                    return abc.fail(C.kCorruptABCError);
                }

                _ = try abc.traitMetadata.append(gpa, metadata);
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

        _ = try abc.traitName.append(gpa, name);
        _ = try abc.traitTag.append(gpa, tag);
        _ = try abc.traitId.append(gpa, id);
        _ = try abc.traitIndex.append(gpa, index);
        _ = try abc.traitValue.append(gpa, value);
        _ = try abc.traitValueKind.append(gpa, valueKind);
    }

    // As avmplus' makeMethodOf: a method belongs to at most one owner.
    var t = first;
    while (t < abc.traitName.len) : (t += 1) {
        const kind = abc.traitTag.at(t).* & 0x0f;
        if (kind == C.TRAIT_Method or kind == C.TRAIT_Getter or kind == C.TRAIT_Setter) {
            const method = abc.traitIndex.at(t).*;
            if (abc.methodOwner[method] != -1) {
                return abc.fail(C.kCorruptABCError);
            }

            abc.methodOwner[method] = owner;
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
