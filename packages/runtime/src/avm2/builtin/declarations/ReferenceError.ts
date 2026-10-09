import type { ClassDecl } from "../declare.js";

export const ReferenceErrorClass: ClassDecl = {
  name: "ReferenceError",
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
