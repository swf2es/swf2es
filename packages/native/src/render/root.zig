//! What the renderer computes natively, in one module: BitmapData's
//! convolution (bitmap.zig, over convolve.zig's kernel); fills tessellated
//! by libtess2 (tessellate.zig, their curves flattened by flatten.zig); and
//! a layer's lines (strokes.zig), whose outlines the same libtess2 fills in
//! the same memory. Each manages its memory its own way, so an instance
//! calls one of the three alone: the bitmap kernel, the tessellator, or the
//! lines.
const std = @import("std");

pub const panic = std.debug.no_panic;

comptime {
    _ = @import("bitmap.zig");
    _ = @import("draw.zig");
    _ = @import("dxt.zig");
    _ = @import("tessellate.zig");
    _ = @import("strokes.zig");
}
