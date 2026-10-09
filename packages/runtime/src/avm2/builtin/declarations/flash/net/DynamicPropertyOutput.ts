// DynamicPropertyOutput, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const DynamicPropertyOutputClass: ClassDecl = {
  name: "internal:flash.net::DynamicPropertyOutput",
  super: "Object",
  interfaces: ["flash.net::IDynamicPropertyOutput"],
  sealed: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [],
  instance: [
    { method: "writeDynamicProperty", params: ["String", "*"], returns: "void", native: true },
  ],
};
