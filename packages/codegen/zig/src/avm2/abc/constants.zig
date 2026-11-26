// Constants of the ABC format and avmplus' VerifyError numbers. The kinds
// and flags are Zig types whose values are the ABC's bytes; the VerifyError
// numbers keep avmplus' names, so the files that use them read like
// avmplus': C.kCorruptABCError.

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

// VerifyError numbers avmplus reports (core/ErrorConstants.h), so a rejected
// ABC fails the same way it does in avmshell. 1008 is a ReferenceError.
pub const kAmbiguousBindingError: i32 = 1008;
pub const kIllegalOpcodeError: i32 = 1011;
pub const kLastInstExceedsCodeSizeError: i32 = 1012;
pub const kFindVarWithNoScopeError: i32 = 1013;
pub const kClassNotFoundError: i32 = 1014;
pub const kIllegalSetDxns: i32 = 1015;
pub const kScopeStackOverflowError: i32 = 1017;
pub const kScopeStackUnderflowError: i32 = 1018;
pub const kGetScopeObjectBoundsError: i32 = 1019;
pub const kCannotFallOffMethodError: i32 = 1020;
pub const kInvalidBranchTargetError: i32 = 1021;
pub const kIllegalVoidError: i32 = 1022;
pub const kStackOverflowError: i32 = 1023;
pub const kStackUnderflowError: i32 = 1024;
pub const kInvalidRegisterError: i32 = 1025;
pub const kSlotExceedsCountError: i32 = 1026;
pub const kMethodInfoExceedsCountError: i32 = 1027;
pub const kStackDepthUnbalancedError: i32 = 1030;
pub const kScopeDepthUnbalancedError: i32 = 1031;
pub const kCpoolIndexRangeError: i32 = 1032;
pub const kCpoolEntryWrongTypeError: i32 = 1033;
pub const kIllegalSuperCallError: i32 = 1035;
pub const kInvalidMagicError: i32 = 1042;
pub const kInvalidCodeLengthError: i32 = 1043;
pub const kUnsupportedTraitsKindError: i32 = 1045;
pub const kIllegalEarlyBindingError: i32 = 1051;
pub const kIllegalOverrideError: i32 = 1053;
pub const kIllegalExceptionHandlerError: i32 = 1054;
pub const kIllegalSlotError: i32 = 1057;
pub const kIllegalOperandTypeError: i32 = 1058;
pub const kClassInfoOrderError: i32 = 1059;
pub const kClassInfoExceedsCountError: i32 = 1060;
pub const kWrongArgumentCountError: i32 = 1063;
pub const kCannotMergeTypesError: i32 = 1068;
pub const kAlreadyBoundError: i32 = 1071;
pub const kZeroDispIdError: i32 = 1072;
pub const kIllegalOpMultinameError: i32 = 1078;
pub const kIllegalNativeMethodError: i32 = 1079;
pub const kIllegalNamespaceError: i32 = 1080;
pub const kIllegalDefaultValue: i32 = 1102;
pub const kCannotExtendFinalClass: i32 = 1103;
pub const kCorruptABCError: i32 = 1107;
pub const kDanglingFunctionError: i32 = 1109;
pub const kCannotExtendError: i32 = 1110;
pub const kCannotImplementError: i32 = 1111;
pub const kInvalidNewActivationError: i32 = 1113;
pub const kNoGlobalScopeError: i32 = 1114;
pub const kDuplicateMethodBodyError: i32 = 1121;
pub const kIllegalInterfaceMethodBodyError: i32 = 1122;
pub const kInvalidHasNextError: i32 = 1124;
