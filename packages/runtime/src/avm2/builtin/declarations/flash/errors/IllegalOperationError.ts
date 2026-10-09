// IllegalOperationError, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const IllegalOperationErrorClass: ClassDecl = {
  name: "flash.errors::IllegalOperationError",
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
