import type { ClassDecl } from "./declare.js";

export const ArgumentErrorDecl = {
  name: "ArgumentError",
  super: "Error",
  init: {
    params: [
      ["*", ["string", ""]],
      ["*", ["int", 0]],
    ],
    native: true,
  },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [],
} as const satisfies ClassDecl;
