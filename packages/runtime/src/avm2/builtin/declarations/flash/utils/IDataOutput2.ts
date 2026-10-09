// IDataOutput2, as SWFs link against it (see ../../../declare.ts).

import type { ClassDecl } from "../../../declare.js";

export const IDataOutput2Class: ClassDecl = {
  name: "internal:flash.utils::IDataOutput2",
  interfaces: ["flash.utils::IDataOutput"],
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [],
};
