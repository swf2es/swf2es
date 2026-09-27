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

// VerifyError numbers avmplus reports (core/ErrorConstants.h), so a rejected
// ABC fails the same way it does in avmshell.
export const kCpoolIndexRangeError: i32 = 1032;
export const kCpoolEntryWrongTypeError: i32 = 1033;
export const kIllegalNamespaceError: i32 = 1080;
export const kCorruptABCError: i32 = 1107;
