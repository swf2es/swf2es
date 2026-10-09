import type { ClassDecl } from "../../declare.js";

export const ObjectEncodingClass = {
  name: "flash.net::ObjectEncoding",
  super: "Object",
  sealed: true,
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [
    { const: "AMF0", type: "uint", value: ["int", 0] },
    { const: "AMF3", type: "uint", value: ["int", 3] },
    { const: "DEFAULT", type: "uint", value: ["int", 3] },
    {
      get: "dynamicPropertyWriter",
      final: true,
      returns: "flash.net::IDynamicPropertyWriter",
      native: true,
    },
    {
      set: "dynamicPropertyWriter",
      final: true,
      params: ["flash.net::IDynamicPropertyWriter"],
      returns: "void",
      native: true,
    },
  ],
  instance: [],
} as const satisfies ClassDecl;
