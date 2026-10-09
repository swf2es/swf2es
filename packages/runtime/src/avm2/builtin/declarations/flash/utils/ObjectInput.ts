// ObjectInput, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const ObjectInputClass: ClassDecl = {
  name: "internal:flash.utils::ObjectInput",
  super: "Object",
  interfaces: ["flash.utils::IDataInput"],
  sealed: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "readBytes",
      params: ["flash.utils::ByteArray", ["uint", ["int", 0]], ["uint", ["int", 0]]],
      returns: "void",
      native: true,
    },
    { method: "readBoolean", returns: "Boolean", native: true },
    { method: "readByte", returns: "int", native: true },
    { method: "readUnsignedByte", returns: "uint", native: true },
    { method: "readShort", returns: "int", native: true },
    { method: "readUnsignedShort", returns: "uint", native: true },
    { method: "readInt", returns: "int", native: true },
    { method: "readUnsignedInt", returns: "uint", native: true },
    { method: "readFloat", returns: "Number", native: true },
    { method: "readDouble", returns: "Number", native: true },
    { method: "readMultiByte", params: ["uint", "String"], returns: "String", native: true },
    { method: "readUTF", returns: "String", native: true },
    { method: "readUTFBytes", params: ["uint"], returns: "String", native: true },
    { get: "bytesAvailable", returns: "uint", native: true },
    { method: "readObject", native: true },
    { get: "objectEncoding", returns: "uint", native: true },
    { set: "objectEncoding", params: ["uint"], returns: "void", native: true },
    { get: "endian", returns: "String", native: true },
    { set: "endian", params: ["String"], returns: "void", native: true },
  ],
};
