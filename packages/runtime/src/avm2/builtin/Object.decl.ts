import type { ClassDecl } from "./declare.js";

export const ObjectClass = {
  name: "Object",
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [
    { const: "length", type: "int", value: ["int", 1] },
    {
      method: "private::_hasOwnProperty",
      final: true,
      params: ["*", "String"],
      returns: "Boolean",
      native: true,
    },
    {
      method: "private::_propertyIsEnumerable",
      final: true,
      params: ["*", "String"],
      returns: "Boolean",
      native: true,
    },
    {
      method: "staticprotected::_setPropertyIsEnumerable",
      final: true,
      params: ["*", "String", "Boolean"],
      returns: "void",
      native: true,
    },
    {
      method: "private::_isPrototypeOf",
      final: true,
      params: ["*", "*"],
      returns: "Boolean",
      native: true,
    },
    { method: "private::_toString", final: true, params: ["*"], returns: "String", native: true },
    {
      method: "staticprotected::_dontEnumPrototype",
      final: true,
      params: ["Object"],
      returns: "void",
      avmplus: true,
    },
    { method: "internal::init", final: true, avmplus: true },
    { method: "_init", final: true, avmplus: true, api: 52, meta: [["API", [["", "712"]]]] },
  ],
  instance: [
    {
      method: "AS3::isPrototypeOf",
      params: [["*", ["undefined", null]]],
      returns: "Boolean",
      avmplus: true,
    },
    {
      method: "AS3::hasOwnProperty",
      params: [["*", ["undefined", null]]],
      returns: "Boolean",
      avmplus: true,
    },
    {
      method: "AS3::propertyIsEnumerable",
      params: [["*", ["undefined", null]]],
      returns: "Boolean",
      avmplus: true,
    },
  ],
} as const satisfies ClassDecl;
