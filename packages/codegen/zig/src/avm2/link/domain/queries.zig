// What the verifier and the emitters ask a Domain (domain.zig) of its types,
// methods, scripts and builtins: its methods, written here and named in it.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../../output.zig");
const errors = @import("../../abc/errors.zig");
const Diagnostics = errors.Diagnostics;
const Error = errors.Error;
const C = @import("../../abc/constants.zig");
const table = @import("../table.zig");
const hashPair = table.hashPair;
const traits_ = @import("../traits.zig");
const Binding = traits_.Binding;
const TypeId = traits_.TypeId;
const TypeRef = traits_.TypeRef;
const typenames = @import("../typenames.zig");
const types = @import("../types.zig");
const domain_ = @import("../domain.zig");
const Domain = domain_.Domain;
const API_Internal = domain_.API_Internal;
const URI_None = domain_.URI_None;
const firstMember = domain_.firstMember;
const isAtom = domain_.isAtom;

/// Whether the machine type always holds a value: int, uint, Number and Boolean.
pub fn typeNotNull(self: *const Domain, type_: TypeId) bool {
    const bt = self.builtin(type_);
    return bt == .int or
        bt == .uint or
        bt == .number or
        bt == .boolean or
        bt == .float;
}

/// The traits of Class's instances, which class objects are.
pub fn classInstanceType(self: *const Domain) TypeId {
    // Class's, unlinked, reads as *, as no Class does.
    return if (self.classClass < 0) .any else self.classTraits.get(@intCast(self.classClass)).orAny();
}

/// The class object traits of class `i` of ABC `index`.
pub fn staticTraitsOf(self: *const Domain, index: u32, i: u32) TypeId {
    // An unlinked class's reads as *.
    return self.classStatic.get(self.classStart.get(index) + i).orAny();
}

/// As Traits::itraits: for a class object's traits, its instances'; else *.
pub fn instanceTraitsOf(self: *const Domain, type_: TypeId) TypeId {
    const traits = &self.traits;
    if (!type_.isTraits() or traits.kind.get(type_.index()) != .class) {
        return .any;
    }

    const t = type_.index();
    // An unlinked class's reads as *.
    return self.classTraits.get(self.classStart.get(traits.abc.get(t)) + traits.owner.get(t)).orAny();
}

/// As Verifier::checkTypeName: the type multiname `mn` of ABC `index` names,
/// void included, and Vector.<T>, or * for another parameterized type.
/// AssemblyScript recurses into a TypeName's parameter; this walks the
/// chain down, keeping each level's class, and makes the types back up.
pub fn checkTypeName(self: *Domain, index: u32, multiname: u32, diag: *Diagnostics) Error!TypeId {
    const pool = &self.abcs.get(index).pool;
    // Each level's class, or -1 for void (an i32 list, as a list of
    // ?u32 would be another copy of append).
    var classes_: std.ArrayList(i32) = .empty;
    var mn = multiname;
    const innermost: TypeId = while (true) {
        const isTypeName = pool.mnKind[mn] == .type_name;
        const c: i32 = if (typenames.resolveType(self, index, if (isTypeName) pool.mnA[mn] else mn, diag)) |id| @intCast(id) else |err| switch (err) {
            error.Void => -1,
            error.Verify => return error.Verify,
        };
        if (!isTypeName) {
            // A class not linked yet reads as *.
            break if (c >= 0) self.classTraits.get(@intCast(c)).orAny() else self.voidType;
        }

        try classes_.append(self.scratch, c);
        mn = pool.mnB[mn];
        if (mn == 0) {
            break .any;
        }
    };

    var param = innermost;
    var level = classes_.items.len;
    while (level > 0) {
        level -= 1;
        const c = classes_.items[level];
        const t: TypeRef = if (c >= 0) try typenames.parameterized(self, @intCast(c), param) else .none;
        // Not a Vector, or a builtin Vector absent: *.
        param = t.orAny();
    }

    return param;
}

/// Whether method m takes any number of extra arguments: into a rest or
/// arguments array, or as a function avmplus lets ignore them (see
/// TraitsTable.sign).
pub fn allowsExtraArgs(self: *const Domain, m: u32) bool {
    const index = self.methodAbc(m);
    const abc = self.abcs.get(index);
    const local = m - self.methodStart.get(index);
    const flags = abc.methodFlags[local];
    if (flags.need_rest or flags.need_arguments) {
        return true;
    }

    return self.traits.ignoresRest.get(m) != 0;
}

/// Add to `out` the methods bound to traits t: its initializer, methods, getters and setters.
pub fn methodsOf(self: *const Domain, gpa: Allocator, t: u32, out: *std.ArrayList(u32)) Allocator.Error!void {
    const traits = &self.traits;
    const index = traits.abc.get(t);
    const abc = self.abcs.get(index);
    const methods = self.methodStart.get(index);
    const initializer = traits.init.get(t);
    if (initializer >= 0) {
        try out.append(gpa, @intCast(initializer));
    }

    var i = traits.first.get(t);
    while (i < traits.end.get(t)) : (i += 1) {
        const kind = abc.traitTag[i].kind;
        if (kind.bindsMethod()) {
            try out.append(gpa, methods + abc.traitIndex[i]);
        }
    }
}

/// Whether method m is a method, getter or setter of some traits, which callstatic may call.
pub fn isVirtual(self: *const Domain, m: u32) bool {
    return self.traits.methodVirtual.get(m) != 0;
}

/// Whether callstatic may call method m, as avmplus' AbcEnv keeps an
/// environment for it once its traits have a vtable: a method, getter or
/// setter of some traits, or the initializer of a class or of its
/// instances. A script's has none outside AOT.
pub fn staticallyCallable(self: *const Domain, m: u32) bool {
    const traits = &self.traits;
    if (traits.methodVirtual.get(m) != 0) {
        return true;
    }

    const t = traits.methodTraits.get(m);
    return t != .none and traits.init.get(t.index()) == @as(i32, @bitCast(m)) and traits.kind.get(t.index()) != .script;
}

/// As DomainMgr::findScriptInPoolByMultiname: the global object traits of
/// the one script that defines multiname `mn` of ABC `index`, or none
/// for none or several.
pub fn findScript(self: *const Domain, index: u32, multiname: u32) TypeRef {
    const pool = &self.abcs.get(index).pool;
    var mn = multiname;
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    const ids = self.abcNs.get(index);
    const versions = self.abcNsVersion.get(index);
    const name = self.abcString.get(index)[pool.mnB[mn]];
    if (pool.mnKind[mn] == .qname) {
        const ns = pool.mnA[mn];
        return self.scriptOf(self.find(ids[ns], name, versions[ns], self.abcDomain.get(index)));
    }

    var found: TypeRef = .none;
    for (pool.nsSet(pool.mnA[mn])) |ns| {
        const script = self.scriptOf(self.find(ids[ns], name, versions[ns], self.abcDomain.get(index)));
        if (script != .none) {
            if (found != .none and found != script) {
                return .none;
            }

            found = script;
        }
    }

    return found;
}

/// The global object traits of the script binding b is in, or none.
pub fn scriptOf(self: *const Domain, b: i32) TypeRef {
    if (b < 0) {
        return .none;
    }

    const index = self.bindingAbc.get(@intCast(b));
    return .of(self.scriptTraits.get(index)[self.bindingScript.get(@intCast(b))]);
}

/// The interned id of multiname `mn`'s name with a leading underscore,
/// or -1 if no ABC has it. AssemblyScript decodes the name to a string
/// and encodes `_` and it again, so a name that is not valid UTF-8 is
/// looked up as the decoding wrote it (output.writeDecoded).
pub fn underscored(self: *const Domain, index: u32, mn: u32) Allocator.Error!i32 {
    return self.underscoredName(self.nameOf(index, mn));
}

/// underscored, of interned name `name`.
pub fn underscoredName(self: *const Domain, name: u32) Allocator.Error!i32 {
    var underscore: std.Io.Writer.Allocating = .init(self.scratch);
    underscore.writer.writeByte('_') catch return error.OutOfMemory;
    output.writeDecoded(&underscore.writer, self.stringOf(name)) catch return error.OutOfMemory;
    return self.findText(underscore.written());
}

/// Whether multiname `mn` of ABC `index` is named Math or Number.
pub fn isMathOrNumber(self: *const Domain, index: u32, mn: u32) bool {
    const pool = &self.abcs.get(index).pool;
    const name: i32 = @bitCast(self.abcString.get(index)[pool.mnB[mn]]);
    return name == self.findText("Math") or name == self.findText("Number");
}

/// As Multiname::containsAnyPublicNamespace, for a multiname with a namespace set.
pub fn hasPublicNamespace(self: *const Domain, index: u32, mn: u32) bool {
    const pool = &self.abcs.get(index).pool;
    const kind = pool.mnKind[mn];
    if (kind != .multiname and kind != .multiname_l and kind != .multiname_la) {
        return false;
    }

    for (pool.nsSet(pool.mnA[mn])) |member| {
        // As Namespace::isPublic: of the public kind, and with an empty URI.
        const ns = self.abcNs.get(index)[member];
        const uri = self.nsUri.get(ns);
        if (self.nsType.get(ns) == .public and (uri == URI_None or self.stringLength.get(uri) == 0)) {
            return true;
        }
    }

    return false;
}

/// As TraitsBindings::findBindingAndDeclarer: the initializer of the traits
/// that declares what multiname `mn` of ABC `index` binds to on `type`, a
/// protected member belonging to the first base that has it; -1 if none.
pub fn initOfDeclarer(self: *Domain, type_: TypeId, index: u32, mn: u32) i32 {
    const traits = &self.traits;
    var it = traits.bases(.ofType(type_));
    while (it.next()) |t| {
        const b = types.getOwnBinding(self, index, t, mn);
        if (b == Binding.none) {
            continue;
        }

        var declarer = TypeRef.of(t);
        var ns = self.foundNs;
        while (ns == traits.protectedNs.get(declarer.index())) {
            const parent = traits.base.get(declarer.index());
            if (parent == .none or traits.protectedNs.get(parent.index()) < 0) {
                break;
            }

            const parentNs: u32 = @intCast(traits.protectedNs.get(parent.index()));
            const name = self.nameOf(index, mn);
            if (traits.find(parent.toType(), parentNs, name, API_Internal) != b) {
                break;
            }

            declarer = parent;
            ns = @intCast(parentNs);
        }

        return traits.init.get(declarer.index());
    }

    return -1;
}

/// The interned name of multiname `mn` of ABC `index`.
pub fn nameOf(self: *const Domain, index: u32, multiname: u32) u32 {
    const pool = &self.abcs.get(index).pool;
    var mn = multiname;
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    return self.abcString.get(index)[pool.mnB[mn]];
}

/// As Verifier::emitCallpropertySlot: what calling a class slot of type
/// `slotType` with one argument does to it: the builtin conversions give
/// int, uint, Number, Boolean or String, a user class coerces to it, and
/// anything else is a call (null).
pub fn conversionOf(self: *const Domain, slotType: TypeId) ?TypeId {
    if (!slotType.isTraits()) {
        return null;
    }

    if (self.floatType != .any and slotType == self.staticOf(self.floatType)) {
        return self.floatType;
    }

    for ([_]TypeId{ self.intType, self.uintType, self.numberType, self.booleanType, self.stringType }) |ty| {
        if (ty != .any and slotType == self.staticOf(ty)) {
            return ty;
        }
    }

    const traits = &self.traits;
    const s = slotType.index();
    if (traits.kind.get(s) == .class and
        // No base reads as *, which classInstanceType gives with no Class.
        traits.base.get(s).orAny() == self.classInstanceType() and
        !self.abcs.get(traits.abc.get(s)).builtin)
    {
        return self.instanceTraitsOf(slotType);
    }

    return null;
}

/// Whether calling class slot `slotType` converts to a builtin primitive, never null.
pub fn isConversion(self: *const Domain, slotType: TypeId) bool {
    const converted = self.conversionOf(slotType) orelse return false;
    return converted.isBuiltin(self.intType) or
        converted.isBuiltin(self.uintType) or
        converted.isBuiltin(self.numberType) or
        converted.isBuiltin(self.floatType) or
        converted.isBuiltin(self.booleanType) or
        converted.isBuiltin(self.stringType);
}

/// The class object traits of instance traits `type`.
pub fn staticOf(self: *const Domain, type_: TypeId) TypeId {
    const traits = &self.traits;
    const t = type_.index();
    const index = traits.abc.get(t);
    // An unlinked class's reads as *.
    return self.classStatic.get(self.classStart.get(index) + traits.owner.get(t)).orAny();
}

/// The catch scope of handler `h` of ABC `index`, as Traits::newCatchTraits:
/// one slot, named `name`, of the handler's exception type.
pub fn catchTraits(self: *Domain, index: u32, h: u32, name: u32, type_: TypeId) Allocator.Error!TypeId {
    const key = (@as(u64, index) << 32) | h;
    const hash = hashPair(index, h);
    var slot = self.catchScopes.start(hash);
    while (self.catchScopes.at(slot) >= 0) : (slot = self.catchScopes.next(slot)) {
        const id: u32 = @intCast(self.catchScopes.at(slot));
        if (self.catchKey.get(id) == key) {
            return .of(self.catchValue.get(id));
        }
    }

    const gpa = self.gpa;
    const pool = &self.abcs.get(index).pool;
    var mn = name;
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    const traits = &self.traits;
    const t = try traits.create(gpa, .catch_scope, index, h, .none, -1, 0, 0);
    const start = traits.memberTraits.len;
    traits.memberStart.set(t, start);
    traits.memberEnd.set(t, start);
    var ns = pool.mnA[mn];
    if (pool.mnKind[mn] == .multiname) {
        ns = firstMember(pool, ns);
    }

    const nsId = self.abcNs.get(index)[ns];
    const version = self.abcNsVersion.get(index)[ns];
    try traits.add(gpa, t, nsId, self.nameOf(index, name), version, Binding.of(0, .variable));
    traits.slotCount.set(t, 1);
    traits.slotStart.set(t, traits.slotType.len);
    try traits.slotType.push(gpa, type_);
    try traits.slotSet.push(gpa, 1);
    traits.dispatchStart.set(t, traits.dispatch.len);
    traits.resolved.set(t, 1);
    const id = self.catchKey.len;
    try self.catchKey.push(gpa, key);
    try self.catchValue.push(gpa, t);
    try self.catchScopes.insert(gpa, hash, id);
    self.captures += 1;
    return .of(t);
}

/// The Vector.<T> made for `param`, or none.
pub fn vectorFor(self: *const Domain, param: TypeId) TypeRef {
    const hash = hashPair(@bitCast(@backingInt(param)), 0);
    var slot = self.vectorOf.start(hash);
    while (self.vectorOf.at(slot) >= 0) : (slot = self.vectorOf.next(slot)) {
        const id: u32 = @intCast(self.vectorOf.at(slot));
        if (self.vectorParam.get(id) == param) {
            return .of(self.vectorTraits.get(id));
        }
    }

    return .none;
}

pub fn setVectorFor(self: *Domain, param: TypeId, t: u32) Allocator.Error!void {
    const id = self.vectorParam.len;
    try self.vectorParam.push(self.gpa, param);
    try self.vectorTraits.push(self.gpa, t);
    try self.vectorOf.insert(self.gpa, hashPair(@bitCast(@backingInt(param)), 0), id);
}

/// The type of the builtin class `name`, * for one absent or not linked
/// yet, as the builtin type fields hold it.
pub fn builtinType(self: *const Domain, name: []const u8) TypeId {
    const c = self.findBuiltin(name);
    return if (c < 0) .any else self.classTraits.get(@intCast(c)).orAny();
}

/// As DomainMgr::findBuiltinTraitsByName: the first class of the ABC being
/// linked named `name` in any namespace, or -1.
pub fn findBuiltin(self: *const Domain, name: []const u8) i32 {
    const id_text = self.findText(name);
    if (id_text < 0) {
        return -1;
    }

    for (0..self.typeName.len) |id_| {
        const id: u32 = @intCast(id_);
        if (self.typeName.get(id) == @as(u32, @intCast(id_text)) and self.typeOwner.get(id) == self.loads) {
            return @intCast(self.typeClass.get(id));
        }
    }

    return -1;
}

pub fn objectType(self: *const Domain) TypeId {
    // Object's, unlinked, reads as *, as no Object does.
    return if (self.objectClass < 0) .any else self.classTraits.get(@intCast(self.objectClass)).orAny();
}

/// As Traits::getBuiltinType.
pub fn builtin(self: *const Domain, type_: TypeId) traits_.Builtin {
    if (type_ == .any) return .any;
    if (type_ == self.objectType()) return .object;
    if (type_ == self.voidType) return .void;
    if (type_ == self.booleanType) return .boolean;
    if (type_ == self.intType) return .int;
    if (type_ == self.uintType) return .uint;
    if (type_.isBuiltin(self.floatType)) return .float;
    if (type_ == self.numberType) return .number;
    if (type_ == self.stringType) return .string;
    return if (type_ == self.namespaceType) .namespace else .other;
}

/// As Traits::isMachineType: Object, void, Boolean, int, uint and Number.
pub fn isMachineType(self: *const Domain, type_: TypeId) bool {
    const bt = self.builtin(type_);
    return switch (bt) {
        .object, .void, .boolean, .int, .uint, .number, .float => true,
        else => false,
    };
}

/// As Traits::isMachineCompatible: whether a and b have the same representation.
pub fn machineCompatible(self: *const Domain, a: TypeId, b: TypeId) bool {
    if (a == b) {
        return true;
    }

    if (isAtom(self.builtin(a)) and isAtom(self.builtin(b))) {
        return true;
    }

    return a != .any and b != .any and !self.isMachineType(a) and !self.isMachineType(b);
}

pub fn methodAbc(self: *const Domain, m: u32) u32 {
    return self.methodAbcIndex.get(m);
}

/// The namespace id of the public namespace, or -1 if no ABC has one.
pub fn publicNamespace(self: *const Domain) i32 {
    const empty = self.findText("");
    return if (empty < 0) -1 else self.findNamespace(.public, @intCast(empty));
}

/// The version of ABC `index`'s public namespace, as AvmCore::getPublicNamespace(pool).
pub fn publicVersion(self: *const Domain, index: u32) u8 {
    return if (self.abcs.get(index).builtin) API_Internal else self.apiVersion;
}

/// As PoolObject::getLegalDefaultValue: whether constant `value` of `kind`
/// of ABC `index` may be the default of a slot or parameter of `type`.
pub fn checkDefault(self: *const Domain, index: u32, value: u32, kind: C.Constant, type_: TypeId, diag: *Diagnostics) errors.Rejected!void {
    // Legacy ABCs ignore the kind at index zero; AIR's float entry zero is NaN.
    const hasFloats = self.abcs.get(index).hasFloatSupport();
    if (value == 0 and (kind != .float or !hasFloats)) {
        return;
    }

    const illegal: C.VerifyError = if (type_ == .any) .kCorruptABCError else .kIllegalDefaultValue;
    if (kind == .float and !hasFloats) {
        return diag.fail(illegal);
    }

    const constant = self.abcs.get(index).pool.value(kind, value) catch |err| return diag.fail(switch (err) {
        error.IllegalKind => illegal,
        error.OutOfRange => .kCpoolIndexRangeError,
    });
    if (!traits_.legalDefault(self.builtin(type_), constant)) {
        return diag.fail(.kIllegalDefaultValue);
    }
}
