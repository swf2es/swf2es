// The typed half of each instruction's verification, as Verifier::verifyBlock
// types it: the types and null flags it leaves
// its values with, the checks of its operands' types, and the scope chains
// the classes and functions it creates capture. How it reaches properties
// is properties.zig's.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const traits_ = @import("../link/traits.zig");
const Binding = traits_.Binding;
const Scope = traits_.Scope;
const Scopes = traits_.Scopes;
const TypeId = traits_.TypeId;
const ir_ = @import("../ir/ir.zig");
const types = @import("../link/types.zig");
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const KNOWN = code_.KNOWN;
const NOT_NULL = code_.NOT_NULL;
const WITH = code_.WITH;
const C = @import("constants.zig");
const p = @import("properties.zig");
const Op = @import("opcodes.zig").Op;

fn notNullIf(bd: *BodyDecoder, ty: TypeId) u8 {
    return if (bd.domain.typeNotNull(ty)) NOT_NULL else 0;
}

/// The type effects and type checks of the instruction at `pc`, as in
/// Verifier::verifyBlock, before the stack depth changes; `scope` is the
/// scope depth before the instruction.
pub fn typeAt(bd: *BodyDecoder, pc: u32, opcode: Op, a: u32, b: u32, scope: u32) Error!bool {
    const domain = bd.domain;
    const top = bd.peek(1);
    switch (opcode) {
        .lookupswitch => return bd.peekType(1, domain.intType),
        .pushnull => return bd.pushNullish(domain.nullType),
        .pushundefined => return bd.pushNullish(domain.voidType),
        .pushtrue, .pushfalse => return bd.push(domain.booleanType, NOT_NULL),
        .pushnan, .pushdouble => return bd.push(domain.numberType, NOT_NULL),
        .pushfloat => return if (domain.floatType == .any) bd.fail(C.kClassNotFoundError) else bd.push(domain.floatType, NOT_NULL),
        .pushbyte, .pushshort, .pushint => return bd.push(domain.intType, NOT_NULL),
        .pushuint => return bd.push(domain.uintType, NOT_NULL),
        .pushstring => return bd.push(domain.stringType, NOT_NULL),
        .pushnamespace => return bd.push(domain.namespaceType, NOT_NULL),
        .setlocal => {
            bd.setValue(a, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
            return true;
        },
        .getlocal => return bd.pushLocal(a),
        .newfunction => {
            if (bd.emitPass and !try captureFunction(bd, a)) {
                return false;
            }

            bd.rowC = @bitCast(domain.methodStart.get(bd.index) + a);
            return bd.push(domain.functionType, NOT_NULL);
        },
        .getlex => {
            // The scope object found is the receiver of the get.
            if (!try p.findProperty(bd, .findpropstrict, a)) {
                return false;
            }

            bd.stack += 1;
            const got = try p.getProperty(bd, a, 1);
            bd.stack -= 1;
            return got;
        },
        .findpropstrict, .findproperty => return p.findProperty(bd, opcode, a),
        .newclass => {
            if (bd.emitPass and !try captureClass(bd, a)) {
                return false;
            }

            try bd.coerce(top, domain.classInstanceType());
            bd.setValue(top, domain.staticTraitsOf(bd.index, a), NOT_NULL);
            bd.rowC = ir_.typeColumn(domain.staticTraitsOf(bd.index, a));
            return true;
        },
        .finddef => return p.findDef(bd, a),
        .setproperty, .initproperty => return p.setProperty(bd, opcode, a),
        .getproperty => {
            const n = p.propertyDepth(bd, a, 1);
            return n > 0 and try p.getProperty(bd, a, n);
        },
        .getdescendants => {
            const n = p.propertyDepth(bd, a, 1);
            if (n == 0) {
                return false;
            }

            try bd.checkNull(bd.peek(n));
            return bd.popPush(n, .any, 0);
        },
        .checkfilter, .convert_o => {
            try bd.checkNull(top);
            return true;
        },
        .deleteproperty => {
            const n = p.propertyDepth(bd, a, 1);
            if (n == 0) {
                return false;
            }

            try bd.checkNull(bd.peek(n));
            return bd.popPush(n, domain.booleanType, NOT_NULL);
        },
        .astype => {
            const t = try p.typeName(bd, a);
            if (t == TypeId.failed) {
                return false;
            }

            if (!types.canAssign(domain, t, bd.typeOf(top))) {
                const result = if (t != .any and domain.isMachineType(t)) domain.objectType() else t;
                return bd.popPush(1, result, notNullIf(bd, result));
            }

            return true;
        },
        .astypelate => {
            var t = domain.instanceTraitsOf(bd.typeOf(bd.peek(1)));
            if (t != .any and domain.isMachineType(t)) {
                t = domain.objectType();
            }

            return bd.popPush(2, t, notNullIf(bd, t));
        },
        // The conversion is the instruction itself, which only retypes the value.
        .coerce => {
            const t = try p.typeName(bd, a);
            if (t == TypeId.failed) {
                return false;
            }

            bd.rowC = ir_.typeColumn(t);
            bd.retype(top, t);
            return true;
        },
        .convert_b, .coerce_b => {
            bd.retype(top, domain.booleanType);
            return true;
        },
        .coerce_o => {
            bd.retype(top, domain.objectType());
            return true;
        },
        .coerce_a => {
            bd.retype(top, .any);
            return true;
        },
        .convert_i, .coerce_i => {
            bd.retype(top, domain.intType);
            return true;
        },
        .convert_u, .coerce_u => {
            bd.retype(top, domain.uintType);
            return true;
        },
        .convert_f => {
            if (domain.floatType == .any) {
                return bd.fail(C.kClassNotFoundError);
            }

            bd.retype(top, domain.floatType);
            return true;
        },
        .unplus => {
            bd.retype(top, numericType(bd, bd.typeOf(top)));
            return true;
        },
        .convert_d, .coerce_d => {
            bd.retype(top, domain.numberType);
            return true;
        },
        .coerce_s => {
            bd.retype(top, domain.stringType);
            return true;
        },
        .iftrue, .iffalse => {
            try bd.coerce(top, domain.booleanType);
            return true;
        },
        .returnvalue => {
            try bd.coerce(top, domain.traits.returnType.get(bd.global));
            return true;
        },
        .istype => {
            if (try p.typeName(bd, a) == TypeId.failed) {
                return false;
            }

            return bd.popPush(1, domain.booleanType, NOT_NULL);
        },
        .istypelate => return bd.popPush(2, domain.booleanType, NOT_NULL),
        .convert_s, .esc_xelem, .esc_xattr, .typeof => return bd.popPush(1, domain.stringType, NOT_NULL),
        .callstatic => return p.callStatic(bd, a, b),
        .call => return bd.popPush(a +% 2, .any, 0),
        .construct => {
            const t = domain.instanceTraitsOf(bd.typeOf(bd.peek(a +% 1)));
            return bd.popPush(a +% 1, t, NOT_NULL);
        },
        .callmethod => {
            // Always rejected, as avmplus has done since Flash Player 9.
            if (a == 0) {
                return bd.fail(C.kZeroDispIdError);
            }

            return bd.fail(if (bd.typeOf(bd.peek(b +% 1)) == .any) C.kCorruptABCError else C.kIllegalEarlyBindingError);
        },
        .callproperty, .callproplex, .callpropvoid => return p.callProperty(bd, opcode, a, b),
        .constructprop => {
            const n = p.propertyDepth(bd, a, b +% 1);
            if (n == 0) {
                return false;
            }

            const obj = bd.peek(n);
            const ty = bd.typeOf(obj);
            const found = try p.binding(bd, ty, a);
            if (found == Binding.ambiguous) {
                return false;
            }

            const ctraits = try p.readBinding(bd, ty, found);
            if (ctraits == TypeId.failed) {
                return false;
            }

            try bd.checkNull(obj);
            bd.rowC = ir_.typeColumn(ctraits);
            const itraits = domain.instanceTraitsOf(ctraits);
            const pushed = bd.popPush(n, itraits, if (itraits == .any) 0 else NOT_NULL);
            // A name bound to a slot, as `new` of a script's class names one:
            // what the slot holds, constructed, with no lookup by name.
            const kind = found.kind;
            if (pushed and (kind == .variable or kind == .constant) and n == b +% 1) {
                // The constructor's signature, which the emitter coerces the
                // arguments to; one that does not resolve fails no method here.
                const init = if (itraits.isTraits()) domain.traits.init.get(itraits.index()) else -1;
                if (init >= 0) {
                    _ = try domain.traits.sign(domain, @intCast(init));
                }

                return bd.emitOn(.ir_construct_slot, @bitCast(obj), @bitCast(obj), n, found.index(), b, ir_.typeColumn(ctraits));
            }

            return pushed;
        },
        .applytype => return bd.popPush(a +% 1, .any, NOT_NULL),
        .callsuper, .callsupervoid => return p.callSuper(bd, opcode, a, b),
        .getsuper => return p.getSuper(bd, a),
        .setsuper => {
            const n = p.propertyDepth(bd, a, 2);
            if (n == 0) {
                return false;
            }

            const obj = bd.peek(n);
            if (try p.coerceSuper(bd, obj) == TypeId.failed) {
                return false;
            }

            try bd.checkNull(obj);
            return true;
        },
        .constructsuper => {
            const obj = bd.peek(a +% 1);
            const base = try p.coerceSuper(bd, obj);
            if (base == TypeId.failed) {
                return false;
            }

            const init = domain.traits.init.get(base.index());
            if (init >= 0 and !try p.coerceArgs(bd, @intCast(init), a)) {
                return false;
            }

            try bd.checkNull(obj);
            return true;
        },
        .newobject => {
            var n: u32 = 2;
            while (n <= 2 *% a) : (n += 2) {
                if (!bd.peekType(n, domain.stringType)) {
                    return false;
                }
            }

            return bd.popPush(2 *% a, domain.objectType(), NOT_NULL);
        },
        .newarray => return bd.popPush(a, domain.arrayType, NOT_NULL),
        .pushscope, .pushwith => {
            const ty = bd.typeOf(top);
            const outer = bd.outer;
            if (opcode == .pushscope and scope == 0 and outer.extra != .any) {
                if (ty == .any or !try domain.traits.subtypeOf(domain.scratch, ty.index(), outer.extra.index())) {
                    return bd.fail(C.kIllegalOperandTypeError);
                }
            }

            bd.setValue(bd.localCount + scope, ty, if (opcode == .pushwith) NOT_NULL | WITH else NOT_NULL);
            return true;
        },
        .newactivation => {
            const t = domain.bodyTraits.get(bd.index)[@intCast(bd.abc.methodBody[bd.method])];
            const err = if (t != .none) try domain.traits.resolve(domain, t.index()) else 0;
            if (err != 0) {
                return bd.fail(err);
            }

            // A body without activation traits pushes *.
            return bd.push(t.orAny(), NOT_NULL);
        },
        .newcatch => return bd.push(bd.handlerScope[a], NOT_NULL),
        .getscopeobject => {
            const i = bd.localCount + bd.byteAt(pc + 1);
            return bd.push(bd.typeOf(i), bd.valueFlags[i] & NOT_NULL);
        },
        .getouterscope => {
            const outer = bd.outer;
            // avmplus names the index only where nothing was captured (Verifier.cpp).
            if (outer.size == 0) {
                return bd.failWith(C.kGetScopeObjectBoundsError, a);
            }

            if (a >= outer.size) {
                return bd.fail(C.kGetScopeObjectBoundsError);
            }

            return bd.push(outer.types[a], NOT_NULL);
        },
        .getglobalscope => return p.globalScope(bd) != TypeId.failed,
        .getglobalslot => {
            const global = p.globalScope(bd);
            if (global == TypeId.failed) {
                return false;
            }

            // The global object pushed is replaced by the slot's value.
            const slotType = try p.slot(bd, global, a -% 1);
            return slotType != TypeId.failed and bd.push(slotType, notNullIf(bd, slotType));
        },
        .setglobalslot => {
            const outer = bd.outer;
            const global = if (outer.size > 0) outer.types[0] else bd.typeOf(bd.localCount);
            const slotType = try p.slot(bd, global, a -% 1);
            if (slotType == TypeId.failed) {
                return false;
            }

            try bd.coerce(top, slotType);
            return true;
        },
        .getslot => {
            const slotType = try p.slot(bd, bd.typeOf(top), a -% 1);
            if (slotType == TypeId.failed) {
                return false;
            }

            try bd.checkNull(top);
            return bd.popPush(1, slotType, notNullIf(bd, slotType));
        },
        .setslot => {
            const slotType = try p.slot(bd, bd.typeOf(bd.peek(2)), a -% 1);
            if (slotType == TypeId.failed) {
                return false;
            }

            try bd.coerce(top, slotType);
            try bd.checkNull(bd.peek(2));
            return true;
        },
        .dup => {
            const i = bd.stackBase() + bd.stack;
            _ = bd.push(bd.typeOf(top), bd.valueFlags[top] & KNOWN);
            bd.origin[i] = bd.origin[top];
            bd.originWrite[i] = bd.originWrite[top];
            return true;
        },
        .swap => {
            const below = bd.peek(2);
            const ty = bd.typeOf(top);
            const flags = bd.valueFlags[top] & KNOWN;
            bd.setValue(top, bd.typeOf(below), bd.valueFlags[below] & KNOWN);
            bd.setValue(below, ty, flags);
            return true;
        },
        .lessthan, .greaterthan, .lessequals, .greaterequals => {
            // A comparison with a number compares numbers.
            const lhs = bd.peek(2);
            const lt = bd.typeOf(lhs);
            const rt = bd.typeOf(top);
            if (lt != .any and rt != .any) {
                if (!types.isNumeric(domain, lt) and types.isNumeric(domain, rt)) {
                    try bd.coerce(lhs, domain.numberType);
                } else if (types.isNumeric(domain, lt) and !types.isNumeric(domain, rt)) {
                    try bd.coerce(top, domain.numberType);
                }
            }

            return bd.popPush(2, domain.booleanType, NOT_NULL);
        },
        .in => {
            try bd.checkNull(top);
            return bd.popPush(2, domain.booleanType, NOT_NULL);
        },
        .equals, .strictequals, .instanceof => return bd.popPush(2, domain.booleanType, NOT_NULL),
        .not => {
            try bd.coerce(top, domain.booleanType);
            return bd.popPush(1, domain.booleanType, NOT_NULL);
        },
        .add => {
            const lhs = bd.peek(2);
            const lt = bd.typeOf(lhs);
            const rt = bd.typeOf(top);
            const string = domain.stringType;
            if ((lt == string and bd.isNotNull(lhs)) or (rt == string and bd.isNotNull(top))) {
                return bd.popPush(2, string, NOT_NULL);
            }

            if (lt.isBuiltin(domain.floatType) and rt == domain.floatType) {
                return bd.popPush(2, domain.floatType, NOT_NULL);
            }

            if (types.isNumeric(domain, lt) and types.isNumeric(domain, rt)) {
                return bd.popPush(2, domain.numberType, NOT_NULL);
            }

            // A number or a string, but not null either way.
            return bd.popPush(2, domain.objectType(), NOT_NULL);
        },
        .modulo, .subtract, .divide, .multiply => {
            if (bd.abc.hasFloatSupport()) {
                const lt = numericType(bd, bd.typeOf(bd.peek(2)));
                const rt = numericType(bd, bd.typeOf(top));
                if (lt == domain.floatType and rt == domain.floatType) {
                    return bd.popPush(2, domain.floatType, NOT_NULL);
                }

                if (lt == .any or rt == .any) {
                    return bd.popPush(2, .any, NOT_NULL);
                }
            }

            try bd.coerce(bd.peek(2), domain.numberType);
            try bd.coerce(top, domain.numberType);
            return bd.popPush(2, domain.numberType, NOT_NULL);
        },
        .negate, .increment, .decrement => {
            if (bd.abc.hasFloatSupport()) {
                const numeric = numericType(bd, bd.typeOf(top));
                if (numeric != domain.numberType) {
                    bd.retype(top, numeric);
                    return true;
                }
            }

            try bd.coerce(top, domain.numberType);
            return true;
        },
        .increment_i, .decrement_i, .negate_i, .bitnot => {
            try bd.coerce(top, domain.intType);
            return true;
        },
        .add_i, .subtract_i, .multiply_i, .bitand, .bitor, .bitxor, .lshift, .rshift => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return bd.popPush(2, domain.intType, NOT_NULL);
        },
        .urshift => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return bd.popPush(2, domain.uintType, NOT_NULL);
        },
        .nextvalue, .nextname => return bd.peekType(1, domain.intType) and bd.popPush(2, .any, 0),
        .hasnext => return bd.peekType(1, domain.intType) and bd.popPush(2, domain.intType, NOT_NULL),
        .hasnext2 => {
            if (bd.typeOf(b) != domain.intType) {
                return bd.fail(C.kIllegalOperandTypeError);
            }

            bd.setValue(a, .any, 0);
            return bd.push(domain.booleanType, NOT_NULL);
        },
        .sxi1, .sxi8, .sxi16, .li8, .li16, .li32 => {
            try bd.coerce(top, domain.intType);
            return bd.popPush(1, domain.intType, NOT_NULL);
        },
        .lf32, .lf64 => {
            try bd.coerce(top, domain.intType);
            return bd.popPush(1, domain.numberType, NOT_NULL);
        },
        .si8, .si16, .si32 => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return true;
        },
        .sf32, .sf64 => {
            try bd.coerce(bd.peek(2), domain.numberType);
            try bd.coerce(top, domain.intType);
            return true;
        },
        else => {},
    }

    if (opcode.setLocalN()) |local| {
        bd.setValue(local, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
    } else if (opcode.getLocalN()) |local| {
        return bd.pushLocal(local);
    }

    return true;
}

/// ToNumeric may preserve a float returned by an object's valueOf.
pub fn numericType(bd: *BodyDecoder, ty: TypeId) TypeId {
    const domain = bd.domain;
    if (ty.isBuiltin(domain.floatType)) {
        return ty;
    }

    if (types.isNumeric(domain, ty) or
        ty == domain.booleanType or
        ty == domain.stringType or
        ty == domain.nullType or
        ty == domain.voidType)
    {
        return domain.numberType;
    }

    return .any;
}

/// The scope chain `outer` and the scopes pushed so far, with an optional
/// last entry and extra, in the call's arena: most are compared with one
/// kept already and let go of.
fn scopeHere(bd: *BodyDecoder, last: ?TypeId, extra: TypeId) Error!*Scope {
    const gpa = bd.gpa;
    const outer = bd.outer;
    const size = outer.size + bd.scope + @intFromBool(last != null);
    const scope = try gpa.create(Scope);
    scope.* = .{ .size = size, .types = try gpa.alloc(TypeId, size), .withs = try gpa.alloc(u8, size), .extra = extra };
    for (0..outer.size) |i| {
        scope.types[i] = outer.types[i];
        scope.withs[i] = outer.withs[i];
    }

    for (0..bd.scope) |i| {
        const v = bd.localCount + @as(u32, @intCast(i));
        scope.types[outer.size + i] = bd.typeOf(v);
        scope.withs[outer.size + i] = if (bd.valueFlags[v] & WITH != 0) 1 else 0;
    }

    if (last) |t| {
        scope.types[size - 1] = t;
        scope.withs[size - 1] = 0;
    }

    return scope;
}

/// A scope copied into the domain's arena, to keep.
fn kept(bd: *BodyDecoder, scope: *const Scope) Error!*Scope {
    const gpa = bd.domain.gpa;
    const copy = try gpa.create(Scope);
    copy.* = scope.*;
    copy.types = try gpa.dupe(TypeId, scope.types);
    copy.withs = try gpa.dupe(u8, scope.withs);
    return copy;
}

/// As the ScopeWriter's OP_newfunction: function m is created in the scope
/// chain here; a method bound to traits cannot be a function, and one
/// created again must be created alike, unless it creates itself.
///
/// avmplus verifies each method as it first runs, and the first method to
/// create a function gives it its scope chain: another method that creates
/// it in another fails when it first runs. Verifying every method before
/// any runs cannot know which runs first, so a function another method
/// creates in another scope chain is contested rather than failing either:
/// it is verified and compiled in their merged scope chain, and each of its
/// creators claims it as it first runs, by its chain's index among them,
/// the later in another throwing as avmplus would (see claims). One method
/// that creates it in two chains fails, as avmplus fails it.
fn captureFunction(bd: *BodyDecoder, m: u32) Error!bool {
    const domain = bd.domain;
    const traits = &domain.traits;
    const gpa = domain.gpa;
    const global = domain.methodStart.get(bd.index) + m;
    const scope = try scopeHere(bd, null, .any);
    const current = traits.functionScope.get(global);
    if (current != null) {
        // Created again in its own scope chain, as it may create itself: as created before.
        if (global == bd.global) {
            try bd.captured.append(bd.gpa, global);
            return true;
        }

        const scopes = traits.functionScopes.get(global).?;
        var index: i32 = -1;
        for (scopes.items, 0..) |s, i| {
            if (s.equals(scope)) {
                index = @intCast(i);
                break;
            }
        }

        if (index < 0) {
            // A new list, so that a rollback puts the old one back as it was.
            index = @intCast(scopes.items.len);
            const grown = try gpa.create(Scopes);
            grown.* = .empty;
            try grown.ensureTotalCapacityPrecise(gpa, scopes.items.len + 1);
            grown.appendSliceAssumeCapacity(scopes.items);
            grown.appendAssumeCapacity(try kept(bd, scope));
            try domain.put(traits.functionScopes.at(global), grown);
            try domain.put(traits.functionContested.at(global), 1);
            domain.captures += 1;
        }

        // Created twice by this method, in two chains.
        var c: usize = 0;
        while (c < bd.claims.items.len) : (c += 2) {
            if (bd.claims.items[c] == global and bd.claims.items[c + 1] != @as(u32, @intCast(index))) {
                return bd.fail(C.kCorruptABCError);
            }
        }

        try bd.claims.append(bd.gpa, global);
        try bd.claims.append(bd.gpa, @intCast(index));
        try bd.captured.append(bd.gpa, global);
        return true;
    }

    if (traits.methodTraits.get(global) != .none) {
        return bd.fail(C.kCorruptABCError);
    }

    try domain.put(traits.methodFunction.at(global), 1);
    const err = try traits.sign(domain, global);
    if (err != 0) {
        return bd.fail(err);
    }

    const keep = try kept(bd, scope);
    try domain.put(traits.functionScope.at(global), keep);
    const scopes = try gpa.create(Scopes);
    scopes.* = .empty;
    try scopes.append(gpa, keep);
    try domain.put(traits.functionScopes.at(global), scopes);
    domain.captures += 1;
    try bd.claims.append(bd.gpa, global);
    try bd.claims.append(bd.gpa, 0);
    try bd.captured.append(bd.gpa, global);
    return true;
}

/// As the ScopeWriter's OP_newclass: the innermost scope must be the base
/// class object; the class's static methods run in the scope chain here,
/// its instance methods in that and the class object, once, and a class
/// created again must be created alike. Both traits resolve.
fn captureClass(bd: *BodyDecoder, i: u32) Error!bool {
    const domain = bd.domain;
    const traits = &domain.traits;
    const ctraits = domain.staticTraitsOf(bd.index, i);
    const itraits = domain.instanceTraitsOf(ctraits);
    if (bd.scope == 0) {
        return bd.fail(C.kCorruptABCError);
    }

    const innermost = bd.typeOf(bd.localCount + bd.scope - 1);
    // No base reads as *, as instanceTraitsOf answers for a type not a class.
    if (innermost == .any or domain.instanceTraitsOf(innermost) != traits.base.get(itraits.index()).orAny()) {
        return bd.fail(C.kCorruptABCError);
    }

    const cscope = try scopeHere(bd, null, ctraits);
    const iscope = try scopeHere(bd, ctraits, itraits);
    var err = try traits.resolve(domain, ctraits.index());
    if (err == 0) {
        err = try traits.resolve(domain, itraits.index());
    }

    if (err != 0) {
        return bd.fail(err);
    }

    const current = traits.scope.get(ctraits.index());
    if (current) |cur| {
        const instance = traits.scope.get(itraits.index());
        if (instance == null or !cur.equals(cscope) or !instance.?.equals(iscope)) {
            return bd.fail(C.kCorruptABCError);
        }
    } else {
        try domain.put(traits.scope.at(ctraits.index()), try kept(bd, cscope));
        try domain.put(traits.scope.at(itraits.index()), try kept(bd, iscope));
        domain.captures += 1;
    }

    try domain.methodsOf(domain.scratch, ctraits.index(), &bd.captured);
    try domain.methodsOf(domain.scratch, itraits.index(), &bd.captured);
    return true;
}
