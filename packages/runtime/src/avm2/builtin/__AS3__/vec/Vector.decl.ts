import type { ClassDecl } from "../../declare.js";

export const VectorClass = {
  name: "__AS3__.vec::Vector",
  super: "Object",
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [],
} as const satisfies ClassDecl;
