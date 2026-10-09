import type { ClassDecl } from "../../declare.js";

export const ProxyDecl = {
  name: "flash.utils::Proxy",
  super: "Object",
  sealed: true,
  init: { native: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    { method: "flash_proxy::getProperty", params: ["*"], native: true },
    { method: "flash_proxy::setProperty", params: ["*", "*"], returns: "void", native: true },
    { method: "flash_proxy::callProperty", params: ["*"], rest: true, native: true },
    { method: "flash_proxy::hasProperty", params: ["*"], returns: "Boolean", native: true },
    { method: "flash_proxy::deleteProperty", params: ["*"], returns: "Boolean", native: true },
    { method: "flash_proxy::getDescendants", params: ["*"], native: true },
    { method: "flash_proxy::nextNameIndex", params: ["int"], returns: "int", native: true },
    { method: "flash_proxy::nextName", params: ["int"], returns: "String", native: true },
    { method: "flash_proxy::nextValue", params: ["int"], native: true },
    { method: "flash_proxy::isAttribute", params: ["*"], returns: "Boolean", native: true },
  ],
} as const satisfies ClassDecl;
