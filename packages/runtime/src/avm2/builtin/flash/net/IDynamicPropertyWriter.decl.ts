import type { ClassDecl } from "../../declare.js";

export const IDynamicPropertyWriterClass = {
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
} as const satisfies ClassDecl;
