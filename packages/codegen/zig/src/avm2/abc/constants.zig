// Constants of the ABC format and avmplus' VerifyError numbers. The kinds
// and flags are Zig types whose values are the ABC's bytes; the VerifyError
// numbers keep avmplus' names, so the files that use them read like
// avmplus': .kCorruptABCError, a VerifyError.

/// A constant's kind (avmplus core/ActionBlockConstants.h): of a default
/// value, a namespace or a multiname, one number space as in avmplus.
/// Non-exhaustive, as the ABC writes it: a byte no kind names is one of
/// the unnamed values, which every switch must reject.
pub const Constant = enum(u8) {
    utf8 = 0x01,
    float = 0x02,
    int = 0x03,
    uint = 0x04,
    private_ns = 0x05,
    double = 0x06,
    qname = 0x07,
    namespace = 0x08,
    multiname = 0x09,
    false = 0x0a,
    true = 0x0b,
    null = 0x0c,
    qname_a = 0x0d,
    multiname_a = 0x0e,
    rtqname = 0x0f,
    rtqname_a = 0x10,
    rtqname_l = 0x11,
    rtqname_la = 0x12,
    package_namespace = 0x16,
    package_internal_ns = 0x17,
    protected_namespace = 0x18,
    explicit_namespace = 0x19,
    static_protected_ns = 0x1a,
    multiname_l = 0x1b,
    multiname_la = 0x1c,
    type_name = 0x1d,
    _,

    /// 0, no kind: what a slot without a value, or entry 0 of a table the
    /// parse did not reach, holds. A declaration, not a field, so that
    /// switches still reject it with the unnamed values.
    pub const none: Constant = @fromBackingInt(0);

    /// Whether it is a namespace's kind.
    pub fn isNamespace(self: Constant) bool {
        return switch (self) {
            .namespace,
            .package_namespace,
            .package_internal_ns,
            .protected_namespace,
            .explicit_namespace,
            .static_protected_ns,
            .private_ns,
            => true,
            else => false,
        };
    }
};

/// method_info.flags.
pub const MethodFlags = packed struct(u8) {
    need_arguments: bool = false,
    need_activation: bool = false,
    need_rest: bool = false,
    has_optional: bool = false,
    /// avmplus' IGNORE_REST, which nothing here reads.
    ignore_rest: bool = false,
    native: bool = false,
    sets_dxns: bool = false,
    has_param_names: bool = false,
};

/// instance_info.flags.
pub const InstanceFlags = packed struct(u8) {
    sealed: bool = false,
    final: bool = false,
    interface: bool = false,
    protected_ns: bool = false,
    _: u4 = 0,
};

/// A trait's kind, the low four bits of its tag (AVM2 overview 4.8.1).
/// Kind 5, a function, is one avmplus does not read, as no other kind may
/// be either.
pub const TraitKind = enum(u4) {
    slot = 0,
    method = 1,
    getter = 2,
    setter = 3,
    class = 4,
    constant = 6,
    _,

    /// Whether it binds a method: a method or an accessor.
    pub fn bindsMethod(self: TraitKind) bool {
        return self == .method or self == .getter or self == .setter;
    }

    /// Whether it binds a slot: a var, a const or a class.
    pub fn bindsSlot(self: TraitKind) bool {
        return self == .slot or self == .constant or self == .class;
    }
};

/// traits_info.kind: the trait's kind, then its attributes; the top bit,
/// which no attribute names, is kept as read.
pub const TraitTag = packed struct(u8) {
    kind: TraitKind = .slot,
    final: bool = false,
    override: bool = false,
    metadata: bool = false,
    _: u1 = 0,
};

/// The VerifyError numbers avmplus reports, so that a rejected ABC fails
/// the way it does in avmshell; 1008 is a ReferenceError. The tags keep
/// avmplus' names from core/ErrorConstants.h verbatim, not snake_case, on
/// purpose: each greps one to one with avmplus and its error tables.
/// `none`, 0, no error, is the one tag of our own. Non-exhaustive: an
/// Abc's is worked out again by parsing whenever a domain is restored or
/// loaded, but a journal's raw restore or the poison build's fill can
/// leave any number there, and the exports carry it as one. Never switch
/// over it exhaustively.
pub const VerifyError = enum(i32) {
    none = 0,
    kAmbiguousBindingError = 1008,
    kIllegalOpcodeError = 1011,
    kLastInstExceedsCodeSizeError = 1012,
    kFindVarWithNoScopeError = 1013,
    kClassNotFoundError = 1014,
    kIllegalSetDxns = 1015,
    kScopeStackOverflowError = 1017,
    kScopeStackUnderflowError = 1018,
    kGetScopeObjectBoundsError = 1019,
    kCannotFallOffMethodError = 1020,
    kInvalidBranchTargetError = 1021,
    kIllegalVoidError = 1022,
    kStackOverflowError = 1023,
    kStackUnderflowError = 1024,
    kInvalidRegisterError = 1025,
    kSlotExceedsCountError = 1026,
    kMethodInfoExceedsCountError = 1027,
    kStackDepthUnbalancedError = 1030,
    kScopeDepthUnbalancedError = 1031,
    kCpoolIndexRangeError = 1032,
    kCpoolEntryWrongTypeError = 1033,
    kIllegalSuperCallError = 1035,
    kInvalidMagicError = 1042,
    kInvalidCodeLengthError = 1043,
    kUnsupportedTraitsKindError = 1045,
    kIllegalEarlyBindingError = 1051,
    kIllegalOverrideError = 1053,
    kIllegalExceptionHandlerError = 1054,
    kIllegalSlotError = 1057,
    kIllegalOperandTypeError = 1058,
    kClassInfoOrderError = 1059,
    kClassInfoExceedsCountError = 1060,
    kWrongArgumentCountError = 1063,
    kCannotMergeTypesError = 1068,
    kAlreadyBoundError = 1071,
    kZeroDispIdError = 1072,
    kIllegalOpMultinameError = 1078,
    kIllegalNativeMethodError = 1079,
    kIllegalNamespaceError = 1080,
    kIllegalDefaultValue = 1102,
    kCannotExtendFinalClass = 1103,
    kCorruptABCError = 1107,
    kDanglingFunctionError = 1109,
    kCannotExtendError = 1110,
    kCannotImplementError = 1111,
    kInvalidNewActivationError = 1113,
    kNoGlobalScopeError = 1114,
    kDuplicateMethodBodyError = 1121,
    kIllegalInterfaceMethodBodyError = 1122,
    kInvalidHasNextError = 1124,
    _,

    /// As the result rows (with -1 for a body nothing runs) and the exports
    /// carry it.
    pub fn number(e: VerifyError) i32 {
        return @backingInt(e);
    }

    /// A result row's, a save's or a journal's number.
    pub fn of(n: i32) VerifyError {
        return @fromBackingInt(n);
    }
};
