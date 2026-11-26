// The instructions of the object model, as the method emitter writes them
// (assembly/avm2/emit/objects.ts, whose comments tell each case's why):
// scopes, names, slots and properties, calls, and creating objects,
// functions and classes; domain memory, and XML's. And what each notes of
// the default XML namespace, which a method that can see it checks on entry
// (see MethodEmitter.checkEntry).
const std = @import("std");
const Error = std.mem.Allocator.Error;
const C = @import("../abc/constants.zig");
const ops = @import("../abc/opcodes.zig");
const ir_ = @import("../ir/ir.zig");
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../link/traits.zig");
const copies = @import("copies.zig");
const CONSTANT = copies.CONSTANT;
const NONE = copies.NONE;
const memory = @import("memory.zig");
const method_ = @import("method.zig");
const MethodEmitter = method_.MethodEmitter;
const hasBoundEntry = method_.hasBoundEntry;
const refs = @import("refs.zig");
const values = @import("values.zig");
const CONVERTS = values.CONVERTS;

fn u(r: i32) usize {
    return @intCast(r);
}

/// Whether register r may hold XML or an XMLList: untyped, Object, or either.
fn mayBeXml(em: *const MethodEmitter, r: i32) bool {
    const ty = em.regType[u(r)];
    const bt = em.domain.builtin(ty);
    return bt == traits_.BUILTIN_Any or
        bt == traits_.BUILTIN_Object or
        ty == em.domain.xmlType or
        ty == em.domain.xmlListType;
}

/// Note whether instruction i, `op` on register `src`, can see the default
/// XML namespace (objects.ts tells which can).
fn notesDxns(em: *MethodEmitter, op: u16, src: i32) void {
    switch (op) {
        ops.OP_getproperty, ops.OP_setproperty, ops.OP_initproperty, ops.OP_deleteproperty, ops.OP_getdescendants => {
            if (mayBeXml(em, src)) {
                em.seesDxns = true;
            }
        },
        ops.OP_in => {
            if (mayBeXml(em, src + 1)) {
                em.seesDxns = true;
            }
        },
        ops.OP_call => {
            if (mayBeXml(em, src) or em.regType[u(src)] == em.domain.classType) {
                em.seesDxns = true;
            }
        },
        ops.OP_callproperty,
        ops.OP_callproplex,
        ops.OP_callpropvoid,
        ops.OP_constructprop,
        ir_.IR_ConstructSlot,
        ops.OP_construct,
        ops.OP_newfunction,
        ops.OP_newclass,
        ops.OP_pushwith,
        ops.OP_dxns,
        ops.OP_dxnslate,
        => em.seesDxns = true,
        else => {},
    }
}

/// The instructions of the object model: scopes, names, properties, calls,
/// and creating objects, functions and classes; false for one it does not
/// know, which then calls rt.unsupported.
pub fn object(em: *MethodEmitter, i: u32, op: u16) Error!bool {
    const out = &em.out;
    const ir = em.ir;
    const a = ir.a[i];
    const src = ir.src[i];
    if (!em.seesDxns) {
        notesDxns(em, op, src);
    }

    switch (op) {
        ops.OP_pushscope, ops.OP_pushwith => {
            em.scopeWith[em.scopeDepth] = if (op == ops.OP_pushwith) 1 else 0;
            em.scopeDepth += 1;
            if (em.copies_(i, src)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(src);
        },
        ops.OP_popscope => {
            em.scopeDepth -%= 1;
            try em.reset(src);
        },
        ops.OP_getscopeobject => {
            if (em.copies_(i, src)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(src);
        },
        ops.OP_getouterscope => {
            try em.assign(i, false);
            try out.text("scope[");
            em.usesScope = true;
            try out.uint(a);
            try out.text("]");
        },
        ops.OP_getglobalscope, ir_.IR_GetGlobalScope => {
            if (ir.outerSize == 0 and em.copies_(i, @intCast(ir.localCount))) {
                return true;
            }

            try em.assign(i, false);
            try globalScope(em);
        },
        ops.OP_finddef => {
            // The name keeps its script's global object once found, so a static
            // read in a loop costs a load and no call.
            try em.assign(i, false);
            try out.text("M[");
            try out.uint(a);
            try out.text("].global ?? rt.findDef(M[");
            try out.uint(a);
            try out.text("])");
        },
        ir_.IR_FindPropGlobal, ir_.IR_FindPropGlobalStrict => {
            const strict = op == ir_.IR_FindPropGlobalStrict;
            try em.assign(i, false);
            if (ir.c[i] > 0) {
                // The local scopes from c - 1 first, by what each is at run time.
                try out.text(if (strict) "rt.findLocalStrict(M[" else "rt.findLocal(M[");
                try out.uint(a);
                try out.text("], [");
                const first: u32 = @as(u32, @intCast(ir.c[i])) - 1;
                var d = first;
                while (d < em.scopeDepth) : (d += 1) {
                    if (d > first) {
                        try out.text(", ");
                    }

                    try em.reg(@intCast(ir.localCount + d));
                }

                try out.text("], ");
                try globalScope(em);
                try out.text(")");
                return true;
            }

            // Not found statically: a script's name, or else the global object's.
            try out.text("M[");
            try out.uint(a);
            try out.text("].global ?? ");
            try out.text(if (strict) "rt.findGlobalStrict(M[" else "rt.findGlobal(M[");
            try out.uint(a);
            try out.text("], ");
            try globalScope(em);
            try out.text(")");
        },
        ops.OP_findproperty, ops.OP_findpropstrict => {
            try em.assign(i, false);
            try out.text(if (op == ops.OP_findpropstrict) "rt.findPropertyStrict(" else "rt.findProperty(");
            try name(em, a, src);
            try out.text(", scope, ");
            em.usesScope = true;
            try localScopes(em);
            try out.text(")");
        },
        ops.OP_getslot => {
            try em.assign(i, false);
            try em.member(src);
            try refs.slotMember(out, a);
        },
        ops.OP_setslot => {
            try em.member(src);
            try refs.slotMember(out, a);
            try out.text(" = ");
            try em.reg(src + 1);
        },
        ops.OP_getglobalslot => {
            try em.assign(i, false);
            try globalScope(em);
            try refs.slotMember(out, a);
        },
        ops.OP_setglobalslot => {
            try globalScope(em);
            try refs.slotMember(out, a);
            try out.text(" = ");
            try em.reg(src);
        },
        ir_.IR_CallGetter => {
            try em.assign(i, false);
            if (try vectorLength(em, src, ir.c[i])) {
                try receiver(em, src);
                try out.text(".$a.length");
                return true;
            }

            if (stringLength(em, src, ir.c[i])) {
                try receiver(em, src);
                try out.text(".length");
                return true;
            }

            try virtual(em, a, src, 0, -1);
        },
        ir_.IR_CallSetter => try virtual(em, a, src, 1, ir.c[i]),
        ops.OP_callmethod => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try virtual(em, a, src, ir.b[i], ir.c[i]);
        },
        ir_.IR_CallInterface => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            if (ir.b[i] <= em.domain.traits.paramCount.get(@intCast(ir.c[i]))) {
                try interfaceCall(em, a, src, ir.b[i]);
                return true;
            }

            // More arguments than the method declares, which its rest takes:
            // by name, as the class's method, which may have none, counts them.
            try out.text("rt.callInterface(");
            try refs.typeRef(em, em.regType[u(src)]);
            try out.text(", ");
            try out.uint(a);
            try out.text(", ");
            try em.reg(src);
            try args(em, src + 1, ir.b[i]);
            try out.text(")");
        },
        ir_.IR_Nip => {
            const top = src + @as(i32, @intCast(ir.srcCount[i])) - 1;
            if (em.copies_(i, top)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(top);
        },
        ops.OP_getproperty => try getProperty(em, i, a, src),
        ops.OP_setproperty => try setProperty(em, i, a, src),
        ops.OP_initproperty => {
            try out.text("rt.initProperty(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(", ");
            try em.reg(src + @as(i32, @intCast(ir.srcCount[i])) - 1);
            try out.text(")");
        },
        ops.OP_deleteproperty => {
            try em.assign(i, false);
            try out.text("rt.deleteProperty(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(")");
        },
        ops.OP_in => {
            try em.assign(i, false);
            // `name in object`.
            try values.call2(em, "rt.in(", i);
        },
        ops.OP_callproperty, ops.OP_callproplex, ops.OP_callpropvoid, ops.OP_constructprop => {
            const argc = ir.b[i];
            const parts = ir.srcCount[i] - 1 - argc;
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try out.text(switch (op) {
                ops.OP_constructprop => "rt.constructProperty(",
                ops.OP_callproplex => "rt.callPropLex(",
                else => "rt.callProperty(",
            });
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try args(em, src + 1 + @as(i32, @intCast(parts)), argc);
            try out.text(")");
        },
        ops.OP_callsuper, ops.OP_callsupervoid, ops.OP_getsuper, ops.OP_setsuper => {
            const argc: u32 = switch (op) {
                ops.OP_getsuper => 0,
                ops.OP_setsuper => 1,
                else => ir.b[i],
            };
            const parts = ir.srcCount[i] - 1 - argc;
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try out.text(switch (op) {
                ops.OP_getsuper => "rt.getSuper(sup, ",
                ops.OP_setsuper => "rt.setSuper(sup, ",
                else => "rt.callSuper(sup, ",
            });
            em.usesSup = true;
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try args(em, src + 1 + @as(i32, @intCast(parts)), argc);
            try out.text(")");
        },
        ir_.IR_CallSuper => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            // The base's method itself, its arguments coerced already: its entry
            // for bound calls, where it has one.
            try out.text("sup.$it.proto.");
            try out.text(if (hasBoundEntry(em, @bitCast(ir.c[i]))) "$b" else "$m");
            try out.uint(a);
            try out.text(".call(");
            em.usesSup = true;
            try em.reg(src);
            try args(em, src + 1, ir.b[i]);
            try out.text(")");
        },
        ops.OP_constructsuper => {
            // As rt.constructSuper, without an array of the arguments to apply;
            // the verifier coerced them to the base's constructor, so they may
            // go to its entry for bound calls.
            try out.text(superEntry(em, ir.c[i]));
            em.usesSup = true;
            try em.reg(src);
            try args(em, src + 1, a);
            try out.text(")");
        },
        ops.OP_construct => {
            try em.assign(i, false);
            try out.text("rt.construct(");
            try em.reg(src);
            try args(em, src + 1, a);
            try out.text(")");
        },
        ir_.IR_ConstructSlot => {
            try em.assign(i, false);
            try constructSlot(em, src, a, ir.b[i], ir.c[i]);
        },
        ops.OP_call => {
            try em.assign(i, false);
            try out.text("rt.call(");
            try em.reg(src);
            try out.text(", ");
            try em.reg(src + 1);
            try args(em, src + 2, a);
            try out.text(")");
        },
        ops.OP_callstatic => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            // By its factory, which the runtime keeps the first method it made of.
            try out.text("rt.callStatic(F[");
            try out.uint(a);
            try out.text("], ");
            try em.reg(src);
            try args(em, src + 1, ir.b[i]);
            try out.text(")");
        },
        ops.OP_newfunction => {
            try em.assign(i, false);
            try out.text("rt.newFunction(F[");
            try out.uint(a);
            try out.text("], ");
            try functionScope(em, a);
            // Its method's id, as avmplus writes a function as [object Function-id].
            try out.text(", ");
            try out.uint(a);
            try out.text(")");
        },
        ops.OP_newclass => {
            try em.assign(i, false);
            try out.text("rt.newClass(A.classes[");
            try out.uint(a);
            try out.text("], ");
            try em.reg(src);
            try out.text(", ");
            try scopeHere(em);
            try out.text(")");
        },
        ops.OP_newactivation => {
            try em.assign(i, false);
            try out.text("rt.newActivation(A.activations[");
            try out.int(em.body);
            try out.text("])");
        },
        ops.OP_newcatch => {
            const abc = em.abc;
            const h = abc.bodyExceptionStart[@intCast(em.body)] + a;
            try em.assign(i, false);
            try out.text("rt.newCatch(M[");
            try out.uint(abc.exceptionName[h]);
            try out.text("])");
        },
        ops.OP_newobject, ops.OP_newarray => {
            try em.assign(i, false);
            try out.text(if (op == ops.OP_newobject) "rt.newObject([" else "rt.newArray([");
            try list(em, src, ir.srcCount[i]);
            try out.text("])");
        },
        ops.OP_applytype => {
            try em.assign(i, false);
            try out.text("rt.applyType(");
            try em.reg(src);
            try out.text(", [");
            try list(em, src + 1, a);
            try out.text("])");
        },
        ops.OP_hasnext2 => {
            // hasnext2 updates its two locals, which the runtime leaves in two
            // fields; taking them apart from an array would cost more than the step.
            const b = ir.b[i];
            try em.regName(ir.dst[i]);
            try out.text(" = rt.hasNextIn(");
            try em.reg(@bitCast(a));
            try out.text(", ");
            try em.reg(@bitCast(b));
            try out.text("), ");
            try em.regName(@bitCast(a));
            try out.text(" = rt.enumObject, ");
            try em.regName(@bitCast(b));
            try out.text(" = rt.enumIndex");
        },
        ops.OP_hasnext, ops.OP_nextname, ops.OP_nextvalue, ops.OP_instanceof, ops.OP_istypelate, ops.OP_astypelate => {
            try em.assign(i, false);
            try values.call2(em, switch (op) {
                ops.OP_hasnext => "rt.hasNext(",
                ops.OP_nextname => "rt.nextName(",
                ops.OP_nextvalue => "rt.nextValue(",
                ops.OP_instanceof => "rt.instanceOf(",
                ops.OP_istypelate => "rt.isTypeLate(",
                else => "rt.asTypeLate(",
            }, i);
        },
        ops.OP_istype, ops.OP_astype => {
            try em.assign(i, false);
            try out.text(if (op == ops.OP_istype) "rt.isType(" else "rt.asType(");
            try em.reg(src);
            try out.text(", M[");
            try out.uint(a);
            try out.text("])");
        },
        // Domain memory: in place at an int or uint address, else through
        // the runtime (objects.ts tells why); sign extensions in plain JavaScript.
        ops.OP_li8, ops.OP_li16, ops.OP_li32, ops.OP_lf32, ops.OP_lf64 => {
            try em.assign(i, false);
            if (memory.isAddress(em, src)) {
                em.inPlaceMemory = true;
                try out.text("rt.view.");
                try out.text(memory.viewMethod(op));
                try out.text("(");
                try em.reg(src);
                try out.text(if (op == ops.OP_li8) ")" else ", true)");
                return true;
            }

            try out.text("rt.");
            try out.text(ops.opcodeNames[op]);
            try out.text("(");
            try em.reg(src);
            try out.text(")");
        },
        ops.OP_si8, ops.OP_si16, ops.OP_si32, ops.OP_sf32, ops.OP_sf64 => {
            // The value's conversion is DataView's own for a number or Boolean,
            // which has no effect to come before the range check.
            if (memory.isAddress(em, src + 1) and values.isNumeric(em, src)) {
                em.inPlaceMemory = true;
                try out.text("rt.view.");
                try out.text(memory.viewMethod(op));
                try out.text("(");
                try em.reg(src + 1);
                try out.text(", ");
                try em.reg(src);
                try out.text(if (op == ops.OP_si8) ")" else ", true)");
                return true;
            }

            try out.text("rt.");
            try out.text(ops.opcodeNames[op]);
            try out.text("(");
            try em.reg(src);
            try out.text(", ");
            try em.reg(src + 1);
            try out.text(")");
        },
        ops.OP_sxi1, ops.OP_sxi8, ops.OP_sxi16 => {
            try em.assign(i, false);
            try out.text("(");
            try em.reg(src);
            try out.text(switch (op) {
                ops.OP_sxi1 => " << 31) >> 31",
                ops.OP_sxi8 => " << 24) >> 24",
                else => " << 16) >> 16",
            });
        },
        ops.OP_getdescendants => {
            try em.assign(i, false);
            try out.text("rt.getDescendants(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(")");
        },
        ops.OP_dxns => {
            try out.text("rt.setDefaultXmlNamespace(");
            try refs.poolString(em, a);
            try out.text(")");
        },
        ops.OP_dxnslate, ops.OP_checkfilter => {
            try out.text(if (op == ops.OP_dxnslate) "rt.setDefaultXmlNamespace(" else "rt.checkFilter(");
            try em.reg(src);
            try out.text(")");
        },
        ops.OP_esc_xelem, ops.OP_esc_xattr => {
            try em.assign(i, false);
            try out.text(if (op == ops.OP_esc_xelem) "rt.escapeElement(" else "rt.escapeAttribute(");
            try em.reg(src);
            try out.text(")");
        },
        else => return false,
    }

    return true;
}

fn getProperty(em: *MethodEmitter, i: u32, a: u32, src: i32) Error!void {
    const out = &em.out;
    if (interpretedKey(em, a, src + 1)) {
        try em.assign(i, false);
        try out.text("rt.getInterpreted(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        return;
    }

    if (indexed(em, a, src + 1)) {
        // As avmplus' getUintProperty: an element by its number, of a
        // Vector by the kind of its elements where the IR knows it.
        const kind = try vectorKind(em, em.regType[u(src)]);
        const float = kind == .Float;
        try em.assign(i, float);
        const box = float and !em.unboxedTarget(i);
        if (box) {
            try out.text("rt.float(");
        }

        // An Array's element, or a Vector's, read in place, so that each
        // site keeps its own feedback in the engine (objects.ts tells what
        // goes to the helper).
        if (try arrayElements(em, a, src) or vectorElements(em, a, kind)) {
            try receiver(em, src);
            try out.text(".$a[");
            try em.reg(src + 1);
            try out.text("] ?? ");
        }

        if (kind != .none) {
            try out.text("rt.vectorGet");
            try out.text(@tagName(kind));
            try out.text("(");
        } else {
            try out.text("rt.getIndexed(");
        }

        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        if (box) {
            try out.text(")");
        }

        return;
    }

    const guarded = maybeStringLength(em, a, src);
    if (guarded) {
        // Read twice, so from its register, not from a text held for it.
        const copy = em.copyOf[u(src)];
        const r = if (copy == NONE) src else copy;
        if (r >= 0) {
            try em.release(r);
        }
    }

    try em.assign(i, false);
    if (keyed(em, a, src + 1)) {
        try out.text("rt.getKeyed(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(")");
        return;
    }

    if (guarded) {
        try out.text("typeof ");
        try em.read(src);
        try out.text(" === \"string\" ? ");
        try em.read(src);
        try out.text(".length : ");
    }

    try out.text("rt.getProperty(");
    try em.reg(src);
    try out.text(", ");
    try name(em, a, src + 1);
    try out.text(")");
}

fn setProperty(em: *MethodEmitter, i: u32, a: u32, src: i32) Error!void {
    const out = &em.out;
    const ir = em.ir;
    if (interpretedKey(em, a, src + 1)) {
        try out.text("rt.setInterpreted(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        try em.reg(src + 2);
        try out.text(")");
        return;
    }

    if (indexed(em, a, src + 1)) {
        const kind = try vectorKind(em, em.regType[u(src)]);
        // An Array's element below its length, or a Vector's converted to
        // its element type where that runs no AS3, written in place; the
        // rest goes to the helper (objects.ts tells why).
        const array = try arrayElements(em, a, src);
        const element = if (array or !vectorElements(em, a, kind)) CONVERTS else try storedType(em, kind, src);
        if (array or element != CONVERTS) {
            const index = em.builtinOf(src + 1);
            try out.text("if (");
            try receiver(em, src);
            try out.text(".$a.length > ");
            try em.reg(src + 1);
            if (index == traits_.BUILTIN_Int) {
                try out.text(" && ");
                try em.reg(src + 1);
                try out.text(" >= 0");
            } else if (index != traits_.BUILTIN_Uint) {
                try out.text(" && ");
                try em.reg(src + 1);
                try out.text(" >>> 0 === ");
                try em.reg(src + 1);
            }

            try out.text(") ");
            try em.reg(src);
            try out.text(".$a[");
            try em.reg(src + 1);
            try out.text("] = ");
            if (array) {
                try em.reg(src + 2);
            } else {
                try values.convert(em, "", src + 2, element, em.regType[u(src + 2)], false);
            }

            try out.text("; else ");
        }

        if (kind != .none) {
            try out.text("rt.vectorSet");
            try out.text(@tagName(kind));
            try out.text("(");
        } else {
            try out.text("rt.setIndexed(");
        }

        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        if (kind == .Float) {
            try em.numberReg(src + 2);
        } else {
            try em.reg(src + 2);
        }

        try out.text(")");
        return;
    }

    if (keyed(em, a, src + 1)) {
        try out.text("rt.setKeyed(");
        try em.reg(src);
        try out.text(", M[");
        try out.uint(a);
        try out.text("], ");
        try em.reg(src + 1);
        try out.text(", ");
        try em.reg(src + 2);
        try out.text(")");
        return;
    }

    try out.text("rt.setProperty(");
    try em.reg(src);
    try out.text(", ");
    try name(em, a, src + 1);
    try out.text(", ");
    try em.reg(src + @as(i32, @intCast(ir.srcCount[i])) - 1);
    try out.text(")");
}

/// The method's global object: its scope chain's first, else its own first scope.
fn globalScope(em: *MethodEmitter) Error!void {
    if (em.ir.outerSize > 0) {
        try em.out.text("scope[0]");
        em.usesScope = true;
    } else {
        try em.reg(@intCast(em.ir.localCount));
    }
}

/// The scopes pushed so far, innermost last: [sc0, ...], with their with flags.
fn localScopes(em: *MethodEmitter) Error!void {
    const out = &em.out;
    try out.text("[");
    var withs: u32 = 0;
    for (0..em.scopeDepth) |d| {
        if (d != 0) {
            try out.text(", ");
        }

        try em.reg(@intCast(em.ir.localCount + d));
        // As AssemblyScript's u32 shift, whose count wraps at 32.
        withs |= @as(u32, em.scopeWith[d]) << @truncate(d);
    }

    try out.text("], ");
    try out.uint(withs);
}

/// The scope chain function `m` of the ABC, created here, runs in; for a
/// contested function, packed as it was compiled (Scope.merged).
fn functionScope(em: *MethodEmitter, m: u32) Error!void {
    const traits = &em.domain.traits;
    const g = em.domain.methodStart.get(em.index) + m;
    const merged = if (traits.functionContested.get(g) != 0) traits.functionMerged.get(g) else null;
    if (merged == null or merged.?.pack < 0) {
        return scopeHere(em);
    }

    try em.out.text("rt.packScope(");
    try scopeHere(em);
    try em.out.text(", ");
    try em.out.uint(@intCast(merged.?.pack));
    try em.out.text(")");
}

/// The scope chain a function or class created here runs in.
fn scopeHere(em: *MethodEmitter) Error!void {
    try em.out.text("rt.scope(scope, ");
    em.usesScope = true;
    try localScopes(em);
    try em.out.text(")");
}

/// Multiname `a`: M[a], or with its runtime namespace and name taken from
/// the registers from `from`.
fn name(em: *MethodEmitter, a: u32, from: i32) Error!void {
    const out = &em.out;
    const kind = em.abc.pool.mnKind[a];
    const parts: i32 = switch (kind) {
        C.CONSTANT_RTQnameL, C.CONSTANT_RTQnameLA => 2,
        C.CONSTANT_RTQname, C.CONSTANT_RTQnameA, C.CONSTANT_MultinameL, C.CONSTANT_MultinameLA => 1,
        else => 0,
    };
    if (parts == 0) {
        try out.text("M[");
        try out.uint(a);
        try out.text("]");
        return;
    }

    // The name of a string the code holds is the same each time: made once, in T.
    const copy = em.copyOf[u(from)];
    if ((kind == C.CONSTANT_MultinameL or kind == C.CONSTANT_MultinameLA) and
        from != em.pendingNull and
        copy <= CONSTANT and
        em.ir.op[u(CONSTANT - copy)] == ops.OP_pushstring)
    {
        try out.text("T[");
        try out.uint(try em.literalSlot(a, em.ir.a[u(CONSTANT - copy)]));
        try out.text("]");
        return;
    }

    try out.text("rt.runtimeName(M[");
    try out.uint(a);
    try out.text("]");
    var k: i32 = 0;
    while (k < parts) : (k += 1) {
        try out.text(", ");
        try em.reg(from + k);
    }

    try out.text(")");
}

/// The kind of a Vector's elements, as the runtime's vectorGet and
/// vectorSet name it; none if not a Vector's.
const Kind = enum { none, Int, Uint, Double, Float, Object };

/// The kind of Vector type t's elements.
fn vectorKind(em: *MethodEmitter, t: i32) Error!Kind {
    const domain = em.domain;
    if (t < 0) {
        return .none;
    }

    if (t == domain.vectorIntType) {
        return .Int;
    }

    if (t == domain.vectorUintType) {
        return .Uint;
    }

    if (t == domain.vectorDoubleType) {
        return .Double;
    }

    if (domain.floatType >= 0 and domain.traits.param.get(@intCast(t)) == domain.floatType) {
        return .Float;
    }

    const object_ = domain.vectorObjectType >= 0 and
        try domain.traits.subtypeOf(em.gpa, @intCast(t), @intCast(domain.vectorObjectType));
    return if (object_) .Object else .none;
}

/// Whether `getter` on register r reads a Vector's length, which is its
/// elements': the Vector classes are final, and of their getters, length
/// alone gives a uint (fixed a Boolean).
fn vectorLength(em: *MethodEmitter, r: i32, getter: i32) Error!bool {
    return getter >= 0 and
        try vectorKind(em, em.regType[u(r)]) != .none and
        em.domain.traits.returnType.get(@intCast(getter)) == em.domain.uintType;
}

/// The namespace of the builtins' methods that a prototype's function cannot replace.
const AS3_URI = "http://adobe.com/AS3/2006/builtin";

/// Whether the domain's string `id` is `text`, which is ASCII.
fn stringIs(domain: *const Domain, id: u32, text: []const u8) bool {
    return domain.stringLength.get(id) == text.len and std.mem.eql(u8, domain.stringOf(id), text);
}

/// The string's own method, `.charAt(` or `.charCodeAt(`, where the call by
/// dispatch id `disp` on the String in register `src` is of AS3::charAt or
/// AS3::charCodeAt with no argument or a number; else "" (objects.ts tells why).
fn stringMethod(em: *MethodEmitter, ty: i32, disp: u32, src: i32, argc: u32) []const u8 {
    const domain = em.domain;
    if (ty != domain.stringType or argc > 1 or (argc == 1 and !values.isNumber(em, src + 1))) {
        return "";
    }

    const m = refs.aliasedMember(domain, @intCast(ty), disp);
    if (m < 0) {
        return "";
    }

    const traits = &domain.traits;
    const uri = domain.nsUri.get(traits.memberNs.get(@intCast(m)));
    if (uri == domain_.URI_None or !stringIs(domain, uri, AS3_URI)) {
        return "";
    }

    const member = traits.memberName.get(@intCast(m));
    if (stringIs(domain, member, "charAt")) {
        return ".charAt(";
    }

    return if (stringIs(domain, member, "charCodeAt")) ".charCodeAt(" else "";
}

/// Whether `getter` on register r reads a String's length, which is its
/// string's: String is final and has no other getter.
fn stringLength(em: *MethodEmitter, r: i32, getter: i32) bool {
    return getter >= 0 and
        em.builtinOf(r) == traits_.BUILTIN_String and
        em.domain.traits.returnType.get(@intCast(getter)) == em.domain.intType;
}

/// Whether the get of multiname `a` on register r may read a string's
/// length: a name `length` that is no attribute's, public or with a public
/// namespace in its set, on a value typed * or Object (objects.ts tells why).
fn maybeStringLength(em: *MethodEmitter, a: u32, r: i32) bool {
    const bt = em.builtinOf(r);
    if (bt != traits_.BUILTIN_Any and bt != traits_.BUILTIN_Object) {
        return false;
    }

    const domain = em.domain;
    const pool = &em.abc.pool;
    const kind = pool.mnKind[a];
    if (kind == C.CONSTANT_Qname) {
        const ns = domain.abcNs.get(em.index)[pool.mnA[a]];
        const uri = domain.nsUri.get(ns);
        if (domain.nsType.get(ns) != domain_.NS_Public or (uri != domain_.URI_None and domain.stringLength.get(uri) != 0)) {
            return false;
        }
    } else if (kind != C.CONSTANT_Multiname or !domain.hasPublicNamespace(em.index, a)) {
        return false;
    }

    const length = domain.findText("length");
    return length >= 0 and domain.abcString.get(em.index)[pool.mnB[a]] == @as(u32, @intCast(length));
}

/// Whether the indexed access by multiname `a` on a Vector of `kind` reads
/// its elements, as the runtime's vectorGet and vectorSet do: a public
/// namespace in the set, and elements in an Array, which a float Vector's
/// are not.
fn vectorElements(em: *MethodEmitter, a: u32, kind: Kind) bool {
    return kind != .none and kind != .Float and em.domain.hasPublicNamespace(em.index, a);
}

/// The element type the value in register src + 2 converts to when it is
/// written into the Vector of `kind` in register `src`, where the
/// conversion runs no AS3; else CONVERTS (objects.ts tells why).
fn storedType(em: *MethodEmitter, kind: Kind, src: i32) Error!i32 {
    const domain = em.domain;
    const t = em.regType[u(src)];
    const ty: i32 = switch (kind) {
        .Int => domain.intType,
        .Uint => domain.uintType,
        .Double => domain.numberType,
        .Object => if (t != domain.vectorObjectType) domain.traits.param.get(@intCast(t)) else CONVERTS,
        else => CONVERTS,
    };

    const from = em.regType[u(src + 2)];
    const fromBt = domain.builtin(from);
    if (ty == CONVERTS or fromBt == traits_.BUILTIN_Float) {
        return CONVERTS;
    }

    const numeric = fromBt == traits_.BUILTIN_Int or fromBt == traits_.BUILTIN_Uint or fromBt == traits_.BUILTIN_Number;
    return switch (domain.builtin(ty)) {
        traits_.BUILTIN_Int, traits_.BUILTIN_Uint => if (numeric or fromBt == traits_.BUILTIN_Boolean) ty else CONVERTS,
        traits_.BUILTIN_Number => if (numeric) ty else CONVERTS,
        traits_.BUILTIN_Boolean, traits_.BUILTIN_Object => ty,
        traits_.BUILTIN_String => if (try values.keeps(em, ty, from)) ty else CONVERTS,
        // A class's instances: an instance check, which throws as the helper would.
        else => if (refs.isClassRef(em, ty)) ty else CONVERTS,
    };
}

/// Whether getproperty or setproperty by multiname `a`, a runtime name
/// alone, takes the key in register r as avmplus' interpreter does in a
/// script's or a class's initializer (rt.getInterpreted).
fn interpretedKey(em: *MethodEmitter, a: u32, r: i32) bool {
    const kind = em.abc.pool.mnKind[a];
    return em.staticInit and
        (kind == C.CONSTANT_MultinameLA or
            (kind == C.CONSTANT_MultinameL and !em.domain.hasPublicNamespace(em.index, a))) and
        em.builtinOf(r) != traits_.BUILTIN_String;
}

/// Whether multiname `a` is a runtime name alone, not an attribute, whose
/// name in register r is a number: an element's index.
fn indexed(em: *MethodEmitter, a: u32, r: i32) bool {
    return em.abc.pool.mnKind[a] == C.CONSTANT_MultinameL and values.isNumber(em, r);
}

/// Whether multiname `a` is a runtime name alone, not an attribute, whose
/// name in register r is of a type that tells nothing of what it is at run
/// time, outside an initializer avmplus interprets (objects.ts tells why).
fn keyed(em: *MethodEmitter, a: u32, r: i32) bool {
    return !em.staticInit and
        em.abc.pool.mnKind[a] == C.CONSTANT_MultinameL and
        !values.isNumber(em, r) and
        em.builtinOf(r) != traits_.BUILTIN_String;
}

/// Whether the indexed access by multiname `a` on register r reads an
/// Array's elements, as getIndexed and setIndexed do: r an Array, or of a
/// class that extends it, and a public namespace in the set.
fn arrayElements(em: *MethodEmitter, a: u32, r: i32) Error!bool {
    const domain = em.domain;
    const t = em.regType[u(r)];
    return t >= 0 and
        domain.arrayType >= 0 and
        try domain.traits.subtypeOf(em.gpa, @intCast(t), @intCast(domain.arrayType)) and
        domain.hasPublicNamespace(em.index, a);
}

/// Register r read before a `.`, null checked unless it is known not to
/// be null here: `(r ?? nn(r))` or `r`.
fn receiver(em: *MethodEmitter, r: i32) Error!void {
    const copy = em.copyOf[u(r)];
    const checked = if (copy == NONE) r else copy;
    if (r != em.pendingNull and checked >= 0 and em.checked[u(checked)] != 0) {
        return em.read(r);
    }

    try em.out.byte('(');
    if (r == em.pendingNull) {
        try em.reg(r);
    } else {
        try em.checkedRead(r);
        if (checked >= 0) {
            em.checked[u(checked)] = 1;
        }
    }

    try em.out.byte(')');
}

/// `new` of what slot `slot` of register `src` holds, with `argc`
/// arguments after it: in place where the runtime marked the class as one
/// constructClass would only allocate and initialize (`$new`); anything
/// else by rt.construct (objects.ts tells why).
fn constructSlot(em: *MethodEmitter, src: i32, slot: u32, argc: u32, ctraits: i32) Error!void {
    const out = &em.out;
    em.constructsInPlace = true;
    try out.text("($c = ");
    try em.member(src);
    try refs.slotMember(out, slot);
    try out.text(")?.$new === true ? ($o = $c.$it.instance(), $c.$it.proto.");
    const init = boundConstructor(em, ctraits, argc);
    if (init >= 0) {
        // As avmplus' JIT, which coerces a known constructor's arguments at
        // the call site and calls it: its entry for bound calls.
        try out.text("$binit.call($o");
        const traits = &em.domain.traits;
        const start = traits.paramStart.get(@intCast(init));
        for (0..argc) |k| {
            const r = src + 1 + @as(i32, @intCast(k));
            try out.text(", ");
            try values.convert(em, "", r, traits.paramType.get(start + @as(u32, @intCast(k))), em.regType[u(r)], false);
        }
    } else {
        try out.text("$init.call($o");
        try args(em, src + 1, argc);
    }

    // A slot still empty is a null constructor: avmplus' JIT, which binds a
    // known constructor that takes the count, checks it first (1009); its
    // interpreter, which runs static initializers, constructs late (1007).
    try out.text(if (!em.staticInit and knownConstructor(em, ctraits, argc) >= 0)
        "), $o) : rt.construct($c ?? nn($c)"
    else
        "), $o) : rt.construct($c");
    try args(em, src + 1, argc);
    try out.text(")");
}

/// How `super()` calls the constructor of `base`: by its entry for bound
/// calls, if it has one.
fn superEntry(em: *MethodEmitter, base: i32) []const u8 {
    const init = if (base >= 0) em.domain.traits.init.get(@intCast(base)) else -1;
    return if (init >= 0 and hasBoundEntry(em, @intCast(init)))
        "sup.$it.proto.$binit.call("
    else
        "sup.$it.proto.$init.call(";
}

/// The instance initializer of the class whose class traits are
/// `ctraits`, where `new` of it with `argc` arguments can call its entry
/// for bound calls with them coerced; else -1.
fn boundConstructor(em: *MethodEmitter, ctraits: i32, argc: u32) i32 {
    const init = knownConstructor(em, ctraits, argc);
    return if (init >= 0 and hasBoundEntry(em, @intCast(init))) init else -1;
}

/// The instance initializer, domain-wide, of the class whose class traits
/// are `ctraits`, where avmplus' JIT binds `new` of it with `argc`
/// arguments; else -1.
fn knownConstructor(em: *MethodEmitter, ctraits: i32, argc: u32) i32 {
    const domain = em.domain;
    const traits = &domain.traits;
    const itraits = domain.instanceTraitsOf(ctraits);
    const init = if (itraits >= 0) traits.init.get(@intCast(itraits)) else -1;
    if (init < 0 or traits.signed.get(@intCast(init)) == 0) {
        return -1;
    }

    const m: u32 = @intCast(init);
    const count = traits.paramCount.get(m);
    const required = count -% traits.optionalCount.get(m);
    return if (argc >= required and (argc <= count or domain.allowsExtraArgs(m))) init else -1;
}

/// A call of an interface's method, dispatch id `disp` in its layout, on
/// the receiver in `src` with `argc` arguments, by the alias every class
/// implementing the interface has of it (objects.ts tells why).
fn interfaceCall(em: *MethodEmitter, disp: u32, src: i32, argc: u32) Error!void {
    const out = &em.out;
    const domain = em.domain;
    const ifc = em.regType[u(src)];
    const m = refs.aliasedMember(domain, @intCast(ifc), disp);
    try em.member(src);
    if (m >= 0) {
        try out.text("[");
        try refs.interfaceAlias(out, domain, domain.traits.memberNs.get(@intCast(m)), domain.traits.memberName.get(@intCast(m)));
        try out.text("](");
    } else {
        try out.text("[rt.interfaceKey(");
        try refs.typeRef(em, ifc);
        try out.text(", ");
        try out.uint(disp);
        try out.text(", ");
        try em.read(src);
        try out.text(")](");
    }

    try list(em, src + 1, argc);
    try out.text(")");
}

/// `, r, r+1, ...` for `count` arguments from register `from`.
fn args(em: *MethodEmitter, from: i32, count: u32) Error!void {
    for (0..count) |k| {
        try em.out.text(", ");
        try em.reg(from + @as(i32, @intCast(k)));
    }
}

fn list(em: *MethodEmitter, from: i32, count: u32) Error!void {
    for (0..count) |k| {
        if (k != 0) {
            try em.out.text(", ");
        }

        try em.reg(from + @as(i32, @intCast(k)));
    }
}

/// A call by dispatch id `disp` on the receiver in `src`, with `argc`
/// arguments after it, which the verifier bound to method `m` (-1 for
/// none): a method of the receiver's prototype, or for a primitive
/// receiver, or a namespace, of its class's (objects.ts tells why).
fn virtual(em: *MethodEmitter, disp: u32, src: i32, argc: u32, m: i32) Error!void {
    const out = &em.out;
    const ty = em.regType[u(src)];
    // XML's methods look names up in the default XML namespace.
    if (ty == em.domain.xmlType or ty == em.domain.xmlListType) {
        em.seesDxns = true;
    }

    const bt = em.builtinOf(src);
    const primitive = switch (bt) {
        traits_.BUILTIN_Int,
        traits_.BUILTIN_Uint,
        traits_.BUILTIN_Number,
        traits_.BUILTIN_Float,
        traits_.BUILTIN_Boolean,
        traits_.BUILTIN_String,
        traits_.BUILTIN_Namespace,
        => true,
        else => false,
    };
    if (primitive) {
        const own = if (bt == traits_.BUILTIN_String) stringMethod(em, ty, disp, src, argc) else "";
        if (own.len > 0) {
            try receiver(em, src);
            try out.text(own);
            if (argc != 0) {
                try em.reg(src + 1);
            } else {
                try out.text("0");
            }

            try out.text(")");
            return;
        }

        // The method is kept from the first call on: its class's prototype
        // has it for good once the class is set up.
        try out.text("(T[");
        try out.uint(try em.methodSlot(ty, disp));
        try out.text("] ??= rt.prototypeOf(");
        try refs.typeRef(em, ty);
        try out.text(").$m");
        try out.uint(disp);
        try out.text(").call(");
        try em.reg(src);
        try args(em, src + 1, argc);
        try out.text(")");
        return;
    }

    // An Object may be a primitive, or a Namespace, whose methods are its
    // class prototype's; any other object has its own.
    if (bt == traits_.BUILTIN_Object) {
        try out.text("(");
        try em.member(src);
        try out.text(".$m");
        try out.uint(disp);
        try out.text(" ?? rt.prototypeOf(");
        try refs.typeRef(em, ty);
        try out.text(").$m");
        try out.uint(disp);
        try out.text(").call(");
        try em.reg(src);
        try args(em, src + 1, argc);
        try out.text(")");
        return;
    }

    try em.member(src);
    try out.text(if (m >= 0 and hasBoundEntry(em, @intCast(m))) ".$b" else ".$m");
    try out.uint(disp);
    try out.text("(");
    try list(em, src + 1, argc);
    try out.text(")");
}
