import type { ClassDecl } from "../../../declare.js";

export const ObjectOutputClass: ClassDecl = {
  name: "internal:flash.utils::ObjectOutput",
  super: "Object",
  interfaces: ["flash.utils::IDataOutput"],
  sealed: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "writeBytes",
      params: ["flash.utils::ByteArray", ["uint", ["int", 0]], ["uint", ["int", 0]]],
      returns: "void",
      native: true,
    },
    { method: "writeBoolean", params: ["Boolean"], returns: "void", native: true },
    { method: "writeByte", params: ["int"], returns: "void", native: true },
    { method: "writeShort", params: ["int"], returns: "void", native: true },
    { method: "writeInt", params: ["int"], returns: "void", native: true },
    { method: "writeUnsignedInt", params: ["uint"], returns: "void", native: true },
    { method: "writeFloat", params: ["Number"], returns: "void", native: true },
    { method: "writeDouble", params: ["Number"], returns: "void", native: true },
    { method: "writeMultiByte", params: ["String", "String"], returns: "void", native: true },
    { method: "writeUTF", params: ["String"], returns: "void", native: true },
    { method: "writeUTFBytes", params: ["String"], returns: "void", native: true },
    { method: "writeObject", params: ["*"], returns: "void", native: true },
    { get: "objectEncoding", returns: "uint", native: true },
    { set: "objectEncoding", params: ["uint"], returns: "void", native: true },
    { get: "endian", returns: "String", native: true },
    { set: "endian", params: ["String"], returns: "void", native: true },
  ],
};
