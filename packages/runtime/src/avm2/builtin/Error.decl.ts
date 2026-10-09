import type { ClassDecl } from "./declare.js";

export const ErrorDecl = {
  name: "Error",
  super: "Object",
  init: {
    params: [
      ["*", ["string", ""]],
      ["*", ["int", 0]],
    ],
    native: true,
  },
  classInit: { avmplus: true },
  static: [
    { const: "length", type: "int", value: ["int", 1] },
    { method: "getErrorMessage", final: true, params: ["int"], returns: "String", native: true },
    { method: "throwError", final: true, params: ["Class", "uint"], rest: true, native: true },
  ],
  instance: [
    { var: "message" },
    { var: "name" },
    { method: "getStackTrace", returns: "String", native: true },
    { var: "private::_errorID", type: "int" },
    { get: "errorID", returns: "int", native: true },
  ],
} as const satisfies ClassDecl;
