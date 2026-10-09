import type { ClassDecl } from "./declare.js";

export const MethodClosureClass = {
  name: "private::MethodClosure",
  super: "Function",
  sealed: true,
  final: true,
  protectedNs: "builtin.as$0:MethodClosure",
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    { get: "prototype", override: true, avmplus: true },
    { set: "prototype", override: true, params: ["*"], avmplus: true },
  ],
} as const satisfies ClassDecl;
