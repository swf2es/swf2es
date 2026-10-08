// flash.net.SharedObject, the local kind: its data kept in the host's
// storage (Scripting.storage) as Flash's .sol file has it, written when it
// is flushed, read when getLocal first asks for it, one object for a name
// and path. Remote ones, getRemote's, are not here.
//
// A .sol file: 0x00BF, the length of what follows, "TCSO", 00 04 00 00 00
// 00, the name (u16 length, UTF-8), the AMF version as a u32 (0 or 3),
// then each of the data's properties: its name (AMF3: a string's U29
// header; AMF0: u16 length), its value as writeObject writes it, and a 0.
// Flash's size is the file's, 0 for none, as the shared-objects case has it.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../../scripting.js";

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
  const decoder = new TextDecoder();
  const byteArray = (encoding: number): AsObject => {
    const array = s.rt.construct(s.rt.classNamed("flash.utils::ByteArray")) as AsObject;
    s.rt.setProperty(array, avm2.qname(avm2.publicNs, "objectEncoding"), encoding);
    return array;
  };

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

  /**
   * The .sol file of `o`'s data, in its encoding; none, empty, for no
   * properties. AMF0 is the runtime's to write, which has none yet.
   */
  const serialize = (o: AsObject): Uint8Array => {
    if (o.$encoding !== 3) {
      throw s.rt.unsupported("an AMF0 SharedObject");
    }

    // Chunks joined once at the end: a value can be large enough that
    // spreading its bytes into one call would overflow the stack.
    const chunks: Uint8Array[] = [];
    for (const [key, value] of o.$data.$d ?? new Map()) {
      const name = encoder.encode(String(key));
      chunks.push(u29((name.length << 1) | 1), name);
      const array = byteArray(o.$encoding);
      s.rt.callProperty(array, avm2.qname(avm2.publicNs, "writeObject"), value);
      const b = avm2.bytesOf(s.rt, array);
      chunks.push(b.buffer.subarray(0, b.length), END);
    }

    if (chunks.length === 0) {
      return new Uint8Array(0);
    }

    const name = encoder.encode(o.$name);
    const header = new Uint8Array(6 + 10 + 2 + name.length + 4);
    header.set([0x00, 0xbf], 0);
    header.set([0x54, 0x43, 0x53, 0x4f, 0, 4, 0, 0, 0, 0], 6);
    header.set([name.length >> 8, name.length & 0xff], 16);
    header.set(name, 18);
    header[header.length - 1] = 3;
    let n = header.length;
    for (const chunk of chunks) {
      n += chunk.length;
    }

    const file = new Uint8Array(n);
    file.set(header);
    new DataView(file.buffer).setUint32(2, n - 6);
    let at = header.length;
    for (const chunk of chunks) {
      file.set(chunk, at);
      at += chunk.length;
    }

    return file;
  };

  /** The data a .sol file holds, or null for one it cannot read. */
  const deserialize = (bytes: Uint8Array): AsObject | null => {
    if (bytes.length < 18 || bytes[0] !== 0x00 || bytes[1] !== 0xbf) {
      return null;
    }

    let at = 16;
    const nameLength = (bytes[at] << 8) | bytes[at + 1];
    at += 2 + nameLength;
    const encoding = bytes[at + 3] === 3 ? 3 : 0;
    at += 4;
    const array = byteArray(encoding);
    const b = avm2.bytesOf(s.rt, array);
    b.write(bytes);
    const data = s.rt.newObject([]);
    try {
      while (at < bytes.length) {
        let length: number;
        if (encoding === 3) {
          const [n, next] = readU29(bytes, at);
          length = n >> 1;
          at = next;
        } else {
          length = (bytes[at] << 8) | bytes[at + 1];
          at += 2;
        }

        const key = decoder.decode(bytes.subarray(at, at + length));
        b.position = at + length;
        const value = s.rt.callProperty(array, avm2.qname(avm2.publicNs, "readObject"));
        s.rt.setProperty(data, avm2.qname(avm2.publicNs, key), value);
        // The 0 after each value.
        at = b.position + 1;
      }
    } catch {
      return null;
    }

    return data;
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

    static deleteAll(url: Value): number {
      const prefix = s.rt.toString(url);
      let n = 0;
      for (const key of s.storage.keys()) {
        if (key.startsWith(prefix)) {
          s.storage.remove(key);
          n++;
        }
      }

      return n;
    }

    static getDiskUsage(url: Value): number {
      const prefix = s.rt.toString(url);
      let n = 0;
      for (const key of s.storage.keys()) {
        if (key.startsWith(prefix)) {
          n += s.storage.get(key)?.length ?? 0;
        }
      }

      return n;
    }

    static get defaultObjectEncoding(): number {
      return defaultEncoding;
    }

    static set defaultObjectEncoding(v: Value) {
      defaultEncoding = s.rt.toUint(v) === 0 ? 0 : 3;
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

  // Flash wrote each open object as its SWF went: a destroyed player
  // writes those a script changed since they were read or written. Never
  // a removal: an object whose stored file it could not read starts empty,
  // and an unchanged one would take the file away.
  s.flushSharedObjects = () => {
    for (const o of open.values()) {
      try {
        const file = serialize(o);
        if (file.length && !sameBytes(file, o.$saved)) {
          s.storage.set(o.$key, file);
        }
      } catch {
        // One that cannot be written, AMF0's or a full quota's, keeps the others from nothing.
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

/** An AMF3 U29: 1 to 4 bytes, 7 bits each but the fourth's 8. */
function u29(n: number): Uint8Array {
  if (n < 0x80) {
    return Uint8Array.of(n);
  }
  if (n < 0x4000) {
    return Uint8Array.of((n >> 7) | 0x80, n & 0x7f);
  }
  if (n < 0x200000) {
    return Uint8Array.of((n >> 14) | 0x80, ((n >> 7) & 0x7f) | 0x80, n & 0x7f);
  }

  return Uint8Array.of(
    (n >> 22) | 0x80,
    ((n >> 15) & 0x7f) | 0x80,
    ((n >> 8) & 0x7f) | 0x80,
    n & 0xff,
  );
}

/** The U29 at `at`, and where what follows it starts. */
function readU29(bytes: Uint8Array, at: number): [number, number] {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const b = bytes[at++];
    n = (n << 7) | (b & 0x7f);
    if (!(b & 0x80)) {
      return [n, at];
    }
  }

  return [(n << 8) | bytes[at], at + 1];
}
