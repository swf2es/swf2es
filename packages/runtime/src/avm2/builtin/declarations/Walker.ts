// Walker, as SWFs link against it (see ../declare.ts).

import type { ClassDecl } from "../declare.js";

export const WalkerClass: ClassDecl = {
  name: "internal:::Walker",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: ["Function"], avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    { method: "internal::walk", params: ["Object", "String"], avmplus: true },
    { var: "internal::reviver", type: "Function" },
  ],
};
