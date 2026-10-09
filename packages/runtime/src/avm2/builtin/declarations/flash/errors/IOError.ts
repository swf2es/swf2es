import type { ClassDecl } from "../../../declare.js";

export const IOErrorClass: ClassDecl = {
  name: "flash.errors::IOError",
  super: "Error",
  init: {
    params: [
      ["String", ["string", ""]],
      ["int", ["int", 0]],
    ],
    avmplus: true,
  },
  classInit: { avmplus: true },
  static: [],
  instance: [],
};
