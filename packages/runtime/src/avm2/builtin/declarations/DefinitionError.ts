// DefinitionError, as SWFs link against it (see ../declare.ts).

import type { ClassDecl } from "../declare.js";

export const DefinitionErrorClass: ClassDecl = {
  name: "DefinitionError",
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
};
