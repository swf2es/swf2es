// How the ABC reader rejects an ABC: Zig's errors carry no payload, so the
// VerifyError number travels in a Diagnostics the caller passes. Its own
// file, so that the pool reads it without importing the Abc it is part of.
const std = @import("std");
const VerifyError = @import("constants.zig").VerifyError;

/// The ABC rejected: avmplus would throw the VerifyError Diagnostics holds.
pub const Rejected = error{Verify};

/// How an ABC's parse stops early: rejected, or out of memory.
pub const Error = Rejected || std.mem.Allocator.Error;

/// Why a parse that returned Error.Verify stopped: the number of the
/// VerifyError avmplus would throw, the first, as avmplus stops at its
/// first throw.
pub const Diagnostics = struct {
    code: VerifyError = .none,

    /// Error.Verify, the ABC rejected with VerifyError `code`.
    pub fn fail(self: *Diagnostics, code: VerifyError) Rejected {
        // none is "accepted", which a rejection must never record.
        std.debug.assert(code != .none);
        if (self.code == .none) {
            self.code = code;
        }

        return error.Verify;
    }
};
