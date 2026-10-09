import type { ClassDecl } from "./declare.js";

export const NamespaceDecl = {
  name: "Namespace",
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
    { get: "prefix", native: true },
    { get: "uri", returns: "String", native: true },
    { method: "AS3::valueOf", returns: "String", native: true },
    { method: "AS3::toString", returns: "String", native: true },
  ],
} as const satisfies ClassDecl;
