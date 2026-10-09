// Dictionary, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const DictionaryClass: ClassDecl = {
  name: "flash.utils::Dictionary",
  super: "Object",
  init: { params: [["Boolean", ["boolean", false]]], avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [{ method: "private::init", params: ["Boolean"], returns: "void", native: true }],
};
