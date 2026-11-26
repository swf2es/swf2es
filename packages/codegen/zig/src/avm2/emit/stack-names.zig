// Each method's name as Flash's debugger player names it in a stack trace
// ("Test/get x", "Test$cinit", "global$init", "Function/<anonymous>"),
// spelled into the JavaScript identifier of its function
// (assembly/avm2/emit/stack-names.ts). AssemblyScript makes the name a
// string, decoding the pool's bytes into UTF-16 units piece by piece; here
// it is those units, so that what is written of them (identifierOf's
// escapes, or Output.text's low byte of each unit) is the same.
const std = @import("std");
const Allocator = std.mem.Allocator;
const output = @import("../../output.zig");
const C = @import("../abc/constants.zig");
const domain_ = @import("../link/domain.zig");
const Domain = domain_.Domain;
const traits_ = @import("../link/traits.zig");

const Units = std.ArrayList(u16);

fn ascii(gpa: Allocator, out: *Units, s: []const u8) Allocator.Error!void {
    for (s) |c| {
        try out.append(gpa, c);
    }
}

/// Method m's (a domain-wide index) name in a stack trace, as the debugger
/// player prints it (stack-names.ts tells each form).
pub fn stackName(dom: *Domain, gpa: Allocator, index: u32, m: u32) Allocator.Error![]u16 {
    const traits = &dom.traits;
    const abc = dom.abcs.get(index);
    const local = m - dom.methodStart.get(index);
    const t = traits.methodTraits.get(m);
    var out: Units = .empty;
    if (t >= 0) {
        const tu: u32 = @intCast(t);
        const kind = traits.kind.get(tu);
        const owner = traits.owner.get(tu);
        var declaring = false;
        if (kind == traits_.TRAITS_Instance or kind == traits_.TRAITS_Class) {
            try className(dom, gpa, &out, traits.abc.get(tu), owner);
            declaring = out.items.len > 0;
            if (kind == traits_.TRAITS_Class) {
                try out.append(gpa, '$');
                declaring = true;
                if (abc.classInit[owner] == local) {
                    try ascii(gpa, &out, "cinit");
                    return out.items;
                }
            } else if (abc.instanceInit[owner] == local) {
                return out.items;
            }
        } else if (kind == traits_.TRAITS_Script) {
            if (abc.scriptInit[owner] == local) {
                try ascii(gpa, &out, "global$init");
                return out.items;
            }

            try ascii(gpa, &out, "global");
            declaring = true;
        }

        if (declaring) {
            var i = traits.first.get(tu);
            while (i < traits.end.get(tu)) : (i += 1) {
                const tk = abc.traitTag[i].kind;
                if (tk.bindsMethod() and abc.traitIndex[i] == local) {
                    traits.readName(dom, index, i);
                    try ascii(gpa, &out, if (tk == .getter) "/get " else if (tk == .setter) "/set " else "/");
                    try shown(dom, gpa, &out, traits.nameNs, traits.nameId);
                    return out.items;
                }
            }
        }

        out.clearRetainingCapacity();
    }

    // The debug name's index is read unchecked, as avmplus reads it: one
    // past the pool is no name, as PoolObject::hasString has it.
    const name = abc.methodName[local];
    if (name == 0 or name >= abc.pool.stringCount()) {
        var digits: [16]u8 = undefined;
        try ascii(gpa, &out, "MethodInfo-");
        try ascii(gpa, &out, std.fmt.bufPrint(&digits, "{d}", .{local}) catch unreachable);
        return out.items;
    }

    const id = dom.abcString.get(index)[name];
    const text = try output.decodeUnits(gpa, dom.stringOf(id));
    try ascii(gpa, &out, "Function/");
    if (text.len > 0) {
        try out.appendSlice(gpa, text);
    } else {
        try ascii(gpa, &out, "<anonymous>");
    }

    return out.items;
}

/// Class `owner` of ABC `index`'s name, as shown: its namespace's URI only where it is public.
fn className(dom: *Domain, gpa: Allocator, out: *Units, index: u32, owner: u32) Allocator.Error!void {
    const abc = dom.abcs.get(index);
    const pool = &abc.pool;
    var mn = abc.instanceName[owner];
    if (pool.mnKind[mn] == .type_name) {
        mn = pool.mnA[mn];
    }

    var ns = pool.mnA[mn];
    if (pool.mnKind[mn] == .multiname) {
        ns = domain_.firstMember(pool, ns);
    }

    try shown(dom, gpa, out, dom.abcNs.get(index)[ns], dom.abcString.get(index)[pool.mnB[mn]]);
}

/// Interned name `name` in interned namespace `ns`, as shown.
fn shown(dom: *Domain, gpa: Allocator, out: *Units, ns: u32, name: u32) Allocator.Error!void {
    const uri = dom.nsUri.get(ns);
    if (dom.nsType.get(ns) == domain_.NS_Public and uri != domain_.URI_None and dom.stringLength.get(uri) != 0) {
        try out.appendSlice(gpa, try output.decodeUnits(gpa, dom.stringOf(uri)));
        try ascii(gpa, out, "::");
    }

    try out.appendSlice(gpa, try output.decodeUnits(gpa, dom.stringOf(name)));
}

/// `name` as a JavaScript identifier: "$_", which marks the runtime's
/// stacks' frames of compiled code, then the name, every character but
/// [A-Za-z0-9_] escaped after a `$` (stack-names.ts tells the letters).
pub fn identifierOf(gpa: Allocator, name: []const u16) Allocator.Error![]u8 {
    const units = try gpa.alloc(u8, name.len * 6 + 2);
    var n: usize = 0;
    units[n] = '$';
    units[n + 1] = '_';
    n += 2;
    for (name) |c| {
        if ((c >= '0' and c <= '9') or (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or c == '_') {
            units[n] = @intCast(c);
            n += 1;
            continue;
        }

        units[n] = '$';
        n += 1;
        const letter: ?u8 = switch (c) {
            '$' => '$',
            '/' => 's',
            ':' => 'c',
            '.' => 'd',
            ' ' => 'w',
            '<' => 'l',
            '>' => 'g',
            '-' => 'm',
            else => null,
        };
        if (letter) |l| {
            units[n] = l;
            n += 1;
            continue;
        }

        units[n] = 'x';
        n += 1;
        var shift: i32 = 12;
        while (shift >= 0) : (shift -= 4) {
            const digit: u8 = @intCast((c >> @intCast(shift)) & 0xf);
            units[n] = if (digit < 10) '0' + digit else 87 + digit;
            n += 1;
        }
    }

    return units[0..n];
}

test "identifiers escape what names hold" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const name = [_]u16{ 'T', '/', 'g', 'e', 't', ' ', 'x', '$', 0xe9, ':' };
    try std.testing.expectEqualStrings("$_T$sget$wx$$$x00e9$c", try identifierOf(arena.allocator(), &name));
}
