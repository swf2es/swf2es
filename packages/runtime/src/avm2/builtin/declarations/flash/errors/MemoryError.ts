// MemoryError, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const MemoryErrorClass: ClassDecl = {
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
};
