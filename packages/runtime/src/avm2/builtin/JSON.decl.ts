import type { ClassDecl } from "./declare.js";

export const JSONDecl = {
  name: "JSON",
  api: 14,
  super: "Object",
  sealed: true,
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [
    {
      const: "private::as3ns",
      type: "Namespace",
      value: ["namespace", "namespace:http://adobe.com/AS3/2006/builtin"],
    },
    {
      method: "private::parseCore",
      final: true,
      params: ["String"],
      returns: "Object",
      native: true,
    },
    {
      method: "private::stringifySpecializedToString",
      final: true,
      params: ["Object", "Array", "Function", "String"],
      returns: "String",
      native: true,
    },
    {
      method: "parse",
      final: true,
      params: ["String", ["Function", ["null", null]]],
      returns: "Object",
      avmplus: true,
    },
    {
      method: "stringify",
      final: true,
      params: ["Object", ["*", ["null", null]], ["*", ["null", null]]],
      returns: "String",
      avmplus: true,
    },
    {
      method: "private::computePropertyList",
      final: true,
      params: ["Array"],
      returns: "Array",
      avmplus: true,
    },
  ],
  instance: [],
} as const satisfies ClassDecl;
