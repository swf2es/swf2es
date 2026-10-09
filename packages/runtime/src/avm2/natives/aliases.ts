// Class aliases, and AMF through ByteArray's readObject and writeObject.
import type { AsObject, Value } from "../descriptors.js";
import type { Natives } from "./define.js";

export const aliasesNatives: Natives = {
  // Class aliases and AMF.
  "flash.net::registerClassAlias": (rt) => (aliasName: Value, cls: Value) => {
    if (cls === null || cls === undefined) {
      throw rt.error("TypeError", 2007, "classObject");
    }

    if (aliasName === null || aliasName === undefined) {
      throw rt.error("TypeError", 2007, "aliasName");
    }

    const name = rt.toString(aliasName);
    if (name === "") {
      throw rt.error("ArgumentError", 2085, "aliasName");
    }

    rt.registerClassAlias(name, cls);
  },
  "flash.net::getClassByAlias": (rt) => (aliasName: Value) => {
    if (aliasName === null || aliasName === undefined) {
      throw rt.error("TypeError", 2007, "aliasName");
    }

    const name = rt.toString(aliasName);
    if (name === "") {
      throw rt.error("ArgumentError", 2085, "aliasName");
    }

    return rt.classByAlias(name);
  },
  "flash.net::ObjectEncoding.get:dynamicPropertyWriter": (rt) => () => rt.dynamicPropertyWriter,
  "flash.net::ObjectEncoding.set:dynamicPropertyWriter": (rt) => (writer: Value) => {
    rt.dynamicPropertyWriter = writer ?? null;
  },
  // What writeDynamicProperties writes through: the object being written's
  // dynamic part, each name and value.
  "flash.net::DynamicPropertyOutput#writeDynamicProperty": (rt) =>
    function (this: AsObject, name: Value, value: Value) {
      if (name === null || name === undefined) {
        throw rt.error("TypeError", 2007, "name");
      }

      this.$amf.dynamicProperty(rt.toString(name), value);
    },
};
