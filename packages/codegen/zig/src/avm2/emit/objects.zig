// The instructions of the object model, as the method emitter writes them
// (assembly/avm2/emit/objects.ts, whose comments tell each case's why):
// scopes, names, slots and properties, calls, and creating objects,
// functions and classes; domain memory, and XML's. And what each notes of
// the default XML namespace, which a method that can see it checks on entry
// (see MethodEmitter.checkEntry).
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ir_ = @import("../ir/ir.zig");
const memory = @import("memory.zig");
const method_ = @import("method.zig");
const MethodEmitter = method_.MethodEmitter;
const hasBoundEntry = method_.hasBoundEntry;
const refs = @import("refs.zig");
const values = @import("values.zig");
const IrOp = @import("../ir/ir.zig").Op;
const properties = @import("objects/properties.zig");
const calls = @import("objects/calls.zig");
const getProperty = properties.getProperty;
const setProperty = properties.setProperty;
const name = properties.name;
const vectorLength = properties.vectorLength;
const stringLength = properties.stringLength;
const receiver = properties.receiver;
const globalScope = calls.globalScope;
const localScopes = calls.localScopes;
const functionScope = calls.functionScope;
const scopeHere = calls.scopeHere;
const constructSlot = calls.constructSlot;
const superEntry = calls.superEntry;
const interfaceCall = calls.interfaceCall;
const args = calls.args;
const list = calls.list;
const virtual = calls.virtual;

pub fn u(r: i32) usize {
    return @intCast(r);
}

/// Whether register r may hold XML or an XMLList: untyped, Object, or either.
fn mayBeXml(em: *const MethodEmitter, r: i32) bool {
    const ty = em.regType[u(r)];
    const bt = em.domain.builtin(ty);
    return bt == .any or
        bt == .object or
        ty == em.domain.xmlType or
        ty == em.domain.xmlListType;
}

/// Note whether instruction i, `op` on register `src`, can see the default
/// XML namespace (objects.ts tells which can).
fn notesDxns(em: *MethodEmitter, op: IrOp, src: i32) void {
    switch (op) {
        .getproperty, .setproperty, .initproperty, .deleteproperty, .getdescendants => {
            if (mayBeXml(em, src)) {
                em.seesDxns = true;
            }
        },
        .in => {
            if (mayBeXml(em, src + 1)) {
                em.seesDxns = true;
            }
        },
        .call => {
            if (mayBeXml(em, src) or em.regType[u(src)] == em.domain.classType) {
                em.seesDxns = true;
            }
        },
        .callproperty,
        .callproplex,
        .callpropvoid,
        .constructprop,
        .ir_construct_slot,
        .construct,
        .newfunction,
        .newclass,
        .pushwith,
        .dxns,
        .dxnslate,
        => em.seesDxns = true,
        else => {},
    }
}

/// The instructions of the object model: scopes, names, properties, calls,
/// and creating objects, functions and classes; false for one it does not
/// know, which then calls rt.unsupported.
pub fn object(em: *MethodEmitter, i: u32, op: IrOp) Error!bool {
    const out = &em.out;
    const ir = em.ir;
    const a = ir.a[i];
    const src = ir.src[i];
    if (!em.seesDxns) {
        notesDxns(em, op, src);
    }

    switch (op) {
        .pushscope, .pushwith => {
            em.scopeWith[em.scopeDepth] = if (op == .pushwith) 1 else 0;
            em.scopeDepth += 1;
            if (em.copies_(i, src)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(src);
        },
        .popscope => {
            em.scopeDepth -%= 1;
            try em.reset(src);
        },
        .getscopeobject => {
            if (em.copies_(i, src)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(src);
        },
        .getouterscope => {
            try em.assign(i, false);
            try out.text("scope[");
            em.usesScope = true;
            try out.uint(a);
            try out.text("]");
        },
        .getglobalscope, .ir_get_global_scope => {
            if (ir.outerSize == 0 and em.copies_(i, @intCast(ir.localCount))) {
                return true;
            }

            try em.assign(i, false);
            try globalScope(em);
        },
        .finddef => {
            // The name keeps its script's global object once found, so a static
            // read in a loop costs a load and no call.
            try em.assign(i, false);
            try out.text("M[");
            try out.uint(a);
            try out.text("].global ?? rt.findDef(M[");
            try out.uint(a);
            try out.text("])");
        },
        .ir_find_prop_global, .ir_find_prop_global_strict => {
            const strict = op == .ir_find_prop_global_strict;
            try em.assign(i, false);
            if (ir.cScopeSearch(i) > 0) {
                // The local scopes from c - 1 first, by what each is at run time.
                try out.text(if (strict) "rt.findLocalStrict(M[" else "rt.findLocal(M[");
                try out.uint(a);
                try out.text("], [");
                const first = ir.cScopeSearch(i) - 1;
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
        .findproperty, .findpropstrict => {
            try em.assign(i, false);
            try out.text(if (op == .findpropstrict) "rt.findPropertyStrict(" else "rt.findProperty(");
            try name(em, a, src);
            try out.text(", scope, ");
            em.usesScope = true;
            try localScopes(em);
            try out.text(")");
        },
        .getslot => {
            try em.assign(i, false);
            try em.member(src);
            try refs.slotMember(out, a);
        },
        .setslot => {
            try em.member(src);
            try refs.slotMember(out, a);
            try out.text(" = ");
            try em.reg(src + 1);
        },
        .getglobalslot => {
            try em.assign(i, false);
            try globalScope(em);
            try refs.slotMember(out, a);
        },
        .setglobalslot => {
            try globalScope(em);
            try refs.slotMember(out, a);
            try out.text(" = ");
            try em.reg(src);
        },
        .ir_call_getter => {
            try em.assign(i, false);
            if (try vectorLength(em, src, ir.cMethod(i))) {
                try receiver(em, src);
                try out.text(".$a.length");
                return true;
            }

            if (stringLength(em, src, ir.cMethod(i))) {
                try receiver(em, src);
                try out.text(".length");
                return true;
            }

            try virtual(em, a, src, 0, -1);
        },
        .ir_call_setter => try virtual(em, a, src, 1, ir.cMethod(i)),
        .callmethod => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try virtual(em, a, src, ir.b[i], ir.cMethod(i));
        },
        .ir_call_interface => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            if (ir.b[i] <= em.domain.traits.paramCount.get(@intCast(ir.cMethod(i)))) {
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
        .ir_nip => {
            const top = src + @as(i32, @intCast(ir.srcCount[i])) - 1;
            if (em.copies_(i, top)) {
                return true;
            }

            try em.assign(i, false);
            try em.reg(top);
        },
        .getproperty => try getProperty(em, i, a, src),
        .setproperty => try setProperty(em, i, a, src),
        .initproperty => {
            try out.text("rt.initProperty(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(", ");
            try em.reg(src + @as(i32, @intCast(ir.srcCount[i])) - 1);
            try out.text(")");
        },
        .deleteproperty => {
            try em.assign(i, false);
            try out.text("rt.deleteProperty(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(")");
        },
        .in => {
            try em.assign(i, false);
            // `name in object`.
            try values.call2(em, "rt.in(", i);
        },
        .callproperty, .callproplex, .callpropvoid, .constructprop => {
            const argc = ir.b[i];
            const parts = ir.srcCount[i] - 1 - argc;
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try out.text(switch (op) {
                .constructprop => "rt.constructProperty(",
                .callproplex => "rt.callPropLex(",
                else => "rt.callProperty(",
            });
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try args(em, src + 1 + @as(i32, @intCast(parts)), argc);
            try out.text(")");
        },
        .callsuper, .callsupervoid, .getsuper, .setsuper => {
            const argc: u32 = switch (op) {
                .getsuper => 0,
                .setsuper => 1,
                else => ir.b[i],
            };
            const parts = ir.srcCount[i] - 1 - argc;
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            try out.text(switch (op) {
                .getsuper => "rt.getSuper(sup, ",
                .setsuper => "rt.setSuper(sup, ",
                else => "rt.callSuper(sup, ",
            });
            em.usesSup = true;
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try args(em, src + 1 + @as(i32, @intCast(parts)), argc);
            try out.text(")");
        },
        .ir_call_super => {
            if (ir.dst[i] >= 0) {
                try em.assign(i, false);
            }

            // The base's method itself, its arguments coerced already: its entry
            // for bound calls, where it has one.
            try out.text("sup.$it.proto.");
            try out.text(if (hasBoundEntry(em, @bitCast(ir.cMethod(i)))) "$b" else "$m");
            try out.uint(a);
            try out.text(".call(");
            em.usesSup = true;
            try em.reg(src);
            try args(em, src + 1, ir.b[i]);
            try out.text(")");
        },
        .constructsuper => {
            // As rt.constructSuper, without an array of the arguments to apply;
            // the verifier coerced them to the base's constructor, so they may
            // go to its entry for bound calls.
            try out.text(superEntry(em, ir.cType(i)));
            em.usesSup = true;
            try em.reg(src);
            try args(em, src + 1, a);
            try out.text(")");
        },
        .construct => {
            try em.assign(i, false);
            try out.text("rt.construct(");
            try em.reg(src);
            try args(em, src + 1, a);
            try out.text(")");
        },
        .ir_construct_slot => {
            try em.assign(i, false);
            try constructSlot(em, src, a, ir.b[i], ir.cType(i));
        },
        .call => {
            try em.assign(i, false);
            try out.text("rt.call(");
            try em.reg(src);
            try out.text(", ");
            try em.reg(src + 1);
            try args(em, src + 2, a);
            try out.text(")");
        },
        .callstatic => {
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
        .newfunction => {
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
        .newclass => {
            try em.assign(i, false);
            try out.text("rt.newClass(A.classes[");
            try out.uint(a);
            try out.text("], ");
            try em.reg(src);
            try out.text(", ");
            try scopeHere(em);
            try out.text(")");
        },
        .newactivation => {
            try em.assign(i, false);
            try out.text("rt.newActivation(A.activations[");
            try out.int(em.body);
            try out.text("])");
        },
        .newcatch => {
            const abc = em.abc;
            const h = abc.bodyExceptionStart[@intCast(em.body)] + a;
            try em.assign(i, false);
            try out.text("rt.newCatch(M[");
            try out.uint(abc.exceptionName[h]);
            try out.text("])");
        },
        .newobject, .newarray => {
            try em.assign(i, false);
            try out.text(if (op == .newobject) "rt.newObject([" else "rt.newArray([");
            try list(em, src, ir.srcCount[i]);
            try out.text("])");
        },
        .applytype => {
            try em.assign(i, false);
            try out.text("rt.applyType(");
            try em.reg(src);
            try out.text(", [");
            try list(em, src + 1, a);
            try out.text("])");
        },
        .hasnext2 => {
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
        .hasnext, .nextname, .nextvalue, .instanceof, .istypelate, .astypelate => {
            try em.assign(i, false);
            try values.call2(em, switch (op) {
                .hasnext => "rt.hasNext(",
                .nextname => "rt.nextName(",
                .nextvalue => "rt.nextValue(",
                .instanceof => "rt.instanceOf(",
                .istypelate => "rt.isTypeLate(",
                else => "rt.asTypeLate(",
            }, i);
        },
        .istype, .astype => {
            try em.assign(i, false);
            try out.text(if (op == .istype) "rt.isType(" else "rt.asType(");
            try em.reg(src);
            try out.text(", M[");
            try out.uint(a);
            try out.text("])");
        },
        // Domain memory: in place at an int or uint address, else through
        // the runtime (objects.ts tells why); sign extensions in plain JavaScript.
        .li8, .li16, .li32, .lf32, .lf64 => {
            try em.assign(i, false);
            if (memory.isAddress(em, src)) {
                em.inPlaceMemory = true;
                try out.text("rt.view.");
                try out.text(memory.viewMethod(op));
                try out.text("(");
                try em.reg(src);
                try out.text(if (op == .li8) ")" else ", true)");
                return true;
            }

            try out.text("rt.");
            try out.text(ir_.opcodeName(op));
            try out.text("(");
            try em.reg(src);
            try out.text(")");
        },
        .si8, .si16, .si32, .sf32, .sf64 => {
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
                try out.text(if (op == .si8) ")" else ", true)");
                return true;
            }

            try out.text("rt.");
            try out.text(ir_.opcodeName(op));
            try out.text("(");
            try em.reg(src);
            try out.text(", ");
            try em.reg(src + 1);
            try out.text(")");
        },
        .sxi1, .sxi8, .sxi16 => {
            try em.assign(i, false);
            try out.text("(");
            try em.reg(src);
            try out.text(switch (op) {
                .sxi1 => " << 31) >> 31",
                .sxi8 => " << 24) >> 24",
                else => " << 16) >> 16",
            });
        },
        .getdescendants => {
            try em.assign(i, false);
            try out.text("rt.getDescendants(");
            try em.reg(src);
            try out.text(", ");
            try name(em, a, src + 1);
            try out.text(")");
        },
        .dxns => {
            try out.text("rt.setDefaultXmlNamespace(");
            try refs.poolString(em, a);
            try out.text(")");
        },
        .dxnslate, .checkfilter => {
            try out.text(if (op == .dxnslate) "rt.setDefaultXmlNamespace(" else "rt.checkFilter(");
            try em.reg(src);
            try out.text(")");
        },
        .esc_xelem, .esc_xattr => {
            try em.assign(i, false);
            try out.text(if (op == .esc_xelem) "rt.escapeElement(" else "rt.escapeAttribute(");
            try em.reg(src);
            try out.text(")");
        },
        else => return false,
    }

    return true;
}
