import type { ClassDecl } from "./declare.js";

export const RegExpDecl = {
  name: "RegExp",
  super: "Object",
  init: {
    params: [
      ["*", ["undefined", null]],
      ["*", ["undefined", null]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [
    { get: "source", returns: "String", native: true },
    { get: "global", returns: "Boolean", native: true },
    { get: "ignoreCase", returns: "Boolean", native: true },
    { get: "multiline", returns: "Boolean", native: true },
    { get: "lastIndex", returns: "int", native: true },
    { set: "lastIndex", params: ["int"], native: true },
    { get: "dotall", returns: "Boolean", native: true },
    { get: "extended", returns: "Boolean", native: true },
    { method: "AS3::exec", params: [["String", ["string", ""]]], native: true },
    {
      method: "AS3::test",
      params: [["String", ["string", ""]]],
      returns: "Boolean",
      avmplus: true,
    },
  ],
} as const satisfies ClassDecl;
