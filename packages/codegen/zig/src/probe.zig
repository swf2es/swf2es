// The release build with what stage 5 will reach from its exports reached
// already, for measuring the release's true size as the port goes: the
// verifier, through verifyMethods. Never shipped.
const root = @import("root.zig");
const avm2 = @import("compile.zig");
const code = @import("avm2/abc/code.zig");

pub const panic = root.panic;

comptime {
    _ = root;
}

fn verifyLast(dom: *@import("avm2/link/domain.zig").Domain) !i32 {
    const results = try code.verifyMethods(dom, dom.abcs.len - 1);
    return @intCast(results.len);
}

export fn probeVerify() i32 {
    return avm2.changed(verifyLast, .{}) catch 0;
}
