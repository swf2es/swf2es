import type { ClassDecl } from "./declare.js";

export const BooleanDecl = {
  name: "Boolean",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: [["*", ["undefined", null]]], native: true },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [
    { method: "AS3::toString", returns: "String", native: true },
    { method: "AS3::valueOf", returns: "Boolean", native: true },
  ],
} as const satisfies ClassDecl;
