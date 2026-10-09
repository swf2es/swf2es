import type { ClassDecl } from "./declare.js";

export const QNameDecl = {
  name: "QName",
  super: "Object",
  sealed: true,
  final: true,
  init: {
    params: [
      ["*", ["undefined", null]],
      ["*", ["undefined", null]],
    ],
    native: true,
  },
  classInit: { avmplus: true },
  static: [{ const: "length", value: ["int", 2] }],
  instance: [
    { get: "localName", returns: "String", native: true },
    { get: "uri", native: true },
    { method: "AS3::valueOf", returns: "QName", native: true },
    { method: "AS3::toString", returns: "String", native: true },
  ],
} as const satisfies ClassDecl;
