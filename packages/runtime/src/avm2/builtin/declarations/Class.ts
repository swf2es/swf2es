// Class, as SWFs link against it (see ../declare.ts).

import type { ClassDecl } from "../declare.js";

export const ClassClass: ClassDecl = {
  name: "Class",
  super: "Object",
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [{ const: "length", type: "int", value: ["int", 1] }],
  instance: [{ get: "prototype", final: true, native: true }],
};
