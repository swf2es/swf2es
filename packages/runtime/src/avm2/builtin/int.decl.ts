import type { ClassDecl } from "./declare.js";

export const intDecl = {
  name: "int",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: [["*", ["int", 0]]], avmplus: true },
  classInit: { avmplus: true },
  static: [
    { const: "MIN_VALUE", type: "int", value: ["int", -2147483648] },
    { const: "MAX_VALUE", type: "int", value: ["int", 2147483647] },
    { const: "length", type: "int", value: ["int", 1] },
  ],
  instance: [
    { method: "AS3::toString", params: [["*", ["int", 10]]], returns: "String", avmplus: true },
    { method: "AS3::valueOf", returns: "int", avmplus: true },
    { method: "AS3::toExponential", params: [["*", ["int", 0]]], returns: "String", avmplus: true },
    { method: "AS3::toPrecision", params: [["*", ["int", 0]]], returns: "String", avmplus: true },
    { method: "AS3::toFixed", params: [["*", ["int", 0]]], returns: "String", avmplus: true },
  ],
} as const satisfies ClassDecl;
