// Class aliases, and AMF through ByteArray's readObject and writeObject.
import { readObject, writeObject } from "../amf.js";
import type { AsObject, Value } from "../runtime.js";
import { bytesOf } from "./bytearray.js";
import { type Natives, plain } from "./define.js";

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
  "flash.net::ObjectEncoding.get:dynamicPropertyWriter": plain(() => null),
  "flash.utils::ByteArray#writeObject": (rt) =>
    function (this: AsObject, v: Value) {
      writeObject(rt, bytesOf(rt, this), v);
    },
  "flash.utils::ByteArray#readObject": (rt) =>
    function (this: AsObject) {
      return readObject(rt, bytesOf(rt, this));
    },
};
