// Vector, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const VectorClass: ClassDecl = {
  name: "__AS3__.vec::Vector",
  super: "Object",
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [],
};
