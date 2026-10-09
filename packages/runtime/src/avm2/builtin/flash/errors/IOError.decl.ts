import type { ClassDecl } from "../../declare.js";

export const IOErrorDecl = {
  name: "flash.errors::IOError",
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
