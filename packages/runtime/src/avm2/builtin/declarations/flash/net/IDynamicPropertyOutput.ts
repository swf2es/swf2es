// IDynamicPropertyOutput, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const IDynamicPropertyOutputClass: ClassDecl = {
  name: "flash.net::IDynamicPropertyOutput",
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "ns:flash.net:IDynamicPropertyOutput::writeDynamicProperty",
      params: ["String", "*"],
      returns: "void",
    },
  ],
};
