// Proxy, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const ProxyClass: ClassDecl = {
  name: "flash.utils::Proxy",
  super: "Object",
  sealed: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    { method: "flash_proxy::getProperty", params: ["*"], avmplus: true },
    { method: "flash_proxy::setProperty", params: ["*", "*"], returns: "void", avmplus: true },
    { method: "flash_proxy::callProperty", params: ["*"], rest: true, avmplus: true },
    { method: "flash_proxy::hasProperty", params: ["*"], returns: "Boolean", avmplus: true },
    { method: "flash_proxy::deleteProperty", params: ["*"], returns: "Boolean", avmplus: true },
    { method: "flash_proxy::getDescendants", params: ["*"], avmplus: true },
    { method: "flash_proxy::nextNameIndex", params: ["int"], returns: "int", avmplus: true },
    { method: "flash_proxy::nextName", params: ["int"], returns: "String", avmplus: true },
    { method: "flash_proxy::nextValue", params: ["int"], avmplus: true },
    { method: "flash_proxy::isAttribute", params: ["*"], returns: "Boolean", native: true },
  ],
};
