import type { ClassDecl } from "./declare.js";

export const SecurityErrorDecl = {
  name: "SecurityError",
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
