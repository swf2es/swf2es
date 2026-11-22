// Constants of the ABC format and avmplus' VerifyError numbers, as
// assembly/avm2/abc/constants.ts names them, so the files that use them
// read alike: C.CONSTANT_Qname, C.kCorruptABCError.
// Constant kinds (avmplus core/ActionBlockConstants.h): of default values,
// namespaces and multinames.
pub const CONSTANT_Utf8: u8 = 0x01;
pub const CONSTANT_Int: u8 = 0x03;
pub const CONSTANT_UInt: u8 = 0x04;
pub const CONSTANT_PrivateNs: u8 = 0x05;
pub const CONSTANT_Double: u8 = 0x06;
pub const CONSTANT_Float: u8 = 0x02;
pub const CONSTANT_Qname: u8 = 0x07;
pub const CONSTANT_Namespace: u8 = 0x08;
pub const CONSTANT_Multiname: u8 = 0x09;
pub const CONSTANT_False: u8 = 0x0a;
pub const CONSTANT_True: u8 = 0x0b;
pub const CONSTANT_Null: u8 = 0x0c;
pub const CONSTANT_QnameA: u8 = 0x0d;
pub const CONSTANT_MultinameA: u8 = 0x0e;
pub const CONSTANT_RTQname: u8 = 0x0f;
pub const CONSTANT_RTQnameA: u8 = 0x10;
pub const CONSTANT_RTQnameL: u8 = 0x11;
pub const CONSTANT_RTQnameLA: u8 = 0x12;
pub const CONSTANT_PackageNamespace: u8 = 0x16;
pub const CONSTANT_PackageInternalNs: u8 = 0x17;
pub const CONSTANT_ProtectedNamespace: u8 = 0x18;
pub const CONSTANT_ExplicitNamespace: u8 = 0x19;
pub const CONSTANT_StaticProtectedNs: u8 = 0x1a;
pub const CONSTANT_MultinameL: u8 = 0x1b;
pub const CONSTANT_MultinameLA: u8 = 0x1c;
pub const CONSTANT_TypeName: u8 = 0x1d;

// Method flags (method_info.flags).
pub const METHOD_NeedArguments: u8 = 0x01;
pub const METHOD_NeedActivation: u8 = 0x02;
pub const METHOD_NeedRest: u8 = 0x04;
pub const METHOD_SetsDxns: u8 = 0x40;
pub const METHOD_HasOptional: u8 = 0x08;
pub const METHOD_Native: u8 = 0x20;
pub const METHOD_HasParamNames: u8 = 0x80;

// Instance flags (instance_info.flags).
pub const INSTANCE_Final: u8 = 0x02;
pub const INSTANCE_Interface: u8 = 0x04;
pub const INSTANCE_ProtectedNs: u8 = 0x08;

// Trait kinds (low 4 bits of traits_info.kind) and attributes (high 4 bits).
pub const TRAIT_Slot: u8 = 0;
pub const TRAIT_Method: u8 = 1;
pub const TRAIT_Getter: u8 = 2;
pub const TRAIT_Setter: u8 = 3;
pub const TRAIT_Class: u8 = 4;
pub const TRAIT_Const: u8 = 6;
pub const ATTR_Final: u8 = 0x10;
pub const ATTR_Override: u8 = 0x20;
pub const ATTR_Metadata: u8 = 0x40;

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
