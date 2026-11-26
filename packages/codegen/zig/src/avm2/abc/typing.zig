// The typed half of each instruction's verification, as Verifier::verifyBlock
// types it (assembly/avm2/abc/typing.ts): the types and null flags it leaves
// its values with, the checks of its operands' types, and the scope chains
// the classes and functions it creates capture. How it reaches properties
// is properties.zig's.
const std = @import("std");
const Error = std.mem.Allocator.Error;
const ir_ = @import("../ir/ir.zig");
const traits_ = @import("../link/traits.zig");
const Scope = traits_.Scope;
const Scopes = traits_.Scopes;
const TYPE_Any = traits_.TYPE_Any;
const types = @import("../link/types.zig");
const BIND_Ambiguous = types.BIND_Ambiguous;
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const KNOWN = code_.KNOWN;
const NOT_NULL = code_.NOT_NULL;
const WITH = code_.WITH;
const C = @import("constants.zig");
const ops = @import("opcodes.zig");
const p = @import("properties.zig");

fn notNullIf(bd: *BodyDecoder, ty: i32) u8 {
    return if (bd.domain.typeNotNull(ty)) NOT_NULL else 0;
}

/// The type effects and type checks of the instruction at `pc`, as in
/// Verifier::verifyBlock, before the stack depth changes; `scope` is the
/// scope depth before the instruction.
pub fn typeAt(bd: *BodyDecoder, pc: u32, opcode: u8, a: u32, b: u32, scope: u32) Error!bool {
    const domain = bd.domain;
    const top = bd.peek(1);
    switch (opcode) {
        ops.OP_lookupswitch => return bd.peekType(1, domain.intType),
        ops.OP_pushnull => return bd.pushNullish(domain.nullType),
        ops.OP_pushundefined => return bd.pushNullish(domain.voidType),
        ops.OP_pushtrue, ops.OP_pushfalse => return bd.push(domain.booleanType, NOT_NULL),
        ops.OP_pushnan, ops.OP_pushdouble => return bd.push(domain.numberType, NOT_NULL),
        ops.OP_pushfloat => return if (domain.floatType < 0) bd.fail(C.kClassNotFoundError) else bd.push(domain.floatType, NOT_NULL),
        ops.OP_pushbyte, ops.OP_pushshort, ops.OP_pushint => return bd.push(domain.intType, NOT_NULL),
        ops.OP_pushuint => return bd.push(domain.uintType, NOT_NULL),
        ops.OP_pushstring => return bd.push(domain.stringType, NOT_NULL),
        ops.OP_pushnamespace => return bd.push(domain.namespaceType, NOT_NULL),
        ops.OP_setlocal => {
            bd.setValue(a, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
            return true;
        },
        ops.OP_getlocal => return bd.pushLocal(a),
        ops.OP_newfunction => {
            if (bd.emitPass and !try captureFunction(bd, a)) {
                return false;
            }

            bd.rowC = @bitCast(domain.methodStart.get(bd.index) + a);
            return bd.push(domain.functionType, NOT_NULL);
        },
        ops.OP_getlex => {
            // The scope object found is the receiver of the get.
            if (!try p.findProperty(bd, ops.OP_findpropstrict, a)) {
                return false;
            }

            bd.stack += 1;
            const got = try p.getProperty(bd, a, 1);
            bd.stack -= 1;
            return got;
        },
        ops.OP_findpropstrict, ops.OP_findproperty => return p.findProperty(bd, opcode, a),
        ops.OP_newclass => {
            if (bd.emitPass and !try captureClass(bd, a)) {
                return false;
            }

            try bd.coerce(top, domain.classInstanceType());
            bd.setValue(top, domain.staticTraitsOf(bd.index, a), NOT_NULL);
            bd.rowC = domain.staticTraitsOf(bd.index, a);
            return true;
        },
        ops.OP_finddef => return p.findDef(bd, a),
        ops.OP_setproperty, ops.OP_initproperty => return p.setProperty(bd, opcode, a),
        ops.OP_getproperty => {
            const n = p.propertyDepth(bd, a, 1);
            return n > 0 and try p.getProperty(bd, a, n);
        },
        ops.OP_getdescendants => {
            const n = p.propertyDepth(bd, a, 1);
            if (n == 0) {
                return false;
            }

            try bd.checkNull(bd.peek(n));
            return bd.popPush(n, TYPE_Any, 0);
        },
        ops.OP_checkfilter, ops.OP_convert_o => {
            try bd.checkNull(top);
            return true;
        },
        ops.OP_deleteproperty => {
            const n = p.propertyDepth(bd, a, 1);
            if (n == 0) {
                return false;
            }

            try bd.checkNull(bd.peek(n));
            return bd.popPush(n, domain.booleanType, NOT_NULL);
        },
        ops.OP_astype => {
            const t = try p.typeName(bd, a);
            if (t < TYPE_Any) {
                return false;
            }

            if (!types.canAssign(domain, t, bd.typeOf(top))) {
                const result = if (t != TYPE_Any and domain.isMachineType(t)) domain.objectType() else t;
                return bd.popPush(1, result, notNullIf(bd, result));
            }

            return true;
        },
        ops.OP_astypelate => {
            var t = domain.instanceTraitsOf(bd.typeOf(bd.peek(1)));
            if (t != TYPE_Any and domain.isMachineType(t)) {
                t = domain.objectType();
            }

            return bd.popPush(2, t, notNullIf(bd, t));
        },
        // The conversion is the instruction itself, which only retypes the value.
        ops.OP_coerce => {
            const t = try p.typeName(bd, a);
            if (t < TYPE_Any) {
                return false;
            }

            bd.rowC = t;
            bd.retype(top, t);
            return true;
        },
        ops.OP_convert_b, ops.OP_coerce_b => {
            bd.retype(top, domain.booleanType);
            return true;
        },
        ops.OP_coerce_o => {
            bd.retype(top, domain.objectType());
            return true;
        },
        ops.OP_coerce_a => {
            bd.retype(top, TYPE_Any);
            return true;
        },
        ops.OP_convert_i, ops.OP_coerce_i => {
            bd.retype(top, domain.intType);
            return true;
        },
        ops.OP_convert_u, ops.OP_coerce_u => {
            bd.retype(top, domain.uintType);
            return true;
        },
        ops.OP_convert_f => {
            if (domain.floatType < 0) {
                return bd.fail(C.kClassNotFoundError);
            }

            bd.retype(top, domain.floatType);
            return true;
        },
        ops.OP_unplus => {
            bd.retype(top, numericType(bd, bd.typeOf(top)));
            return true;
        },
        ops.OP_convert_d, ops.OP_coerce_d => {
            bd.retype(top, domain.numberType);
            return true;
        },
        ops.OP_coerce_s => {
            bd.retype(top, domain.stringType);
            return true;
        },
        ops.OP_iftrue, ops.OP_iffalse => {
            try bd.coerce(top, domain.booleanType);
            return true;
        },
        ops.OP_returnvalue => {
            try bd.coerce(top, domain.traits.returnType.get(bd.global));
            return true;
        },
        ops.OP_istype => {
            if (try p.typeName(bd, a) < TYPE_Any) {
                return false;
            }

            return bd.popPush(1, domain.booleanType, NOT_NULL);
        },
        ops.OP_istypelate => return bd.popPush(2, domain.booleanType, NOT_NULL),
        ops.OP_convert_s, ops.OP_esc_xelem, ops.OP_esc_xattr, ops.OP_typeof => return bd.popPush(1, domain.stringType, NOT_NULL),
        ops.OP_callstatic => return p.callStatic(bd, a, b),
        ops.OP_call => return bd.popPush(a +% 2, TYPE_Any, 0),
        ops.OP_construct => {
            const t = domain.instanceTraitsOf(bd.typeOf(bd.peek(a +% 1)));
            return bd.popPush(a +% 1, t, NOT_NULL);
        },
        ops.OP_callmethod => {
            // Always rejected, as avmplus has done since Flash Player 9.
            if (a == 0) {
                return bd.fail(C.kZeroDispIdError);
            }

            return bd.fail(if (bd.typeOf(bd.peek(b +% 1)) == TYPE_Any) C.kCorruptABCError else C.kIllegalEarlyBindingError);
        },
        ops.OP_callproperty, ops.OP_callproplex, ops.OP_callpropvoid => return p.callProperty(bd, opcode, a, b),
        ops.OP_constructprop => {
            const n = p.propertyDepth(bd, a, b +% 1);
            if (n == 0) {
                return false;
            }

            const obj = bd.peek(n);
            const ty = bd.typeOf(obj);
            const found = try p.binding(bd, ty, a);
            if (found == BIND_Ambiguous) {
                return false;
            }

            const ctraits = try p.readBinding(bd, ty, found);
            if (ctraits < TYPE_Any) {
                return false;
            }

            try bd.checkNull(obj);
            bd.rowC = ctraits;
            const itraits = domain.instanceTraitsOf(ctraits);
            const pushed = bd.popPush(n, itraits, if (itraits == TYPE_Any) 0 else NOT_NULL);
            // A name bound to a slot, as `new` of a script's class names one:
            // what the slot holds, constructed, with no lookup by name.
            const kind = found & 7;
            if (pushed and (kind == 2 or kind == 3) and n == b +% 1) {
                // The constructor's signature, which the emitter coerces the
                // arguments to; one that does not resolve fails no method here.
                const init = if (itraits >= 0) domain.traits.init.get(@intCast(itraits)) else -1;
                if (init >= 0) {
                    _ = try domain.traits.sign(domain, @intCast(init));
                }

                return bd.emitOn(ir_.IR_ConstructSlot, @bitCast(obj), @bitCast(obj), n, found >> 3, b, ctraits);
            }

            return pushed;
        },
        ops.OP_applytype => return bd.popPush(a +% 1, TYPE_Any, NOT_NULL),
        ops.OP_callsuper, ops.OP_callsupervoid => return p.callSuper(bd, opcode, a, b),
        ops.OP_getsuper => return p.getSuper(bd, a),
        ops.OP_setsuper => {
            const n = p.propertyDepth(bd, a, 2);
            if (n == 0) {
                return false;
            }

            const obj = bd.peek(n);
            if (try p.coerceSuper(bd, obj) < TYPE_Any) {
                return false;
            }

            try bd.checkNull(obj);
            return true;
        },
        ops.OP_constructsuper => {
            const obj = bd.peek(a +% 1);
            const base = try p.coerceSuper(bd, obj);
            if (base < TYPE_Any) {
                return false;
            }

            const init = domain.traits.init.get(@intCast(base));
            if (init >= 0 and !try p.coerceArgs(bd, @intCast(init), a)) {
                return false;
            }

            try bd.checkNull(obj);
            return true;
        },
        ops.OP_newobject => {
            var n: u32 = 2;
            while (n <= 2 *% a) : (n += 2) {
                if (!bd.peekType(n, domain.stringType)) {
                    return false;
                }
            }

            return bd.popPush(2 *% a, domain.objectType(), NOT_NULL);
        },
        ops.OP_newarray => return bd.popPush(a, domain.arrayType, NOT_NULL),
        ops.OP_pushscope, ops.OP_pushwith => {
            const ty = bd.typeOf(top);
            const outer = bd.outer;
            if (opcode == ops.OP_pushscope and scope == 0 and outer.extra != TYPE_Any) {
                if (ty == TYPE_Any or !try domain.traits.subtypeOf(domain.scratch, @intCast(ty), @intCast(outer.extra))) {
                    return bd.fail(C.kIllegalOperandTypeError);
                }
            }

            bd.setValue(bd.localCount + scope, ty, if (opcode == ops.OP_pushwith) NOT_NULL | WITH else NOT_NULL);
            return true;
        },
        ops.OP_newactivation => {
            const t = domain.bodyTraits.get(bd.index)[@intCast(bd.abc.methodBody[bd.method])];
            const err = if (t >= 0) try domain.traits.resolve(domain, @intCast(t)) else 0;
            if (err != 0) {
                return bd.fail(err);
            }

            return bd.push(t, NOT_NULL);
        },
        ops.OP_newcatch => return bd.push(bd.handlerScope.items[a], NOT_NULL),
        ops.OP_getscopeobject => {
            const i = bd.localCount + bd.byteAt(pc + 1);
            return bd.push(bd.typeOf(i), bd.valueFlags[i] & NOT_NULL);
        },
        ops.OP_getouterscope => {
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
        ops.OP_getglobalscope => return p.globalScope(bd) >= TYPE_Any,
        ops.OP_getglobalslot => {
            const global = p.globalScope(bd);
            if (global < TYPE_Any) {
                return false;
            }

            // The global object pushed is replaced by the slot's value.
            const slotType = try p.slot(bd, global, a -% 1);
            return slotType >= TYPE_Any and bd.push(slotType, notNullIf(bd, slotType));
        },
        ops.OP_setglobalslot => {
            const outer = bd.outer;
            const global = if (outer.size > 0) outer.types[0] else bd.typeOf(bd.localCount);
            const slotType = try p.slot(bd, global, a -% 1);
            if (slotType < TYPE_Any) {
                return false;
            }

            try bd.coerce(top, slotType);
            return true;
        },
        ops.OP_getslot => {
            const slotType = try p.slot(bd, bd.typeOf(top), a -% 1);
            if (slotType < TYPE_Any) {
                return false;
            }

            try bd.checkNull(top);
            return bd.popPush(1, slotType, notNullIf(bd, slotType));
        },
        ops.OP_setslot => {
            const slotType = try p.slot(bd, bd.typeOf(bd.peek(2)), a -% 1);
            if (slotType < TYPE_Any) {
                return false;
            }

            try bd.coerce(top, slotType);
            try bd.checkNull(bd.peek(2));
            return true;
        },
        ops.OP_dup => {
            const i = bd.stackBase() + bd.stack;
            _ = bd.push(bd.typeOf(top), bd.valueFlags[top] & KNOWN);
            bd.origin[i] = bd.origin[top];
            bd.originWrite[i] = bd.originWrite[top];
            return true;
        },
        ops.OP_swap => {
            const below = bd.peek(2);
            const ty = bd.typeOf(top);
            const flags = bd.valueFlags[top] & KNOWN;
            bd.setValue(top, bd.typeOf(below), bd.valueFlags[below] & KNOWN);
            bd.setValue(below, ty, flags);
            return true;
        },
        ops.OP_lessthan, ops.OP_greaterthan, ops.OP_lessequals, ops.OP_greaterequals => {
            // A comparison with a number compares numbers.
            const lhs = bd.peek(2);
            const lt = bd.typeOf(lhs);
            const rt = bd.typeOf(top);
            if (lt != TYPE_Any and rt != TYPE_Any) {
                if (!types.isNumeric(domain, lt) and types.isNumeric(domain, rt)) {
                    try bd.coerce(lhs, domain.numberType);
                } else if (types.isNumeric(domain, lt) and !types.isNumeric(domain, rt)) {
                    try bd.coerce(top, domain.numberType);
                }
            }

            return bd.popPush(2, domain.booleanType, NOT_NULL);
        },
        ops.OP_in => {
            try bd.checkNull(top);
            return bd.popPush(2, domain.booleanType, NOT_NULL);
        },
        ops.OP_equals, ops.OP_strictequals, ops.OP_instanceof => return bd.popPush(2, domain.booleanType, NOT_NULL),
        ops.OP_not => {
            try bd.coerce(top, domain.booleanType);
            return bd.popPush(1, domain.booleanType, NOT_NULL);
        },
        ops.OP_add => {
            const lhs = bd.peek(2);
            const lt = bd.typeOf(lhs);
            const rt = bd.typeOf(top);
            const string = domain.stringType;
            if ((lt == string and bd.isNotNull(lhs)) or (rt == string and bd.isNotNull(top))) {
                return bd.popPush(2, string, NOT_NULL);
            }

            if (domain.floatType >= 0 and lt == domain.floatType and rt == domain.floatType) {
                return bd.popPush(2, domain.floatType, NOT_NULL);
            }

            if (types.isNumeric(domain, lt) and types.isNumeric(domain, rt)) {
                return bd.popPush(2, domain.numberType, NOT_NULL);
            }

            // A number or a string, but not null either way.
            return bd.popPush(2, domain.objectType(), NOT_NULL);
        },
        ops.OP_modulo, ops.OP_subtract, ops.OP_divide, ops.OP_multiply => {
            if (bd.abc.hasFloatSupport()) {
                const lt = numericType(bd, bd.typeOf(bd.peek(2)));
                const rt = numericType(bd, bd.typeOf(top));
                if (lt == domain.floatType and rt == domain.floatType) {
                    return bd.popPush(2, domain.floatType, NOT_NULL);
                }

                if (lt == TYPE_Any or rt == TYPE_Any) {
                    return bd.popPush(2, TYPE_Any, NOT_NULL);
                }
            }

            try bd.coerce(bd.peek(2), domain.numberType);
            try bd.coerce(top, domain.numberType);
            return bd.popPush(2, domain.numberType, NOT_NULL);
        },
        ops.OP_negate, ops.OP_increment, ops.OP_decrement => {
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
        ops.OP_increment_i, ops.OP_decrement_i, ops.OP_negate_i, ops.OP_bitnot => {
            try bd.coerce(top, domain.intType);
            return true;
        },
        ops.OP_add_i, ops.OP_subtract_i, ops.OP_multiply_i, ops.OP_bitand, ops.OP_bitor, ops.OP_bitxor, ops.OP_lshift, ops.OP_rshift => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return bd.popPush(2, domain.intType, NOT_NULL);
        },
        ops.OP_urshift => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return bd.popPush(2, domain.uintType, NOT_NULL);
        },
        ops.OP_nextvalue, ops.OP_nextname => return bd.peekType(1, domain.intType) and bd.popPush(2, TYPE_Any, 0),
        ops.OP_hasnext => return bd.peekType(1, domain.intType) and bd.popPush(2, domain.intType, NOT_NULL),
        ops.OP_hasnext2 => {
            if (bd.typeOf(b) != domain.intType) {
                return bd.fail(C.kIllegalOperandTypeError);
            }

            bd.setValue(a, TYPE_Any, 0);
            return bd.push(domain.booleanType, NOT_NULL);
        },
        ops.OP_sxi1, ops.OP_sxi8, ops.OP_sxi16, ops.OP_li8, ops.OP_li16, ops.OP_li32 => {
            try bd.coerce(top, domain.intType);
            return bd.popPush(1, domain.intType, NOT_NULL);
        },
        ops.OP_lf32, ops.OP_lf64 => {
            try bd.coerce(top, domain.intType);
            return bd.popPush(1, domain.numberType, NOT_NULL);
        },
        ops.OP_si8, ops.OP_si16, ops.OP_si32 => {
            try bd.coerce(bd.peek(2), domain.intType);
            try bd.coerce(top, domain.intType);
            return true;
        },
        ops.OP_sf32, ops.OP_sf64 => {
            try bd.coerce(bd.peek(2), domain.numberType);
            try bd.coerce(top, domain.intType);
            return true;
        },
        else => {},
    }

    if (opcode >= ops.OP_setlocal0 and opcode < ops.OP_setlocal0 + 4) {
        bd.setValue(opcode - ops.OP_setlocal0, bd.typeOf(top), bd.valueFlags[top] & KNOWN);
    } else if (opcode >= ops.OP_getlocal0 and opcode < ops.OP_getlocal0 + 4) {
        return bd.pushLocal(opcode - ops.OP_getlocal0);
    }

    return true;
}

/// ToNumeric may preserve a float returned by an object's valueOf.
pub fn numericType(bd: *BodyDecoder, ty: i32) i32 {
    const domain = bd.domain;
    if (ty >= 0 and ty == domain.floatType) {
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

    return TYPE_Any;
}

/// The scope chain `outer` and the scopes pushed so far, with an optional
/// last entry (-2 for none) and extra, in the call's arena: most are
/// compared with one kept already and let go of.
fn scopeHere(bd: *BodyDecoder, last: i32, extra: i32) Error!*Scope {
    const gpa = bd.gpa;
    const outer = bd.outer;
    const size = outer.size + bd.scope + @intFromBool(last != -2);
    const scope = try gpa.create(Scope);
    scope.* = .{ .size = size, .types = try gpa.alloc(i32, size), .withs = try gpa.alloc(u8, size), .extra = extra };
    for (0..outer.size) |i| {
        scope.types[i] = outer.types[i];
        scope.withs[i] = outer.withs[i];
    }

    for (0..bd.scope) |i| {
        const v = bd.localCount + @as(u32, @intCast(i));
        scope.types[outer.size + i] = bd.typeOf(v);
        scope.withs[outer.size + i] = if (bd.valueFlags[v] & WITH != 0) 1 else 0;
    }

    if (last != -2) {
        scope.types[size - 1] = last;
        scope.withs[size - 1] = 0;
    }

    return scope;
}

/// A scope copied into the domain's arena, to keep.
fn kept(bd: *BodyDecoder, scope: *const Scope) Error!*Scope {
    const gpa = bd.domain.gpa;
    const copy = try gpa.create(Scope);
    copy.* = scope.*;
    copy.types = try gpa.dupe(i32, scope.types);
    copy.withs = try gpa.dupe(u8, scope.withs);
    return copy;
}

/// As the ScopeWriter's OP_newfunction: function m is created in the scope
/// chain here (typing.ts tells how a function another method creates in
/// another chain is contested rather than failing).
fn captureFunction(bd: *BodyDecoder, m: u32) Error!bool {
    const domain = bd.domain;
    const traits = &domain.traits;
    const gpa = domain.gpa;
    const global = domain.methodStart.get(bd.index) + m;
    const scope = try scopeHere(bd, -2, TYPE_Any);
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

    if (traits.methodTraits.get(global) >= 0) {
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
    if (innermost == TYPE_Any or domain.instanceTraitsOf(innermost) != traits.base.get(@intCast(itraits))) {
        return bd.fail(C.kCorruptABCError);
    }

    const cscope = try scopeHere(bd, -2, ctraits);
    const iscope = try scopeHere(bd, ctraits, itraits);
    var err = try traits.resolve(domain, @intCast(ctraits));
    if (err == 0) {
        err = try traits.resolve(domain, @intCast(itraits));
    }

    if (err != 0) {
        return bd.fail(err);
    }

    const current = traits.scope.get(@intCast(ctraits));
    if (current) |cur| {
        const instance = traits.scope.get(@intCast(itraits));
        if (instance == null or !cur.equals(cscope) or !instance.?.equals(iscope)) {
            return bd.fail(C.kCorruptABCError);
        }
    } else {
        try domain.put(traits.scope.at(@intCast(ctraits)), try kept(bd, cscope));
        try domain.put(traits.scope.at(@intCast(itraits)), try kept(bd, iscope));
        domain.captures += 1;
    }

    try domain.methodsOf(domain.scratch, @intCast(ctraits), &bd.captured);
    try domain.methodsOf(domain.scratch, @intCast(itraits), &bd.captured);
    return true;
}
