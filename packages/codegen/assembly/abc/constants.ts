// Constant kinds (avmplus core/ActionBlockConstants.h).
export const CONSTANT_PrivateNs: u8 = 0x05;
export const CONSTANT_Qname: u8 = 0x07;
export const CONSTANT_Namespace: u8 = 0x08;
export const CONSTANT_Multiname: u8 = 0x09;
export const CONSTANT_QnameA: u8 = 0x0d;
export const CONSTANT_MultinameA: u8 = 0x0e;
export const CONSTANT_RTQname: u8 = 0x0f;
export const CONSTANT_RTQnameA: u8 = 0x10;
export const CONSTANT_RTQnameL: u8 = 0x11;
export const CONSTANT_RTQnameLA: u8 = 0x12;
export const CONSTANT_PackageNamespace: u8 = 0x16;
export const CONSTANT_PackageInternalNs: u8 = 0x17;
export const CONSTANT_ProtectedNamespace: u8 = 0x18;
export const CONSTANT_ExplicitNamespace: u8 = 0x19;
export const CONSTANT_StaticProtectedNs: u8 = 0x1a;
export const CONSTANT_MultinameL: u8 = 0x1b;
export const CONSTANT_MultinameLA: u8 = 0x1c;
export const CONSTANT_TypeName: u8 = 0x1d;

// Method flags (method_info.flags).
export const METHOD_NeedActivation: u8 = 0x02;
export const METHOD_HasOptional: u8 = 0x08;
export const METHOD_Native: u8 = 0x20;
export const METHOD_HasParamNames: u8 = 0x80;

// Instance flags (instance_info.flags).
export const INSTANCE_Interface: u8 = 0x04;
export const INSTANCE_ProtectedNs: u8 = 0x08;

// Trait kinds (low 4 bits of traits_info.kind) and attributes (high 4 bits).
export const TRAIT_Slot: u8 = 0;
export const TRAIT_Method: u8 = 1;
export const TRAIT_Getter: u8 = 2;
export const TRAIT_Setter: u8 = 3;
export const TRAIT_Class: u8 = 4;
export const TRAIT_Const: u8 = 6;
export const ATTR_Metadata: u8 = 0x40;

// VerifyError numbers avmplus reports (core/ErrorConstants.h), so a rejected
// ABC fails the same way it does in avmshell.
export const kIllegalOpcodeError: i32 = 1011;
export const kLastInstExceedsCodeSizeError: i32 = 1012;
export const kCannotFallOffMethodError: i32 = 1020;
export const kInvalidBranchTargetError: i32 = 1021;
export const kMethodInfoExceedsCountError: i32 = 1027;
export const kCpoolIndexRangeError: i32 = 1032;
export const kCpoolEntryWrongTypeError: i32 = 1033;
export const kInvalidCodeLengthError: i32 = 1043;
export const kUnsupportedTraitsKindError: i32 = 1045;
export const kIllegalExceptionHandlerError: i32 = 1054;
export const kClassInfoOrderError: i32 = 1059;
export const kClassInfoExceedsCountError: i32 = 1060;
export const kAlreadyBoundError: i32 = 1071;
export const kIllegalNativeMethodError: i32 = 1079;
export const kIllegalNamespaceError: i32 = 1080;
export const kCorruptABCError: i32 = 1107;
export const kCannotImplementError: i32 = 1111;
export const kDuplicateMethodBodyError: i32 = 1121;
export const kIllegalInterfaceMethodBodyError: i32 = 1122;
