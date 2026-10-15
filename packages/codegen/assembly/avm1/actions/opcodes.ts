// AVM1 actions, SWF 3 to 10 (SWF file format specification, chapter 5):
// their opcodes and names. An action from 0x80 is followed by a u16 length
// and that many bytes of operands; one below has none.
//
// Opcodes not defined here are unknown: Flash skips them, as their length
// says, and goes on with the next action.

export const OP_End: u8 = 0x00;
export const OP_NextFrame: u8 = 0x04;
export const OP_PreviousFrame: u8 = 0x05;
export const OP_Play: u8 = 0x06;
export const OP_Stop: u8 = 0x07;
export const OP_ToggleQuality: u8 = 0x08;
export const OP_StopSounds: u8 = 0x09;
export const OP_Add: u8 = 0x0a;
export const OP_Subtract: u8 = 0x0b;
export const OP_Multiply: u8 = 0x0c;
export const OP_Divide: u8 = 0x0d;
export const OP_Equals: u8 = 0x0e;
export const OP_Less: u8 = 0x0f;
export const OP_And: u8 = 0x10;
export const OP_Or: u8 = 0x11;
export const OP_Not: u8 = 0x12;
export const OP_StringEquals: u8 = 0x13;
export const OP_StringLength: u8 = 0x14;
export const OP_StringExtract: u8 = 0x15;
export const OP_Pop: u8 = 0x17;
export const OP_ToInteger: u8 = 0x18;
export const OP_GetVariable: u8 = 0x1c;
export const OP_SetVariable: u8 = 0x1d;
export const OP_SetTarget2: u8 = 0x20;
export const OP_StringAdd: u8 = 0x21;
export const OP_GetProperty: u8 = 0x22;
export const OP_SetProperty: u8 = 0x23;
export const OP_CloneSprite: u8 = 0x24;
export const OP_RemoveSprite: u8 = 0x25;
export const OP_Trace: u8 = 0x26;
export const OP_StartDrag: u8 = 0x27;
export const OP_EndDrag: u8 = 0x28;
export const OP_StringLess: u8 = 0x29;
export const OP_Throw: u8 = 0x2a;
export const OP_CastOp: u8 = 0x2b;
export const OP_ImplementsOp: u8 = 0x2c;
export const OP_RandomNumber: u8 = 0x30;
export const OP_MBStringLength: u8 = 0x31;
export const OP_CharToAscii: u8 = 0x32;
export const OP_AsciiToChar: u8 = 0x33;
export const OP_GetTime: u8 = 0x34;
export const OP_MBStringExtract: u8 = 0x35;
export const OP_MBCharToAscii: u8 = 0x36;
export const OP_MBAsciiToChar: u8 = 0x37;
export const OP_Delete: u8 = 0x3a;
export const OP_Delete2: u8 = 0x3b;
export const OP_DefineLocal: u8 = 0x3c;
export const OP_CallFunction: u8 = 0x3d;
export const OP_Return: u8 = 0x3e;
export const OP_Modulo: u8 = 0x3f;
export const OP_NewObject: u8 = 0x40;
export const OP_DefineLocal2: u8 = 0x41;
export const OP_InitArray: u8 = 0x42;
export const OP_InitObject: u8 = 0x43;
export const OP_TypeOf: u8 = 0x44;
export const OP_TargetPath: u8 = 0x45;
export const OP_Enumerate: u8 = 0x46;
export const OP_Add2: u8 = 0x47;
export const OP_Less2: u8 = 0x48;
export const OP_Equals2: u8 = 0x49;
export const OP_ToNumber: u8 = 0x4a;
export const OP_ToString: u8 = 0x4b;
export const OP_PushDuplicate: u8 = 0x4c;
export const OP_StackSwap: u8 = 0x4d;
export const OP_GetMember: u8 = 0x4e;
export const OP_SetMember: u8 = 0x4f;
export const OP_Increment: u8 = 0x50;
export const OP_Decrement: u8 = 0x51;
export const OP_CallMethod: u8 = 0x52;
export const OP_NewMethod: u8 = 0x53;
export const OP_InstanceOf: u8 = 0x54;
export const OP_Enumerate2: u8 = 0x55;
export const OP_BitAnd: u8 = 0x60;
export const OP_BitOr: u8 = 0x61;
export const OP_BitXor: u8 = 0x62;
export const OP_BitLShift: u8 = 0x63;
export const OP_BitRShift: u8 = 0x64;
export const OP_BitURShift: u8 = 0x65;
export const OP_StrictEquals: u8 = 0x66;
export const OP_Greater: u8 = 0x67;
export const OP_StringGreater: u8 = 0x68;
export const OP_Extends: u8 = 0x69;
export const OP_GotoFrame: u8 = 0x81;
export const OP_GetUrl: u8 = 0x83;
export const OP_StoreRegister: u8 = 0x87;
export const OP_ConstantPool: u8 = 0x88;
export const OP_WaitForFrame: u8 = 0x8a;
export const OP_SetTarget: u8 = 0x8b;
export const OP_GotoLabel: u8 = 0x8c;
export const OP_WaitForFrame2: u8 = 0x8d;
export const OP_DefineFunction2: u8 = 0x8e;
export const OP_Try: u8 = 0x8f;
export const OP_With: u8 = 0x94;
export const OP_Push: u8 = 0x96;
export const OP_Jump: u8 = 0x99;
export const OP_GetUrl2: u8 = 0x9a;
export const OP_DefineFunction: u8 = 0x9b;
export const OP_If: u8 = 0x9d;
export const OP_Call: u8 = 0x9e;
export const OP_GotoFrame2: u8 = 0x9f;

// Push's value types.
export const PUSH_String: u8 = 0;
/** A float, widened to a double. */
export const PUSH_Float: u8 = 1;
export const PUSH_Null: u8 = 2;
export const PUSH_Undefined: u8 = 3;
export const PUSH_Register: u8 = 4;
export const PUSH_Boolean: u8 = 5;
/** A double stored as two little-endian words, the high one first. */
export const PUSH_Double: u8 = 6;
/** An i32, which AVM1 pushes as a number. */
export const PUSH_Integer: u8 = 7;
/** A u8 index into the constant pool. */
export const PUSH_Constant8: u8 = 8;
/** A u16 index into the constant pool. */
export const PUSH_Constant16: u8 = 9;

// DefineFunction2's flags.
export const FUNCTION_PreloadThis: u32 = 0x001;
export const FUNCTION_SuppressThis: u32 = 0x002;
export const FUNCTION_PreloadArguments: u32 = 0x004;
export const FUNCTION_SuppressArguments: u32 = 0x008;
export const FUNCTION_PreloadSuper: u32 = 0x010;
export const FUNCTION_SuppressSuper: u32 = 0x020;
export const FUNCTION_PreloadRoot: u32 = 0x040;
export const FUNCTION_PreloadParent: u32 = 0x080;
export const FUNCTION_PreloadGlobal: u32 = 0x100;
/** The flags Flash reads; the rest of the u16 is ignored. */
export const FUNCTION_Mask: u32 = 0x1ff;

// Try's flags.
export const TRY_Catch: u32 = 1;
export const TRY_Finally: u32 = 2;
/** The caught value goes to a register, not a variable. */
export const TRY_CatchInRegister: u32 = 4;
export const TRY_Mask: u32 = 7;

// GetUrl2's flags: the method in the low two bits, of which 3 is read as none.
export const GETURL_MethodMask: u32 = 3;

/** The names of the actions, an unknown opcode's as its hex. */
export const opcodeNames = new StaticArray<string>(256);
/** Whether the opcode is an action Flash knows. */
export const opcodeKnown = new StaticArray<bool>(256);

function define(opcode: u8, name: string): void {
  opcodeNames[opcode] = name;
  opcodeKnown[opcode] = true;
}

function defineAll(): void {
  for (let opcode = 0; opcode < 256; opcode++) {
    opcodeNames[opcode] = `0x${opcode < 0x10 ? "0" : ""}${opcode.toString(16)}`;
  }

  define(OP_End, "End");
  define(OP_NextFrame, "NextFrame");
  define(OP_PreviousFrame, "PreviousFrame");
  define(OP_Play, "Play");
  define(OP_Stop, "Stop");
  define(OP_ToggleQuality, "ToggleQuality");
  define(OP_StopSounds, "StopSounds");
  define(OP_Add, "Add");
  define(OP_Subtract, "Subtract");
  define(OP_Multiply, "Multiply");
  define(OP_Divide, "Divide");
  define(OP_Equals, "Equals");
  define(OP_Less, "Less");
  define(OP_And, "And");
  define(OP_Or, "Or");
  define(OP_Not, "Not");
  define(OP_StringEquals, "StringEquals");
  define(OP_StringLength, "StringLength");
  define(OP_StringExtract, "StringExtract");
  define(OP_Pop, "Pop");
  define(OP_ToInteger, "ToInteger");
  define(OP_GetVariable, "GetVariable");
  define(OP_SetVariable, "SetVariable");
  define(OP_SetTarget2, "SetTarget2");
  define(OP_StringAdd, "StringAdd");
  define(OP_GetProperty, "GetProperty");
  define(OP_SetProperty, "SetProperty");
  define(OP_CloneSprite, "CloneSprite");
  define(OP_RemoveSprite, "RemoveSprite");
  define(OP_Trace, "Trace");
  define(OP_StartDrag, "StartDrag");
  define(OP_EndDrag, "EndDrag");
  define(OP_StringLess, "StringLess");
  define(OP_Throw, "Throw");
  define(OP_CastOp, "CastOp");
  define(OP_ImplementsOp, "ImplementsOp");
  define(OP_RandomNumber, "RandomNumber");
  define(OP_MBStringLength, "MBStringLength");
  define(OP_CharToAscii, "CharToAscii");
  define(OP_AsciiToChar, "AsciiToChar");
  define(OP_GetTime, "GetTime");
  define(OP_MBStringExtract, "MBStringExtract");
  define(OP_MBCharToAscii, "MBCharToAscii");
  define(OP_MBAsciiToChar, "MBAsciiToChar");
  define(OP_Delete, "Delete");
  define(OP_Delete2, "Delete2");
  define(OP_DefineLocal, "DefineLocal");
  define(OP_CallFunction, "CallFunction");
  define(OP_Return, "Return");
  define(OP_Modulo, "Modulo");
  define(OP_NewObject, "NewObject");
  define(OP_DefineLocal2, "DefineLocal2");
  define(OP_InitArray, "InitArray");
  define(OP_InitObject, "InitObject");
  define(OP_TypeOf, "TypeOf");
  define(OP_TargetPath, "TargetPath");
  define(OP_Enumerate, "Enumerate");
  define(OP_Add2, "Add2");
  define(OP_Less2, "Less2");
  define(OP_Equals2, "Equals2");
  define(OP_ToNumber, "ToNumber");
  define(OP_ToString, "ToString");
  define(OP_PushDuplicate, "PushDuplicate");
  define(OP_StackSwap, "StackSwap");
  define(OP_GetMember, "GetMember");
  define(OP_SetMember, "SetMember");
  define(OP_Increment, "Increment");
  define(OP_Decrement, "Decrement");
  define(OP_CallMethod, "CallMethod");
  define(OP_NewMethod, "NewMethod");
  define(OP_InstanceOf, "InstanceOf");
  define(OP_Enumerate2, "Enumerate2");
  define(OP_BitAnd, "BitAnd");
  define(OP_BitOr, "BitOr");
  define(OP_BitXor, "BitXor");
  define(OP_BitLShift, "BitLShift");
  define(OP_BitRShift, "BitRShift");
  define(OP_BitURShift, "BitURShift");
  define(OP_StrictEquals, "StrictEquals");
  define(OP_Greater, "Greater");
  define(OP_StringGreater, "StringGreater");
  define(OP_Extends, "Extends");
  define(OP_GotoFrame, "GotoFrame");
  define(OP_GetUrl, "GetUrl");
  define(OP_StoreRegister, "StoreRegister");
  define(OP_ConstantPool, "ConstantPool");
  define(OP_WaitForFrame, "WaitForFrame");
  define(OP_SetTarget, "SetTarget");
  define(OP_GotoLabel, "GotoLabel");
  define(OP_WaitForFrame2, "WaitForFrame2");
  define(OP_DefineFunction2, "DefineFunction2");
  define(OP_Try, "Try");
  define(OP_With, "With");
  define(OP_Push, "Push");
  define(OP_Jump, "Jump");
  define(OP_GetUrl2, "GetUrl2");
  define(OP_DefineFunction, "DefineFunction");
  define(OP_If, "If");
  define(OP_Call, "Call");
  define(OP_GotoFrame2, "GotoFrame2");
}

defineAll();
