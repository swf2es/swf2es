import type { ClassDecl } from "../../declare.js";

export const IExternalizableClass = {
  name: "flash.utils::IExternalizable",
  sealed: true,
  interface: true,
  init: {},
  classInit: { avmplus: true },
  static: [],
  instance: [
    {
      method: "ns:flash.utils:IExternalizable::writeExternal",
      params: ["flash.utils::IDataOutput"],
      returns: "void",
    },
    {
      method: "ns:flash.utils:IExternalizable::readExternal",
      params: ["flash.utils::IDataInput"],
      returns: "void",
    },
  ],
} as const satisfies ClassDecl;
