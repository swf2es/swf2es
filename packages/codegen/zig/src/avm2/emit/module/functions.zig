// A ModuleEmitter's (module.zig) functions: a factory a method, a part at a
// time, its native arity, the VerifyError it throws, and the names it is
// written with. Its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const Error = Allocator.Error;
const code = @import("../../abc/code.zig");
const BodyDecoder = code.BodyDecoder;
const C = @import("../../abc/constants.zig");
const refs = @import("../refs.zig");
const stack_names = @import("../stack-names.zig");
const module_ = @import("../module.zig");
const ModuleEmitter = module_.ModuleEmitter;
const EMIT_COST = module_.EMIT_COST;
const List = module_.List;

/// F's entries from the cursor on, a factory per method (module.ts tells
/// each kind), until `spent` reaches `budget`: whether F is done.
pub fn functions(self: *ModuleEmitter, budget: u64) Error!bool {
    const o = self.out();
    const domain = self.domain;
    const abc = domain.abcs.get(self.index);
    const results = self.results;
    // Asked for again by each part, as another may have retargeted it.
    const decoder = try code.bodyDecoder(domain, self.index);
    const start = domain.methodStart.get(self.index);
    while (self.cursor < abc.methodCount()) {
        if (self.spent >= budget) {
            return false;
        }

        const m = self.cursor;
        self.cursor += 1;
        const before = o.len();
        try o.text(if (m != 0) ",\n    " else "\n    ");
        const global = start + m;
        const body = abc.methodBody[m];
        if (abc.methodFlags[m].native) {
            try o.text("rt.native(");
            try self.nativeName(global);
            try self.nativeArity(global);
            try o.text(")");
            continue;
        }

        if (body < 0) {
            try o.text("rt.noBody(");
            try self.units(try stack_names.stackName(domain, self.methods.gpa, self.index, global), "()");
            try o.text(")");
            continue;
        }

        const b: u32 = @intCast(body);
        const result = results[b];
        if (result < 0) {
            try o.text("rt.unverified");
            continue;
        }

        if (result > 0) {
            try self.verifyError(result, global, b, decoder);
            continue;
        }

        _ = try decoder.decode(b, domain.traits.scopeOf(global));
        try self.entryBody.append(self.persist, b);
        try self.entryStart.append(self.persist, o.len());
        try self.factory(m, global, decoder);
        try self.entryEnd.append(self.persist, o.len());
        self.spent += @as(u64, o.len() - before) * EMIT_COST;
    }

    return true;
}

/// Method m's entry in F, from its IR in `decoder`: `(scope, sup) =>
/// function`, inside a function of its table T if it has one; the same
/// whether the module is being written or the method compiled alone.
pub fn factory(self: *ModuleEmitter, m: u32, global: u32, decoder: *BodyDecoder) Error!void {
    const o = self.out();
    const methods = &self.methods;
    methods.newTypes();
    const at = o.len();
    const marks = methods.map.count();
    methods.functionName = try self.functionName(global);
    methods.claims = decoder.claims.items;
    try methods.method(m, global, &decoder.ir);
    methods.functionName = "";
    // Its parameters, up to the last the method uses; $dx: the default XML
    // namespace when the factory runs, as avmplus' scope chain captures it.
    const params = if (methods.seesDxns)
        "(scope, sup, $dx = rt.defaultXmlNamespace) => "
    else if (methods.usesSup)
        "(scope, sup) => "
    else if (methods.usesScope)
        "(scope) => "
    else
        "() => ";
    try o.insert(at, params);
    methods.map.shift(marks, @intCast(params.len));
    const types = methods.types.items;
    if (types.len == 0) {
        return;
    }

    // The table's function goes before the method, which it now knows the types of.
    const head = "((...T) => ";
    try o.insert(at, head);
    methods.map.shift(marks, head.len);
    try o.text(")(");
    for (types, 0..) |t, k| {
        try o.text(if (k != 0) ", " else "");
        switch (t) {
            .type => |ty| try refs.typeExpr(methods, ty),
            .method => try o.text("null"),
            .literal => |n| {
                try o.text("rt.literalName(M[");
                try o.uint(methods.literalMultinames.items[n]);
                try o.text("], ");
                try refs.poolString(methods, methods.literalStrings.items[n]);
                try o.text(")");
            },
        }
    }

    try o.text(")");
}

/// A native method's argument counts, as MethodEnv's argcOk checks them,
/// when it has any: `, required, max`, max -1 where it takes more than it
/// declares.
pub fn nativeArity(self: *ModuleEmitter, m: u32) Error!void {
    const table = &self.domain.traits;
    // Its signature, as avmplus resolves it before the first call; one that
    // fails to resolve fails when called, as the runtime has it.
    if (!try table.signs(self.domain, m)) {
        return;
    }

    const required = table.paramCount.get(m) -% table.optionalCount.get(m);
    const extra = self.domain.allowsExtraArgs(m);
    if (required == 0 and extra) {
        return;
    }

    const o = self.out();
    try o.text(", ");
    try o.uint(required);
    try o.text(", ");
    if (extra) {
        try o.text("-1");
    } else {
        try o.uint(table.paramCount.get(m));
    }
}

/// The factory of method `global`, whose body failed verification with
/// `err`: the VerifyError with the arguments avmplus' message takes
/// (module.ts tells which).
pub fn verifyError(self: *ModuleEmitter, number: i32, global: u32, body: u32, decoder: *BodyDecoder) Error!void {
    const o = self.out();
    try o.text("rt.verifyError(");
    try o.uint(@intCast(number));
    const err = C.VerifyError.of(number);
    switch (err) {
        .kIllegalOpcodeError => {
            try o.text(", ");
            try self.units(try stack_names.stackName(self.domain, self.methods.gpa, self.index, global), "()");
            try self.errorNumbers(err, global, body, decoder, 2);
        },
        .kStackDepthUnbalancedError, .kScopeDepthUnbalancedError => try self.errorNumbers(err, global, body, decoder, 2),
        .kGetScopeObjectBoundsError, .kInvalidRegisterError => try self.errorNumbers(err, global, body, decoder, 1),
        .kIllegalSetDxns, .kIllegalSuperCallError => {
            try o.text(", ");
            try self.units(try stack_names.stackName(self.domain, self.methods.gpa, self.index, global), "()");
        },
        else => {},
    }

    try o.text(")");
}

/// The `count` numbers verifying `body` again records with `err`, as
/// arguments; none for another error, or if it records none.
pub fn errorNumbers(self: *ModuleEmitter, err: C.VerifyError, global: u32, body: u32, decoder: *BodyDecoder, count: u32) Error!void {
    const result = try decoder.decode(body, self.domain.traits.scopeOf(global));
    if (result.@"error" != err or !result.numbered) {
        return;
    }

    const o = self.out();
    try o.text(", ");
    try o.uint(result.errorA);
    if (count > 1) {
        try o.text(", ");
        try o.uint(result.errorB);
    }
}

/// A native method's name, as avmplus binds its C++ ones (module.ts
/// tells the forms).
pub fn nativeName(self: *ModuleEmitter, m: u32) Error!void {
    try self.units(try self.methodName(m), "");
}

/// Method m's name as a JavaScript identifier for its function: its name
/// in a stack trace, escaped (stack-names.zig).
pub fn functionName(self: *ModuleEmitter, m: u32) Error![]const u8 {
    const gpa = self.methods.gpa;
    return stack_names.identifierOf(gpa, try stack_names.stackName(self.domain, gpa, self.index, m));
}

/// Method m's name: "Class.name", "Class#name", or a script's qualified
/// name, "" if no trait binds it; as UTF-16 units, as AssemblyScript's
/// string of it.
pub fn methodName(self: *ModuleEmitter, m: u32) Error![]const u16 {
    const gpa = self.methods.gpa;
    const domain = self.domain;
    const table = &domain.traits;
    const t = table.methodTraits.get(m);
    const abc = domain.abcs.get(self.index);
    const local = m - domain.methodStart.get(self.index);
    var text: List(u16) = .empty;
    if (t == .none) {
        return &.{};
    }

    const tu = t.index();
    const kind = table.kind.get(tu);
    if (kind == .instance or kind == .class) {
        try text.appendSlice(gpa, try refs.className(&self.methods, table, tu));
        try text.append(gpa, if (kind == .class) '.' else '#');
    }

    // The trait that binds the method names it.
    var i = table.first.get(tu);
    while (i < table.end.get(tu)) : (i += 1) {
        const tk = abc.traitTag[i].kind;
        if (tk.bindsMethod() and abc.traitIndex[i] == local) {
            switch (tk) {
                .getter => try text.appendSlice(gpa, &[_]u16{ 'g', 'e', 't', ':' }),
                .setter => try text.appendSlice(gpa, &[_]u16{ 's', 'e', 't', ':' }),
                else => {},
            }

            table.readName(domain, self.index, i);
            try text.appendSlice(gpa, try refs.qualified(&self.methods, table.nameNs, table.nameId));
            return text.items;
        }
    }

    return &.{};
}

/// The text `units` and then `tail`, a string of AssemblyScript's, as
/// a JavaScript string literal, encoded as its String.UTF8 encodes one:
/// WTF-8, a lone surrogate as three bytes of its own.
pub fn units(self: *ModuleEmitter, text: []const u16, tail: []const u8) Error!void {
    const gpa = self.methods.gpa;
    const bytes = try std.unicode.wtf16LeToWtf8Alloc(gpa, text);
    try self.out().string(try std.mem.concat(gpa, u8, &.{ bytes, tail }));
}
