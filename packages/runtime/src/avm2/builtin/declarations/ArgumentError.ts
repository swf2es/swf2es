import type { ClassDecl } from "../declare.js";

export const ArgumentErrorClass: ClassDecl = {
  name: "ArgumentError",
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
