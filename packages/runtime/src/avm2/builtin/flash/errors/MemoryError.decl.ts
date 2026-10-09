import type { ClassDecl } from "../../declare.js";

export const MemoryErrorDecl = {
  name: "flash.errors::MemoryError",
  super: "Error",
  init: {
    params: [
      ["String", ["string", ""]],
      ["int", ["int", 0]],
    ],
    native: true,
  },
  classInit: { avmplus: true },
  static: [],
  instance: [],
} as const satisfies ClassDecl;
