// traits_info, checked like avmplus' parseTraits.
// Name clashes, overrides and slot layout (Traits::verifyBindings) need the
// base class, which may live in another ABC, so they are checked when
// classes are linked.
const abc_ = @import("abc.zig");
const Abc = abc_.Abc;
const Lists = abc_.Lists;
const errors = @import("errors.zig");
const Diagnostics = errors.Diagnostics;
const Rejected = errors.Rejected;
const C = @import("constants.zig");
const ConstantPool = @import("pool.zig").ConstantPool;
const Reader = @import("reader.zig").Reader;

/// Read the traits of `owner`. Class traits may only name classes below
/// `classesDefined`: avmplus defines classes one by one while parsing.
pub fn readTraits(abc: *Abc, lists: *Lists, r: *Reader, owner: i32, classesDefined: u32, diag: *Diagnostics) Rejected!void {
    const count = r.u30_();
    if (count > r.end - r.pos) {
        return diag.fail(C.kCorruptABCError);
    }

    // As avmplus' makeMethodOf, a method belongs to at most one owner; a
    // method owned already is an error only once every trait has read, as
    // avmplus checks after them all, where a read's error comes first.
    var owned = false;
    for (0..count) |_| {
        const name = r.u30_();
        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        const nameError = bindingNameError(&abc.pool, name, abc.builtin);
        if (nameError != 0) {
            return diag.fail(nameError);
        }

        const tag = r.byteAs(C.TraitTag);
        const kind = tag.kind;
        var id: u32 = 0;
        var index: u32 = 0;
        var value: u32 = 0;
        var valueKind: C.Constant = .none;
        switch (kind) {
            .slot, .constant => {
                id = r.u30_();
                index = r.u30_();
                value = r.u30_();
                if (value != 0) {
                    valueKind = r.byteAs(C.Constant);
                }
            },
            .class, .method, .getter, .setter => {
                id = r.u30_();
                index = r.u30_();
            },
            _ => return diag.fail(if (r.failed) C.kCorruptABCError else C.kUnsupportedTraitsKindError),
        }

        lists.push("traitMetadataStart", lists.len("traitMetadata"));
        if (tag.metadata) {
            const metadataCount = r.u30_();
            for (0..metadataCount) |_| {
                const metadata = r.u30_();
                if (r.failed or metadata >= abc.metadataCount()) {
                    return diag.fail(C.kCorruptABCError);
                }

                lists.push("traitMetadata", metadata);
            }
        }

        if (r.failed) {
            return diag.fail(C.kCorruptABCError);
        }

        if (kind == .class) {
            if (index >= abc.classCount()) {
                return diag.fail(C.kClassInfoExceedsCountError);
            }

            if (index >= classesDefined) {
                return diag.fail(C.kClassInfoOrderError);
            }
        } else if (kind.bindsMethod()) {
            if (index >= abc.methodCount()) {
                return diag.fail(C.kMethodInfoExceedsCountError);
            }
        }

        if (kind.bindsMethod()) {
            if (abc.methodOwner[index] != -1) {
                owned = true;
            } else {
                abc.methodOwner[index] = owner;
            }
        }

        lists.push("traitName", name);
        lists.push("traitTag", tag);
        lists.push("traitId", id);
        lists.push("traitIndex", index);
        lists.push("traitValue", value);
        lists.push("traitValueKind", valueKind);
    }

    if (owned) {
        return diag.fail(C.kCorruptABCError);
    }
}

/// 0 if multiname `index` can name a trait or class: a QName with a namespace
/// and a name, or in a builtin ABC also a Multiname with a name, whose
/// namespaces are the API versions that introduce it. A TypeName stands for
/// its base, as avmplus parses it.
pub fn bindingNameError(pool: *const ConstantPool, index: u32, builtin: bool) i32 {
    if (index == 0 or index >= pool.multinameCount()) {
        return C.kCpoolIndexRangeError;
    }

    return switch (pool.baseName(index)) {
        .qname => |q| if (q.attribute or q.ns == 0 or q.name == 0) C.kCpoolEntryWrongTypeError else 0,
        .multiname => |m| if (builtin and !m.attribute and m.name != 0) 0 else C.kCpoolEntryWrongTypeError,
        else => C.kCpoolEntryWrongTypeError,
    };
}
