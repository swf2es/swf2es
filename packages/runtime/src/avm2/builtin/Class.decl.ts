import type { ClassDecl } from "./declare.js";

export const ClassClassDecl = {
  name: "Class",
  super: "Object",
  init: { native: true },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [{ get: "prototype", final: true, native: true }],
} as const satisfies ClassDecl;
