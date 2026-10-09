import type { ClassDecl } from "../../declare.js";

export const EOFErrorClass = {
  name: "flash.errors::EOFError",
  super: "flash.errors::IOError",
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
