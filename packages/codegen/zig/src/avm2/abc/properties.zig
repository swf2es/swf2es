// How a method's code reaches properties, as avmplus' Verifier types and
// binds them: finding a property's object
// along the scope chain, getting, setting and calling it, early where the
// receiver's type binds the name and late otherwise, and the super calls
// and properties.
const std = @import("std");
const errors = @import("errors.zig");
const Error = errors.Error;
const Rejected = errors.Rejected;
const Diagnostics = @import("errors.zig").Diagnostics;
const ir_ = @import("../ir/ir.zig");
const traits_ = @import("../link/traits.zig");
const Binding = traits_.Binding;
const TypeId = traits_.TypeId;
const types = @import("../link/types.zig");
const code_ = @import("code.zig");
const BodyDecoder = code_.BodyDecoder;
const Flags = code_.Flags;
const C = @import("constants.zig");
const Op = @import("opcodes.zig").Op;
const IrOp = @import("../ir/ir.zig").Op;

fn notNullIf(bd: *BodyDecoder, ty: TypeId) Flags {
    return .{ .not_null = bd.domain.typeNotNull(ty) };
}

/// As Verifier::checkPropertyMultiname: count the runtime parts of
/// multiname `mn` above the `n` values below them, checking that a runtime
/// name with a namespace is a String and a runtime namespace a Namespace.
/// Returns the depth of the receiver.
pub fn propertyDepth(bd: *BodyDecoder, mn: u32, depth: u32) Rejected!u32 {
    const domain = bd.domain;
    var n = depth;
    const parts = code_.nameParts(&bd.abc.pool, mn);
    if (parts.rtname) {
        if (parts.qname) {
            try bd.peekType(n, domain.stringType);
        }

        n +%= 1;
    }

    if (parts.rtns) {
        try bd.peekType(n, domain.namespaceType);
        n +%= 1;
    }

    return n;
}

/// The binding of `mn` on `type`; rejected with 1008 if it is ambiguous.
pub fn binding(bd: *BodyDecoder, ty: TypeId, mn: u32) Error!Binding {
    const b = try types.getBinding(bd.domain, bd.index, ty, mn);
    if (b == Binding.ambiguous) {
        return bd.fail(C.kAmbiguousBindingError);
    }

    return b;
}

/// As Verifier::readBinding: resolve `type`, then the type of its binding b.
pub fn readBinding(bd: *BodyDecoder, ty: TypeId, b: Binding) Error!TypeId {
    if (!ty.isTraits()) {
        return .any;
    }

    const domain = bd.domain;
    var diag: Diagnostics = .{};
    domain.traits.resolve(domain, ty.index(), &diag) catch |err| return bd.linkFailed(err, &diag);
    return types.bindingType(domain, ty, b);
}

/// As Verifier::checkTypeName: the type multiname `mn` names.
pub fn typeName(bd: *BodyDecoder, mn: u32) Error!TypeId {
    const pool = &bd.abc.pool;
    if (mn == 0 or mn >= pool.multinameCount()) {
        return bd.fail(C.kCpoolIndexRangeError);
    }

    var diag: Diagnostics = .{};
    return bd.domain.checkTypeName(bd.index, mn, &diag) catch |err| bd.linkFailed(err, &diag);
}

/// As Verifier::emitCoerceArgs: method m must take `argc` arguments, which
/// become its parameter types, and the receiver below them its receiver type.
pub fn coerceArgs(bd: *BodyDecoder, m: u32, argc: u32) Error!void {
    const domain = bd.domain;
    const traits = &domain.traits;
    var diag: Diagnostics = .{};
    traits.sign(domain, m, &diag) catch |err| return bd.linkFailed(err, &diag);

    const count = traits.paramCount.get(m);
    const required = count - traits.optionalCount.get(m);
    if (argc < required or (argc > count and !domain.allowsExtraArgs(m))) {
        return bd.fail(C.kWrongArgumentCountError);
    }

    const start = traits.paramStart.get(m);
    var k: u32 = 1;
    while (k <= argc) : (k += 1) {
        const target = if (k <= count) traits.paramType.get(start + k - 1) else .any;
        try bd.coerce(bd.peek(argc - k + 1), target);
    }

    try bd.coerce(bd.peek(argc +% 1), traits.receiverType.get(m));
}

/// As Verifier::emitCoerceSuper: the receiver at i becomes the declaring class's base.
pub fn coerceSuper(bd: *BodyDecoder, i: u32) Error!TypeId {
    const base = if (bd.declarer != .none) bd.domain.traits.base.get(bd.declarer.index()) else .none;
    if (base == .none) {
        return bd.fail(C.kIllegalSuperCallError);
    }

    try bd.coerce(i, base.toType());
    bd.rowC = ir_.typeColumn(base.toType());
    return base.toType();
}

/// As Verifier::checkEarlySlotBinding and checkSlot: `type` must come from
/// this ABC and allow early binding, and have slot `slot`, whose type this
/// returns.
pub fn slot(bd: *BodyDecoder, ty: TypeId, at: u32) Error!TypeId {
    const domain = bd.domain;
    const traits = &domain.traits;
    if (!ty.isTraits() or traits.abc.get(ty.index()) != bd.index or !traits.allowEarlyBinding(ty.index())) {
        return bd.fail(C.kIllegalEarlyBindingError);
    }

    const t = ty.index();
    var diag: Diagnostics = .{};
    traits.resolve(domain, t, &diag) catch |err| return bd.linkFailed(err, &diag);
    if (at >= traits.slotCount.get(t)) {
        return bd.fail(C.kSlotExceedsCountError);
    }

    return traits.slotType.get(traits.slotStart.get(t) + at);
}

/// As Verifier::checkGetGlobalScope: push the global object; its type.
pub fn globalScope(bd: *BodyDecoder) Rejected!TypeId {
    const outer = bd.outer;
    if (outer.size > 0) {
        const t = outer.types[0];
        bd.push(t, .{ .not_null = true });
        return t;
    }

    if (bd.scope == 0) {
        return bd.failWith(C.kGetScopeObjectBoundsError, 0, 0);
    }

    const i = bd.localCount;
    bd.push(bd.typeOf(i), .{ .not_null = bd.valueFlags[i].not_null });
    return bd.typeOf(i);
}

/// As Verifier::emitFindProperty: the scope object a name is found on, from
/// the innermost scope out, stopping at a with scope, then the scripts that
/// define it; else an Object, after the runtime name parts are popped.
///
/// Where no scope binds it statically, avmplus' JIT and interpreter both
/// search again at run time (CodegenLIR turns findpropglobal back into
/// findproperty), and MethodEnv::findproperty asks each local scope's
/// traits at run time: a subclass instance, or an object as `this`, may
/// bind a name its type does not. So the global lookup first asks the
/// local scopes whose type may be narrower at run time (globalSearch).
pub fn findProperty(bd: *BodyDecoder, opcode: Op, mn: u32) Error!void {
    const domain = bd.domain;
    const outer = bd.outer;
    const top: i32 = @bitCast(bd.stackBase() + bd.stack);
    var global = false;
    var locals: u32 = 0;
    if (types.isBindingName(domain, bd.index, mn)) {
        // With no outer scopes, the global object is a local scope, which is not bound early.
        const base: i32 = @intCast(bd.localCount + @intFromBool(outer.size == 0));
        var i: i32 = @as(i32, @intCast(bd.localCount + bd.scope)) - 1;
        while (i >= base) : (i -= 1) {
            const v: u32 = @intCast(i);
            const b = try binding(bd, bd.typeOf(v), mn);

            if (b != Binding.none) {
                bd.push(bd.typeOf(v), .{ .not_null = bd.valueFlags[v].not_null });
                return emitFound(bd, .getscopeobject, top, i, v - bd.localCount, 0);
            }

            if (bd.valueFlags[v].with) {
                break;
            }
        }

        if (i < base) {
            var j: i32 = @as(i32, @intCast(outer.size)) - 1;
            while (j > 0) : (j -= 1) {
                const t = outer.types[@intCast(j)];
                const b = try binding(bd, t, mn);

                if (b != Binding.none) {
                    bd.push(t, .{ .not_null = true });
                    return emitFound(bd, .getouterscope, top, -1, @intCast(j), 0);
                }

                if (outer.withs[@intCast(j)] != 0) {
                    break;
                }
            }

            if (j <= 0) {
                const script = domain.findScript(bd.index, mn);
                if (script != .none) {
                    bd.push(script.toType(), .{ .not_null = true });

                    // Defined by this very script: its global object.
                    if (domain.traits.init.get(script.index()) == @as(i32, @bitCast(bd.global))) {
                        return if (outer.size > 0)
                            emitFound(bd, .getouterscope, top, -1, 0, 0)
                        else
                            emitFound(bd, .ir_get_global_scope, top, -1, 0, 0);
                    }

                    return emitFound(bd, .finddef, top, -1, mn, ir_.typeColumn(script.toType()));
                }

                global = true;
                locals = globalSearch(bd);
            }
        }
    }

    const n = try propertyDepth(bd, mn, 1);

    bd.popPush(n - 1, domain.objectType(), .{ .not_null = true });
    if (global) {
        const op: IrOp = if (opcode == .findproperty) .ir_find_prop_global else .ir_find_prop_global_strict;
        return emitFound(bd, op, top, -1, mn, @bitCast(locals));
    }

    const at: i32 = @as(i32, @bitCast(bd.stackBase() + bd.stack)) - @as(i32, @bitCast(n - 1));
    if (bd.emitPass) {
        try bd.emit(ir_.of(opcode), at, at, n - 1, mn, 0, 0, bd.pc);
        bd.emitted = true;
    }
}

/// For a name no scope binds statically: 1 + the first local scope that
/// MethodEnv::findproperty asks by its traits at run time, if one may bind
/// more than its type says, else 0. A class method's first scope keeps its
/// class's type (the Scope's extra), and with no outer scopes the first is
/// the global object, looked up last; a function's `this` is any object.
/// A class, script, activation or catch scope is of exactly its type.
fn globalSearch(bd: *BodyDecoder) u32 {
    const traits = &bd.domain.traits;
    const outer = bd.outer;
    const from: u32 = if (outer.size > 0 and outer.extra == .any) 0 else 1;
    var d = from;
    while (d < bd.scope) : (d += 1) {
        const t = bd.typeOf(bd.localCount + d);
        if (!t.isTraits()) {
            return from + 1;
        }

        switch (traits.kind.get(t.index())) {
            .class, .script, .activation, .catch_scope => {},
            else => return from + 1,
        }
    }

    return 0;
}

/// The IR of where a name was found, pushed into register `dst`.
fn emitFound(bd: *BodyDecoder, op: IrOp, dst: i32, src: i32, a: u32, c: i32) Error!void {
    if (bd.emitPass) {
        try bd.emit(op, dst, src, if (src >= 0) 1 else 0, a, 0, c, bd.pc);
        bd.emitted = true;
    }
}

/// As Verifier's OP_finddef: the global object of the script that defines `mn`, else Object.
pub fn findDef(bd: *BodyDecoder, mn: u32) void {
    const domain = bd.domain;
    const script = domain.findScript(bd.index, mn);
    return bd.push(if (script != .none) script.toType() else domain.objectType(), .{ .not_null = true });
}

/// As Verifier::emitGetProperty: a slot's or getter's type when the name
/// binds early, a Vector's element type for a numeric index, else *.
pub fn getProperty(bd: *BodyDecoder, mn: u32, n: u32) Error!void {
    const domain = bd.domain;
    const obj = bd.peek(n);
    const ty = bd.typeOf(obj);
    const b = try binding(bd, ty, mn);

    var propType = try readBinding(bd, ty, b);

    try bd.checkNull(obj);
    const kind = b.kind;
    if (kind == .variable or kind == .constant) {
        // The builtin global's Math and Number are never null.
        const notNull = domain.traits.abc.get(ty.index()) == @as(u32, @bitCast(domain.builtinAbc)) and domain.isMathOrNumber(bd.index, mn);
        bd.popPush(n, propType, .{ .not_null = notNull });
        return bd.emitOn(.getslot, @bitCast(obj), @bitCast(obj), 1, b.index(), 0, 0);
    }

    if (kind == .get or kind == .get_set) {
        const t = ty.index();
        const getter = domain.traits.dispatch.get(domain.traits.dispatchStart.get(t) + b.index());
        if (getter >= 0) {
            try coerceArgs(bd, @intCast(getter), 0);
        }

        bd.popPush(n, propType, notNullIf(bd, propType));
        // An interface's accessor has no dispatch id of its own on the
        // receiver: its name finds the receiver's.
        if (domain.traits.isInterface.get(t) != 0) {
            return bd.emitOn(.getproperty, @bitCast(obj), @bitCast(obj), n, mn, 0, 0);
        }

        return bd.emitOn(.ir_call_getter, @bitCast(obj), @bitCast(obj), 1, b.index(), 0, getter);
    }

    if (propType == .any and numericIndex(bd, mn)) {
        if (ty == domain.vectorIntType) {
            propType = domain.intType;
        } else if (ty == domain.vectorUintType) {
            propType = domain.uintType;
        } else if (ty == domain.vectorDoubleType) {
            propType = domain.numberType;
        } else if (ty.isTraits() and domain.vectorObjectType != .any and
            try domain.traits.subtypeOf(domain.scratch, ty.index(), domain.vectorObjectType.index()))
        {
            propType = domain.traits.param.get(ty.index());
        }
    }

    bd.popPush(n, propType, notNullIf(bd, propType));
    return bd.emitOn(.getproperty, @bitCast(obj), @bitCast(obj), n, mn, 0, 0);
}

/// Whether multiname `mn` is a runtime name in a public namespace, not an
/// attribute, and the top of the stack, its name, is a number.
fn numericIndex(bd: *BodyDecoder, mn: u32) bool {
    const domain = bd.domain;
    const parts = code_.nameParts(&bd.abc.pool, mn);
    if (parts.attr or !parts.rtname or !domain.hasPublicNamespace(bd.index, mn)) {
        return false;
    }

    const t = bd.typeOf(bd.peek(1));
    return t == domain.intType or t == domain.uintType or t == domain.numberType;
}

/// As Verifier's OP_setproperty and OP_initproperty.
pub fn setProperty(bd: *BodyDecoder, opcode: Op, mn: u32) Error!void {
    const domain = bd.domain;
    const n = try propertyDepth(bd, mn, 2);

    const obj = bd.peek(n);
    const ty = bd.typeOf(obj);
    const b = try binding(bd, ty, mn);

    const propType = try readBinding(bd, ty, b);

    try bd.checkNull(obj);
    const kind = b.kind;
    const top = bd.peek(1);

    // A var, or a const set by the initializer of the traits declaring it.
    if (kind == .variable or
        (kind == .constant and opcode == .initproperty and domain.initOfDeclarer(ty, bd.index, mn) == @as(i32, @bitCast(bd.global))))
    {
        try bd.coerce(top, propType);
        return bd.emitOn(.setslot, -1, @bitCast(obj), 2, b.index(), 0, 0);
    }

    if (kind == .set or kind == .get_set) {
        const t = ty.index();
        const setter = domain.traits.dispatch.get(domain.traits.dispatchStart.get(t) + b.index() + 1);
        if (setter >= 0) {
            try coerceArgs(bd, @intCast(setter), 1);
        }

        if (domain.traits.isInterface.get(t) != 0) {
            return bd.emitOn(ir_.of(opcode), -1, @bitCast(obj), n, mn, 0, 0);
        }

        return bd.emitOn(.ir_call_setter, -1, @bitCast(obj), 2, b.index() + 1, 0, setter);
    }

    if (numericIndex(bd, mn)) {
        if (ty == domain.vectorIntType) {
            try bd.coerce(top, domain.intType);
        } else if (ty == domain.vectorUintType) {
            try bd.coerce(top, domain.uintType);
        } else if (ty == domain.vectorDoubleType) {
            try bd.coerce(top, domain.numberType);
        }
    }

    // An instance's const initialized anywhere but in its declarer's
    // initializer is written as setproperty writes it: ReferenceError 1074.
    // A global's is left to initproperty: a SWF loaded again into the one
    // domain initializes its classes on the first load's global.
    const late = kind == .constant and opcode == .initproperty and ty.isTraits() and domain.traits.kind.get(ty.index()) == .instance;
    const write: Op = if (late) .setproperty else opcode;
    return bd.emitOn(ir_.of(write), -1, @bitCast(obj), n, mn, 0, 0);
}

/// As Verifier::emitCallproperty and emitCallpropertyMethod.
pub fn callProperty(bd: *BodyDecoder, opcode: Op, mn: u32, argc: u32) Error!void {
    const domain = bd.domain;
    const traits = &domain.traits;
    const n = try propertyDepth(bd, mn, argc +% 1);

    const obj = bd.peek(n);
    const ty = bd.typeOf(obj);
    if (ty.isTraits()) {
        var diag: Diagnostics = .{};
        traits.resolve(domain, ty.index(), &diag) catch |err| return bd.linkFailed(err, &diag);
    }

    var b = try binding(bd, ty, mn);

    try bd.checkNull(obj);
    const voidCall = opcode == .callpropvoid;
    if (b.kind == .method) {
        b = try fasterCall(bd, ty, mn, b, argc);
        const t = ty.index();
        const m = traits.dispatch.get(traits.dispatchStart.get(t) + b.index());
        if (m >= 0) {
            const mu: u32 = @intCast(m);
            var diag: Diagnostics = .{};
            traits.sign(domain, mu, &diag) catch |err| return bd.linkFailed(err, &diag);

            const count = traits.paramCount.get(mu);
            const required = count - traits.optionalCount.get(mu);
            if (argc >= required and (argc <= count or domain.allowsExtraArgs(mu))) {
                try coerceArgs(bd, mu, argc);

                const result = traits.returnType.get(mu);
                bd.popPush(n, result, notNullIf(bd, result));

                // An interface's method has no dispatch id of its own on the receiver.
                const call: IrOp = if (traits.isInterface.get(t) != 0) .ir_call_interface else .callmethod;
                return bd.emitOn(call, if (voidCall) -1 else @bitCast(obj), @bitCast(obj), n, b.index(), argc, m);
            }
        }
    } else if ((b.kind == .variable or b.kind == .constant) and argc == 1) {
        // Calling a class slot with one argument converts or coerces to the class.
        const slotType = types.bindingType(domain, ty, b);
        const top = bd.peek(1);
        if (domain.conversionOf(slotType)) |converted| {
            if (converted.isTraits() and domain.isConversion(slotType)) {
                bd.setValue(top, converted, .{ .not_null = true });
                try bd.emitOn(conversionOp(bd, converted), @bitCast(top), @bitCast(top), 1, 0, 0, 0);
            } else {
                try bd.coerce(top, converted);
            }

            bd.emitted = bd.emitPass;
            if (voidCall) {
                return;
            }

            const flags = bd.valueFlags[top];
            const value = bd.typeOf(top);
            bd.popPush(n, value, .{ .not_null = flags.not_null });
            return bd.emitOn(.ir_nip, @bitCast(obj), @bitCast(obj), n, 0, 0, 0);
        }
    }

    bd.popPush(n, .any, .none);
    return bd.emitOn(ir_.of(opcode), if (voidCall) -1 else @bitCast(obj), @bitCast(obj), n, mn, argc, 0);
}

/// The convert opcode that gives `type`, one of the builtin conversions.
fn conversionOp(bd: *BodyDecoder, ty: TypeId) IrOp {
    const domain = bd.domain;
    if (ty == domain.intType) {
        return .convert_i;
    }

    if (ty == domain.uintType) {
        return .convert_u;
    }

    if (ty.isBuiltin(domain.floatType)) {
        return .convert_f;
    }

    if (ty == domain.numberType) {
        return .convert_d;
    }

    return if (ty == domain.booleanType) .convert_b else .convert_s;
}

/// As Verifier::findMathFunction and findStringFunction: Math's and
/// String's methods have variants named with a leading underscore for
/// arguments of the right types.
fn fasterCall(bd: *BodyDecoder, ty: TypeId, mn: u32, b: Binding, argc: u32) Error!Binding {
    const domain = bd.domain;
    if (!ty.isTraits() or (ty != domain.mathStatic and ty != domain.stringType)) {
        return b;
    }

    const name = try domain.underscored(bd.index, mn);
    const traits = &domain.traits;
    const faster = if (name < 0) Binding.none else traits.findName(ty, @intCast(name));
    if (faster.kind != .method) {
        return b;
    }

    const m = traits.dispatch.get(traits.dispatchStart.get(ty.index()) + faster.index());
    if (m < 0 or !try traits.signs(domain, @intCast(m))) {
        return b;
    }

    const mu: u32 = @intCast(m);
    const count = traits.paramCount.get(mu);
    const start = traits.paramStart.get(mu);
    if (ty == domain.mathStatic) {
        if (argc != count) {
            return b;
        }

        var k: u32 = 1;
        while (k <= argc) : (k += 1) {
            const t = bd.typeOf(bd.peek(argc - k + 1));
            if (t == .any or !types.isNumeric(domain, t)) {
                return b;
            }
        }

        return faster;
    }

    if (argc < count - traits.optionalCount.get(mu) or argc > count) {
        return b;
    }

    var k: u32 = 1;
    while (k <= argc) : (k += 1) {
        if (bd.typeOf(bd.peek(argc - k + 1)) != traits.paramType.get(start + k - 1)) {
            return b;
        }
    }

    return faster;
}

/// As Verifier's OP_callstatic: a bound method, called with its signature.
pub fn callStatic(bd: *BodyDecoder, m: u32, argc: u32) Error!void {
    const domain = bd.domain;
    const traits = &domain.traits;
    const global = domain.methodStart.get(bd.index) + m;
    var diag: Diagnostics = .{};
    traits.sign(domain, global, &diag) catch |err| return bd.linkFailed(err, &diag);

    if (traits.receiverType.get(global) == .any) {
        return bd.fail(C.kDanglingFunctionError);
    }

    try bd.checkNull(bd.peek(argc +% 1));
    try coerceArgs(bd, global, argc);

    const result = traits.returnType.get(global);
    bd.rowC = @bitCast(global);
    return bd.popPush(argc +% 1, result, notNullIf(bd, result));
}

/// As Verifier's OP_callsuper and OP_callsupervoid.
pub fn callSuper(bd: *BodyDecoder, opcode: Op, mn: u32, argc: u32) Error!void {
    const domain = bd.domain;
    const traits = &domain.traits;
    const n = try propertyDepth(bd, mn, argc +% 1);

    const obj = bd.peek(n);
    const base = try coerceSuper(bd, obj);

    const b = try binding(bd, base, mn);

    var result: TypeId = .any;
    var m: i32 = -1;
    if (b.kind == .method) {
        var diag: Diagnostics = .{};
        traits.resolve(domain, base.index(), &diag) catch |err| return bd.linkFailed(err, &diag);
        m = traits.dispatch.get(traits.dispatchStart.get(base.index()) + b.index());
        if (m < 0) {
            return bd.fail(C.kCorruptABCError);
        }

        traits.sign(domain, @intCast(m), &diag) catch |err| return bd.linkFailed(err, &diag);

        result = traits.returnType.get(@intCast(m));
    }

    try bd.checkNull(obj);
    const voidCall = opcode == .callsupervoid;
    // As CodegenLIR's callsuper: a method of the base that takes the count,
    // its arguments coerced here and the method called directly.
    if (m >= 0 and n == argc +% 1) {
        const mu: u32 = @intCast(m);
        const count = traits.paramCount.get(mu);
        const required = count - traits.optionalCount.get(mu);
        if (argc >= required and (argc <= count or domain.allowsExtraArgs(mu))) {
            try coerceArgs(bd, mu, argc);

            if (!voidCall) {
                bd.popPush(n, result, notNullIf(bd, result));
            }

            return bd.emitOn(.ir_call_super, if (voidCall) -1 else @bitCast(obj), @bitCast(obj), n, b.index(), argc, m);
        }
    }

    if (!voidCall) {
        bd.popPush(n, result, notNullIf(bd, result));
    }
}

/// As Verifier's OP_getsuper.
pub fn getSuper(bd: *BodyDecoder, mn: u32) Error!void {
    const n = try propertyDepth(bd, mn, 1);

    const obj = bd.peek(n);
    const base = try coerceSuper(bd, obj);

    const b = try binding(bd, base, mn);

    const propType = try readBinding(bd, base, b);

    try bd.checkNull(obj);
    return bd.popPush(n, propType, notNullIf(bd, propType));
}
