import type { ClassDecl } from "./declare.js";

export const SyntaxErrorDecl = {
  name: "SyntaxError",
  super: "Error",
  init: {
    params: [
      ["*", ["string", ""]],
      ["*", ["int", 0]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [],
} as const satisfies ClassDecl;
