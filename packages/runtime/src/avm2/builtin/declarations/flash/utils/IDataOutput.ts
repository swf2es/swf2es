// IDataOutput, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const IDataOutputClass: ClassDecl = {
  name: "flash.utils::IDataOutput",
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "ns:flash.utils:IDataOutput::writeBytes",
      params: ["flash.utils::ByteArray", ["uint", ["int", 0]], ["uint", ["int", 0]]],
      returns: "void",
    },
    { method: "ns:flash.utils:IDataOutput::writeBoolean", params: ["Boolean"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeByte", params: ["int"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeShort", params: ["int"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeInt", params: ["int"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeUnsignedInt", params: ["uint"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeFloat", params: ["Number"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeDouble", params: ["Number"], returns: "void" },
    {
      method: "ns:flash.utils:IDataOutput::writeMultiByte",
      params: ["String", "String"],
      returns: "void",
    },
    { method: "ns:flash.utils:IDataOutput::writeUTF", params: ["String"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeUTFBytes", params: ["String"], returns: "void" },
    { method: "ns:flash.utils:IDataOutput::writeObject", params: ["*"], returns: "void" },
    { get: "ns:flash.utils:IDataOutput::objectEncoding", returns: "uint" },
    { set: "ns:flash.utils:IDataOutput::objectEncoding", params: ["uint"], returns: "void" },
    { get: "ns:flash.utils:IDataOutput::endian", returns: "String" },
    { set: "ns:flash.utils:IDataOutput::endian", params: ["String"], returns: "void" },
  ],
};
