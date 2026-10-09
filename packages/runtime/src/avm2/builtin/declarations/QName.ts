import type { ClassDecl } from "../declare.js";

export const QNameClass: ClassDecl = {
  name: "QName",
  super: "Object",
  sealed: true,
  final: true,
  init: {
    params: [
      ["*", ["undefined", null]],
      ["*", ["undefined", null]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [{ const: "length", value: ["int", 2] }],
  instance: [
    { get: "localName", returns: "String", native: true },
    { get: "uri", native: true },
    { method: "AS3::valueOf", returns: "QName", avmplus: true },
    { method: "AS3::toString", returns: "String", avmplus: true },
  ],
};
