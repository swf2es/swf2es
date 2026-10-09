import type { ClassDecl } from "./declare.js";

export const FunctionDecl = {
  name: "Function",
  super: "Object",
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [
    { const: "length", type: "int", value: ["int", 1] },
    {
      method: "createEmptyFunction",
      final: true,
      returns: "Function",
      avmplus: true,
      api: 52,
      meta: [
        ["cppcall", []],
        ["API", [["", "712"]]],
      ],
    },
  ],
  instance: [
    { get: "prototype", native: true },
    { set: "prototype", params: ["*"], native: true },
    { get: "length", returns: "int", native: true },
    { method: "AS3::call", params: [["*", ["undefined", null]]], rest: true, native: true },
    {
      method: "AS3::apply",
      params: [
        ["*", ["undefined", null]],
        ["*", ["undefined", null]],
      ],
      native: true,
    },
  ],
} as const satisfies ClassDecl;
