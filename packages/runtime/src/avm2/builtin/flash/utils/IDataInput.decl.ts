import type { ClassDecl } from "../../declare.js";

export const IDataInputClass = {
  name: "flash.utils::IDataInput",
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "ns:flash.utils:IDataInput::readBytes",
      params: ["flash.utils::ByteArray", ["uint", ["int", 0]], ["uint", ["int", 0]]],
      returns: "void",
      meta: [["cppcall", []]],
    },
    {
      method: "ns:flash.utils:IDataInput::readBoolean",
      returns: "Boolean",
      meta: [["cppcall", []]],
    },
    { method: "ns:flash.utils:IDataInput::readByte", returns: "int", meta: [["cppcall", []]] },
    {
      method: "ns:flash.utils:IDataInput::readUnsignedByte",
      returns: "uint",
      meta: [["cppcall", []]],
    },
    { method: "ns:flash.utils:IDataInput::readShort", returns: "int", meta: [["cppcall", []]] },
    {
      method: "ns:flash.utils:IDataInput::readUnsignedShort",
      returns: "uint",
      meta: [["cppcall", []]],
    },
    { method: "ns:flash.utils:IDataInput::readInt", returns: "int", meta: [["cppcall", []]] },
    {
      method: "ns:flash.utils:IDataInput::readUnsignedInt",
      returns: "uint",
      meta: [["cppcall", []]],
    },
    { method: "ns:flash.utils:IDataInput::readFloat", returns: "Number", meta: [["cppcall", []]] },
    { method: "ns:flash.utils:IDataInput::readDouble", returns: "Number", meta: [["cppcall", []]] },
    {
      method: "ns:flash.utils:IDataInput::readMultiByte",
      params: ["uint", "String"],
      returns: "String",
      meta: [["cppcall", []]],
    },
    { method: "ns:flash.utils:IDataInput::readUTF", returns: "String", meta: [["cppcall", []]] },
    {
      method: "ns:flash.utils:IDataInput::readUTFBytes",
      params: ["uint"],
      returns: "String",
      meta: [["cppcall", []]],
    },
    { get: "ns:flash.utils:IDataInput::bytesAvailable", returns: "uint", meta: [["cppcall", []]] },
    { method: "ns:flash.utils:IDataInput::readObject", meta: [["cppcall", []]] },
    { get: "ns:flash.utils:IDataInput::objectEncoding", returns: "uint", meta: [["cppcall", []]] },
    {
      set: "ns:flash.utils:IDataInput::objectEncoding",
      params: ["uint"],
      returns: "void",
      meta: [["cppcall", []]],
    },
    { get: "ns:flash.utils:IDataInput::endian", returns: "String", meta: [["cppcall", []]] },
    {
      set: "ns:flash.utils:IDataInput::endian",
      params: ["String"],
      returns: "void",
      meta: [["cppcall", []]],
    },
  ],
} as const satisfies ClassDecl;
