import type { ClassDecl } from "../../declare.js";

export const DictionaryClass = {
  name: "flash.utils::Dictionary",
  super: "Object",
  init: { params: [["Boolean", ["boolean", false]]], avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [{ method: "private::init", params: ["Boolean"], returns: "void", native: true }],
} as const satisfies ClassDecl;
