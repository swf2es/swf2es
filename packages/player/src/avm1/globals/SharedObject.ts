// SharedObject, AS1 and AS2's local kind, as Ruffle's (https://github.com/
// ruffle-rs/ruffle) core/src/avm1/globals/shared_object.rs and
// core/src/avm1/amf.rs have it: MIT OR Apache-2.0, Copyright (c) 2018-2022
// Ruffle LLC and Ruffle contributors. Its data is kept in the host's
// storage as the .sol file Flash writes for AVM1, AMF0, under the key AS3's
// SharedObject uses (playerglobal/flash/net/SharedObject.ts), so that
// one SWF's saves are found whichever AVM reads them.
//
// A .sol file: 0x00BF, the length of what follows, "TCSO", 00 04 00 00 00
// 00, the name (u16 length, UTF-8), the AMF version as a u32 (0 here), then
// each of the data's properties: its name (u16 length), its AMF0 value, a 0.
import { avm1 } from "@swf2es/runtime";
import type { SharedObjectStorage } from "../../hosts.js";
import { put, Reader, Writer } from "../amf.js";

const encoder = new TextEncoder();

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

/** What SharedObject reads of the movie. */
export interface SharedObjectHost {
  readonly realm: avm1.Realm;
  /** The SWF's URL, which the key is made of. */
  readonly url: string;
  readonly storage: SharedObjectStorage;
  /** The name Object.registerClass gave `constr`, which AMF0 writes an object of as typed; null for none. */
  registeredName(constr: Value): string | null;
}

/** What a name may not hold, white space included: getLocal then gives null (adl; Ruffle's INVALID_CHARS). */
const BAD_NAME = /[~%&\\;:"',<>?#\s]/;

/** The .sol file of `data` under `name`: empty for no properties, as Flash writes none. */
function serialize(host: SharedObjectHost, name: string, data: Value, version: number): Uint8Array {
  if (!(data instanceof avm1.Avm1Object)) {
    return new Uint8Array(0);
  }

  const body = new Writer((c) => host.registeredName(c), version, data);
  // Each property a name, a value and a 0, the object's own references shared across them.
  const entry = new Writer((c) => host.registeredName(c), version, data);
  for (const key of avm1.keys(data, version).reverse()) {
    const v = avm1.find(data, key, version)?.get ? undefined : avm1.get(data, key, version);
    if (v instanceof avm1.Avm1Function) {
      continue;
    }

    entry.name(key);
    entry.value(v);
    entry.bytes(0);
  }

  if (entry.size === 0) {
    return new Uint8Array(0);
  }

  const title = encoder.encode(name).subarray(0, 0xffff);
  body.bytes(0x00, 0xbf);
  body.u32(0);
  body.bytes(0x54, 0x43, 0x53, 0x4f, 0, 4, 0, 0, 0, 0);
  body.u16(title.length);
  body.push(title);
  body.u32(0);
  for (const chunk of entry.chunks) {
    body.push(chunk);
  }

  const file = new Uint8Array(body.size);
  let at = 0;
  for (const chunk of body.chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }

  new DataView(file.buffer).setUint32(2, file.length - 6);
  return file;
}

/** The data a .sol file holds, or null for one that is not AMF0's or cannot be read. */
function deserialize(bytes: Uint8Array, realm: avm1.Realm, version: number): Obj | null {
  if (bytes.length < 18 || bytes[0] !== 0x00 || bytes[1] !== 0xbf) {
    return null;
  }

  const reader = new Reader(bytes, realm, version, true);
  const data = realm.newObject(version);
  try {
    reader.at = 16;
    reader.name();
    // An AMF3 file, AS3's, is not AS2's to read.
    if (reader.u32() !== 0) {
      return null;
    }

    while (reader.at < bytes.length) {
      const key = reader.name();
      put(data, key, reader.value(), version);
      // The 0 after each value.
      reader.at++;
    }
  } catch {
    return null;
  }

  return data;
}

const FIXED = avm1.DONT_ENUM | avm1.DONT_DELETE;

/** `_global.SharedObject`, and what writes its objects changed since read or written, as a player goes. */
export function sharedObjectClass(host: SharedObjectHost): {
  constr: Obj;
  flush(version: number): void;
} {
  const realm = host.realm;
  const proto = new avm1.Avm1Object(realm.objectProto);
  const constr = realm.classOf(
    proto,
    (self) => self,
    () => undefined,
  );
  /** The objects getLocal made, by key, and what each was last read or written as. */
  const open = new Map<string, { o: Obj; name: string; saved: Uint8Array }>();
  const entryOf = (self: Obj) => {
    for (const entry of open.values()) {
      if (entry.o === self) {
        return entry;
      }
    }

    return undefined;
  };
  const method = (name: string, f: avm1.Native) => proto.define(name, realm.method(f), FIXED);
  const stub = () => undefined;

  constr.define(
    "getLocal",
    realm.method((_, args, v) => {
      const name = avm1.stringOf(args[0], v);
      if (name === "" || BAD_NAME.test(name)) {
        return null;
      }

      let url: URL;
      try {
        url = new URL(host.url, "file:///");
      } catch {
        return null;
      }

      const secure = args.length > 2 && avm1.toBoolean(args[2], v);
      if (secure && url.protocol !== "https:") {
        return null;
      }

      // The SWF's own path by default; a path it names must lead to the SWF, as AS3's.
      const own = url.pathname.endsWith("/") ? `${url.pathname}[swf]` : url.pathname;
      let path = own;
      if (args.length > 1 && typeof args[1] === "string") {
        path = args[1];
        if (path === "") {
          return null;
        }

        const directory = path.endsWith("/") ? path : `${path}/`;
        if (path !== own && !own.startsWith(directory)) {
          return null;
        }
      }

      const key = `${url.host}${path.startsWith("/") ? "" : "/"}${path}/${name}${secure ? "#secure" : ""}`;
      if (key.split("/").some((part) => part.startsWith("."))) {
        return null;
      }

      const known = open.get(key);
      if (known) {
        return known.o;
      }

      const o = new avm1.Avm1Object(avm1.get(constr, "prototype", v));
      let stored: Uint8Array | null = null;
      try {
        stored = host.storage.get(key);
      } catch {
        stored = null;
      }

      const data = (stored && deserialize(stored, realm, v)) ?? realm.newObject(v);
      o.define("data", data, avm1.DONT_DELETE);
      open.set(key, { o, name, saved: serialize(host, name, data, v) });
      return o;
    }),
    0,
  );
  constr.define("getRemote", realm.method(stub), 0);
  constr.define("deleteAll", realm.method(stub), avm1.DONT_ENUM);
  constr.define("getDiskUsage", realm.method(stub), avm1.DONT_ENUM);

  // Written now: true, or false where storage refuses it, a full quota say. Flash writes no
  // empty one, and says it did.
  method("flush", (self, _, v) => {
    const entry = entryOf(self);
    if (!entry) {
      return undefined;
    }

    // Data nested too deep to write fails as a refused write does.
    let file: Uint8Array;
    try {
      file = serialize(host, entry.name, avm1.get(self, "data", v), v);
    } catch {
      return false;
    }

    if (file.length === 0) {
      return true;
    }

    for (const [key, e] of open) {
      if (e === entry) {
        try {
          host.storage.set(key, file);
        } catch {
          return false;
        }
      }
    }

    entry.saved = file;
    return true;
  });
  // The file's size, header and all; 0 for none.
  method("getSize", (self, _, v) => {
    const entry = entryOf(self);
    if (!entry) {
      return undefined;
    }

    try {
      return serialize(host, entry.name, avm1.get(self, "data", v), v).length;
    } catch {
      return 0;
    }
  });
  // Every property of the data deleted, and the file with them.
  method("clear", (self, _, v) => {
    const entry = entryOf(self);
    const data = avm1.get(self, "data", v);
    if (data instanceof avm1.Avm1Object) {
      for (const key of avm1.keys(data, v)) {
        avm1.removeOwn(data, key, v);
      }
    }

    for (const [key, e] of open) {
      if (e === entry) {
        try {
          host.storage.remove(key);
        } catch {
          // Storage the host refuses keeps nothing to remove.
        }

        e.saved = new Uint8Array(0);
      }
    }

    return undefined;
  });
  for (const name of ["connect", "send", "close", "setFps", "onStatus", "onSync"]) {
    method(name, stub);
  }

  return {
    constr,
    // Flash wrote each open object as its SWF went: what a script changed since it was read or
    // written. Never a removal: an object whose stored file could not be read starts empty.
    flush(version) {
      for (const [key, entry] of open) {
        try {
          const file = serialize(host, entry.name, avm1.get(entry.o, "data", version), version);
          if (file.length && !sameBytes(file, entry.saved)) {
            host.storage.set(key, file);
            entry.saved = file;
          }
        } catch {
          // One that cannot be written keeps the others from nothing.
        }
      }
    },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}
