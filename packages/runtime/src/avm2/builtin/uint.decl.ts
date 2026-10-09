import type { ClassDecl } from "./declare.js";

export const uintDecl = {
  name: "uint",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: [["*", ["int", 0]]], native: true },
  classInit: { avmplus: true },
  static: [
    { const: "MIN_VALUE", type: "uint", value: ["int", 0] },
    { const: "MAX_VALUE", type: "uint", value: ["double", 4294967295] },
    { const: "length", type: "int", value: ["int", 1] },
  ],
  instance: [
    { method: "AS3::toString", params: [["*", ["int", 10]]], returns: "String", native: true },
    { method: "AS3::valueOf", returns: "uint", native: true },
    { method: "AS3::toExponential", params: [["*", ["int", 0]]], returns: "String", native: true },
    { method: "AS3::toPrecision", params: [["*", ["int", 0]]], returns: "String", native: true },
    { method: "AS3::toFixed", params: [["*", ["int", 0]]], returns: "String", native: true },
  ],
} as const satisfies ClassDecl;
