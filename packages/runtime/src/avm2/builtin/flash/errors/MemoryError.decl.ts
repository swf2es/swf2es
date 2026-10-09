import type { ClassDecl } from "../../declare.js";

export const MemoryErrorClass = {
  name: "flash.errors::MemoryError",
  super: "Error",
  init: {
    params: [
      ["String", ["string", ""]],
      ["int", ["int", 0]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [],
  instance: [],
} as const satisfies ClassDecl;
