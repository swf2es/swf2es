// flash.net.SharedObject, the local kind: its data kept in the host's
// storage (Scripting.storage) as Flash's .sol file has it, written when it
// is flushed, read when getLocal first asks for it, one object for a name
// and path. Remote ones, getRemote's, are not here.
//
// A .sol file: 0x00BF, the length of what follows, "TCSO", 00 04 00 00 00
// 00, the name (u16 length, UTF-8), the AMF version as a u32 (0 or 3),
// then each of the data's properties: its name (AMF3: a string; AMF0: u16
// length and UTF-8), its value as writeObject writes it, and a 0. The
// properties share one writer's tables, as adl writes them: a second
// property of an object already written is a reference to it, and in AMF3
// a string, the names' too, a reference to the first of it.
// Flash's size is the file's, 0 for none, as the shared-objects case has it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";
import * as amf0 from "./amf0.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

// SharedObject's private invoke codes, as its AS3 numbers them.
const FLUSH = 2;
const CLOSE = 3;
const GET_SIZE = 4;
const CLEAR = 6;

/** What a name may not hold, as Flash refuses it (Error #2134); % it allows. */
const BAD_NAME = /[~&\\;:"',<>?#\s]/;

export function sharedObjectNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  /** The shared objects getLocal made, by key: one for each, as Flash's. */
  const open = new Map<string, AsObject>();
  let defaultEncoding = 3;
  let preventBackup = false;

  const encoder = new TextEncoder();
  // A ByteArray's bytes, not bare ones: an IExternalizable's writeExternal
  // and readExternal reach the ByteArray they are over.
  const bytes = (): avm2.Bytes =>
    avm2.bytesOf(s.rt, s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")));

  /** What `o` serializes to now, for destroy to tell a change by; null where it cannot. */
  const saved = (o: AsObject): Uint8Array | null => {
    try {
      return serialize(o);
    } catch {
      return null;
    }
  };

  /** Write `o`'s .sol file, or remove it for no data: false where storage refuses, as a full quota, which flush reports as #2130. */
  const write = (o: AsObject): boolean => {
    const file = serialize(o);
    try {
      if (file.length) {
        s.storage.set(o.$key, file);
      } else {
        s.storage.remove(o.$key);
      }
    } catch {
      return false;
    }

    o.$saved = file;
    return true;
  };

  /** The .sol file of `o`'s data, in its encoding; none, empty, for no properties. */
  const serialize = (o: AsObject): Uint8Array => {
    const entries: Map<Value, Value> = o.$data.$d ?? new Map();
    if (entries.size === 0) {
      return new Uint8Array(0);
    }

    const amf3 = o.$encoding >= 3;
    const name = encoder.encode(o.$name);
    const header = new Uint8Array(6 + 10 + 2 + name.length + 4);
    header.set([0x00, 0xbf], 0);
    header.set([0x54, 0x43, 0x53, 0x4f, 0, 4, 0, 0, 0, 0], 6);
    header.set([name.length >> 8, name.length & 0xff], 16);
    header.set(name, 18);
    header[header.length - 1] = amf3 ? 3 : 0;
    const b = bytes();
    b.write(header);
    const w3 = amf3 ? new avm2.Amf3Writer(s.rt, b) : null;
    const w0 = amf3 ? null : new amf0.Writer(s.rt, b);
    for (const [key, value] of entries) {
      if (w3) {
        w3.string(String(key));
        w3.value(value);
      } else {
        (w0 as amf0.Writer).name(String(key));
        (w0 as amf0.Writer).value(value);
      }

      b.write(END);
    }

    const file = b.buffer.slice(0, b.length);
    new DataView(file.buffer).setUint32(2, file.length - 6);
    return file;
  };

  /** The data a .sol file holds, or null for one it cannot read. */
  const deserialize = (file: Uint8Array): AsObject | null => {
    if (file.length < 18 || file[0] !== 0x00 || file[1] !== 0xbf) {
      return null;
    }

    const nameLength = (file[16] << 8) | file[17];
    const at = 18 + nameLength;
    const b = bytes();
    b.write(file);
    b.position = at + 4;
    const amf3 = file[at + 3] === 3;
    const r3 = amf3 ? new avm2.Amf3Reader(s.rt, b) : null;
    const r0 = amf3 ? null : new amf0.Reader(s.rt, b);
    const data = s.rt.newObject([]);
    try {
      while (b.position < b.length) {
        const key = r3 ? r3.string() : (r0 as amf0.Reader).name();
        const value = r3 ? r3.value() : (r0 as amf0.Reader).value();
        s.rt.setProperty(data, avm2.qname(avm2.publicNs, key), value);
        // The 0 after each value.
        b.position = (b.position + 1) >>> 0;
      }
    } catch {
      return null;
    }

    return data;
  };

  const unavailable = (url: Value): never => {
    if (url === null || url === undefined) {
      throw s.rt.error("TypeError", 2007, "url");
    }

    throw s.rt.error("Error", 2014);
  };

  class SharedObjectNatives {
    declare $data: AsObject;
    declare $key: string;
    declare $name: string;
    declare $encoding: number;
    declare $client: Value;
    // What it serialized to when last read or written: a change from it is what destroy writes.
    declare $saved: Uint8Array | null;

    static getLocal(name: Value, localPath: Value, secure: Value): Value {
      if (name === null || name === undefined) {
        throw s.rt.error("TypeError", 2007, "name");
      }

      const text = s.rt.toString(name);
      if (text === "" || BAD_NAME.test(text)) {
        throw s.rt.error("Error", 2134);
      }

      // The SWF whose code asks, which a loaded one's is, not the main SWF.
      const url = new URL(s.code.codeUrl(), "file:///");
      // A secure one only for a SWF that came over HTTPS; adl, whose SWFs
      // never do, refuses it so.
      if (secure && url.protocol !== "https:") {
        throw s.rt.error("Error", 2134);
      }

      // By default the SWF's own path, file name and all, which is never a
      // directory's; one known by no file name is kept apart from its
      // directory's as well. A path it names must lead to the SWF: "/" or
      // one of the directories above it, as adl refuses any other.
      const own = url.pathname.endsWith("/") ? `${url.pathname}[swf]` : url.pathname;
      let path = own;
      if (localPath !== null && localPath !== undefined) {
        path = s.rt.toString(localPath);
        const directory = path.endsWith("/") ? path : `${path}/`;
        if (path !== own && !own.startsWith(directory)) {
          throw s.rt.error("Error", 2134);
        }
      }

      // Secure ones apart: a SWF that comes over HTTP never sees them.
      const key = `${url.host}${path.startsWith("/") ? "" : "/"}${path}/${text}${secure ? "#secure" : ""}`;
      const known = open.get(key);
      if (known) {
        return known;
      }

      const o = s.rt.construct(s.rt.classNamed("flash.net::SharedObject")) as AsObject;
      o.$key = key;
      o.$name = text;
      o.$encoding = defaultEncoding;
      o.$client = o;
      const stored = s.storage.get(key);
      o.$data = (stored && deserialize(stored)) ?? s.rt.newObject([]);
      o.$saved = saved(o);
      open.set(key, o);
      return o;
    }

    // Hidden from authoring tools, and refused to content: a SWF in the
    // browser's Flash Player 32 or in adl gets Error #2014 whatever it
    // names, its own site included, and nothing is deleted. Taking them
    // as named would let any SWF on a page's origin measure or wipe every
    // other SWF's saves there.
    static deleteAll(url: Value): number {
      return unavailable(url);
    }

    static getDiskUsage(url: Value): number {
      return unavailable(url);
    }

    static get defaultObjectEncoding(): number {
      return defaultEncoding;
    }

    // Any uint, as adl keeps it; one below 3 writes AMF0.
    static set defaultObjectEncoding(v: Value) {
      defaultEncoding = s.rt.toUint(v);
    }

    static get "flash.net:SharedObject::preventBackupImpl"(): boolean {
      return preventBackup;
    }

    static set "flash.net:SharedObject::preventBackupImpl"(v: Value) {
      preventBackup = !!v;
    }

    get data(): Value {
      return this.$data;
    }

    get objectEncoding(): number {
      return this.$encoding;
    }

    set objectEncoding(v: Value) {
      this.$encoding = s.rt.toUint(v) === 0 ? 0 : 3;
    }

    get client(): Value {
      return this.$client;
    }

    set client(v: Value) {
      this.$client = v;
    }

    setDirty(_name: Value): void {}

    // Flush returns true, which flush reports as FLUSHED, or false for #2130.
    "flash.net:SharedObject::invoke"(code: Value, ..._args: Value[]): Value {
      switch (s.rt.toUint(code)) {
        case FLUSH:
          return write(this);
        case GET_SIZE:
          return serialize(this).length;
        case CLEAR:
          this.$data = s.rt.newObject([]);
          this.$saved = new Uint8Array(0);
          s.storage.remove(this.$key);
          return undefined;
        case CLOSE:
          return undefined;
        default:
          throw s.rt.unsupported("SharedObject's remote calls");
      }
    }
  }

  // Flash wrote each open object as its SWF went: a player hidden or
  // destroyed writes those a script changed since they were read or written. Never
  // a removal: an object whose stored file it could not read starts empty,
  // and an unchanged one would take the file away.
  s.flushSharedObjects = () => {
    for (const o of open.values()) {
      try {
        const file = serialize(o);
        if (file.length && !sameBytes(file, o.$saved)) {
          s.storage.set(o.$key, file);
          o.$saved = file;
        }
      } catch {
        // One that cannot be written, as one a full quota refuses, keeps the others from nothing.
      }
    }
  };

  avm2.registerNativeClass(natives, "flash.net::SharedObject", SharedObjectNatives);
  return natives;
}

function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
  return b !== null && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The 0 after each value. */
const END = new Uint8Array(1);
