import type { ClassDecl } from "./declare.js";

export const ErrorClass = {
  name: "Error",
  super: "Object",
  init: {
    params: [
      ["*", ["string", ""]],
      ["*", ["int", 0]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [
    { const: "length", type: "int", value: ["int", 1] },
    { method: "getErrorMessage", final: true, params: ["int"], returns: "String", native: true },
    { method: "throwError", final: true, params: ["Class", "uint"], rest: true, avmplus: true },
  ],
  instance: [
    { var: "message" },
    { var: "name" },
    { method: "getStackTrace", returns: "String", native: true },
    { var: "private::_errorID", type: "int" },
    { get: "errorID", returns: "int", avmplus: true },
  ],
} as const satisfies ClassDecl;
