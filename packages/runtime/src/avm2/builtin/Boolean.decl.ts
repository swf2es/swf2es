import type { ClassDecl } from "./declare.js";

export const BooleanDecl = {
  name: "Boolean",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: [["*", ["undefined", null]]], avmplus: true },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [
    { method: "AS3::toString", returns: "String", avmplus: true },
    { method: "AS3::valueOf", returns: "Boolean", avmplus: true },
  ],
} as const satisfies ClassDecl;
