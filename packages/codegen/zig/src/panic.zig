// Every panic, a ReleaseSafe safety check's included, goes to env.abort,
// the only import the compiler's module may have, with its message: the
// wrapper (packages/codegen/src/zig.ts) throws it as a CodegenPanic and
// takes the instance for dead. Its messages are std.debug.simple_panic's,
// without the numbers std.debug.FullPanic would format, which would pull
// formatting code into the module.

extern "env" fn abort(message: [*]const u8, length: usize, line: u32, column: u32) noreturn;

pub fn call(message: []const u8, _: ?usize) noreturn {
    @branchHint(.cold);
    abort(message.ptr, message.len, 0, 0);
}

pub fn sentinelMismatch(_: anytype, _: anytype) noreturn {
    call("sentinel mismatch", null);
}

pub fn unwrapError(_: anyerror) noreturn {
    call("attempt to unwrap error", null);
}

pub fn outOfBounds(_: usize, _: usize) noreturn {
    call("index out of bounds", null);
}

pub fn startGreaterThanEnd(_: usize, _: usize) noreturn {
    call("start index is larger than end index", null);
}

pub fn inactiveUnionField(_: anytype, _: anytype) noreturn {
    call("access of inactive union field", null);
}

pub fn sliceCastLenRemainder(_: usize) noreturn {
    call("slice length does not divide exactly into destination elements", null);
}

pub fn reachedUnreachable() noreturn {
    call("reached unreachable code", null);
}

pub fn unwrapNull() noreturn {
    call("attempt to use null value", null);
}

pub fn castToNull() noreturn {
    call("cast causes pointer to be null", null);
}

pub fn incorrectAlignment() noreturn {
    call("incorrect alignment", null);
}

pub fn invalidErrorCode() noreturn {
    call("invalid error code", null);
}

pub fn unexpectedErrorCode(_: anyerror) noreturn {
    call("unexpected error code", null);
}

pub fn integerOutOfBounds() noreturn {
    call("integer does not fit in destination type", null);
}

pub fn integerOverflow() noreturn {
    call("integer overflow", null);
}

pub fn shlOverflow() noreturn {
    call("left shift overflowed bits", null);
}

pub fn shrOverflow() noreturn {
    call("right shift overflowed bits", null);
}

pub fn divideByZero() noreturn {
    call("division by zero", null);
}

pub fn exactDivisionRemainder() noreturn {
    call("exact division produced remainder", null);
}

pub fn integerPartOutOfBounds() noreturn {
    call("integer part of floating point value out of bounds", null);
}

pub fn corruptSwitch() noreturn {
    call("switch on corrupt value", null);
}

pub fn shiftRhsTooBig() noreturn {
    call("shift amount is greater than the type size", null);
}

pub fn invalidEnumValue() noreturn {
    call("invalid enum value", null);
}

pub fn forLenMismatch() noreturn {
    call("for loop over objects with non-equal lengths", null);
}

pub fn copyLenMismatch() noreturn {
    call("source and destination arguments have non-equal lengths", null);
}

pub fn memcpyAlias() noreturn {
    call("@memcpy arguments alias", null);
}

pub fn noreturnReturned() noreturn {
    call("'noreturn' function returned", null);
}

pub fn loadUninstantiableType() noreturn {
    call("load of uninstantiable type", null);
}
