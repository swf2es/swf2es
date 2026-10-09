// IDynamicPropertyWriter, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const IDynamicPropertyWriterClass: ClassDecl = {
  name: "flash.net::IDynamicPropertyWriter",
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "ns:flash.net:IDynamicPropertyWriter::writeDynamicProperties",
      params: ["Object", "flash.net::IDynamicPropertyOutput"],
      returns: "void",
    },
  ],
};
