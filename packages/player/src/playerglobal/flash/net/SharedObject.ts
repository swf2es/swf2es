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

/**
 * Where the host keeps shared objects' bytes, by key: the browser's
 * localStorage by default, else memory.
 */
export interface SharedObjectStorage {
  get(key: string): Uint8Array | null;
  set(key: string, bytes: Uint8Array): void;
  remove(key: string): void;
  keys(): string[];
}

/** The default storage: localStorage where the host has it, base64 under a prefix; memory otherwise. */
export function defaultStorage(): SharedObjectStorage {
  const local = (globalThis as { localStorage?: Storage }).localStorage;
  if (!local) {
    const memory = new Map<string, Uint8Array>();
    return {
      get: (key) => memory.get(key) ?? null,
      set: (key, bytes) => memory.set(key, bytes.slice()),
      remove: (key) => memory.delete(key),
      keys: () => [...memory.keys()],
    };
  }

  const PREFIX = "swf2es:so:";
  return {
    get: (key) => {
      const text = local.getItem(PREFIX + key);
      return text === null ? null : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    },
    set: (key, bytes) => {
      let text = "";
      for (const b of bytes) {
        text += String.fromCharCode(b);
      }

      local.setItem(PREFIX + key, btoa(text));
    },
    remove: (key) => local.removeItem(PREFIX + key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < local.length; i++) {
        const k = local.key(i);
        if (k?.startsWith(PREFIX)) {
          keys.push(k.slice(PREFIX.length));
        }
      }

      return keys;
    },
  };
}

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

  /**
   * The .sol file of `o`'s data, in its encoding; none, empty, for no
   * properties. AMF0 is the runtime's to write, which has none yet.
   */
  const serialize = (o: AsObject): Uint8Array => {
    if (o.$encoding !== 3) {
      throw s.rt.unsupported("an AMF0 SharedObject");
    }

    const entries: number[] = [];
    const amf3 = o.$encoding === 3;
    for (const [key, value] of o.$data.$d ?? new Map()) {
      const name = encoder.encode(String(key));
      if (amf3) {
        u29(entries, (name.length << 1) | 1);
      } else {
        entries.push(name.length >> 8, name.length & 0xff);
      }

      entries.push(...name);
      const array = byteArray(o.$encoding);
      s.rt.callProperty(array, avm2.qname(avm2.publicNs, "writeObject"), value);
      const b = avm2.bytesOf(s.rt, array);
      entries.push(...b.buffer.subarray(0, b.length), 0);
    }

    if (entries.length === 0) {
      return new Uint8Array(0);
    }

    const name = encoder.encode(o.$name);
    const body = [
      ...[0x54, 0x43, 0x53, 0x4f, 0, 4, 0, 0, 0, 0],
      name.length >> 8,
      name.length & 0xff,
      ...name,
      0,
      0,
      0,
      amf3 ? 3 : 0,
      ...entries,
    ];
    const n = body.length;
    return new Uint8Array([
      0x00,
      0xbf,
      n >>> 24,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
      ...body,
    ]);
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

    static getLocal(name: Value, localPath: Value, _secure: Value): Value {
      if (name === null || name === undefined) {
        throw s.rt.error("TypeError", 2007, "name");
      }

      const text = s.rt.toString(name);
      if (text === "" || BAD_NAME.test(text)) {
        throw s.rt.error("Error", 2134);
      }

      const url = new URL(s.url, "file:///");
      // By default the SWF's own path, file name and all, which is never a
      // directory's; one known by no file name is kept apart from its
      // directory's as well.
      const own = url.pathname.endsWith("/") ? `${url.pathname}[swf]` : url.pathname;
      const path = localPath === null || localPath === undefined ? own : s.rt.toString(localPath);
      const key = `${url.host}${path.startsWith("/") ? "" : "/"}${path}/${text}`;
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

    // Flush returns true, which flush reports as FLUSHED.
    "flash.net:SharedObject::invoke"(code: Value, ..._args: Value[]): Value {
      switch (s.rt.toUint(code)) {
        case FLUSH: {
          const file = serialize(this);
          if (file.length) {
            s.storage.set(this.$key, file);
          } else {
            s.storage.remove(this.$key);
          }

          return true;
        }
        case GET_SIZE:
          return serialize(this).length;
        case CLEAR:
          this.$data = s.rt.newObject([]);
          s.storage.remove(this.$key);
          return undefined;
        case CLOSE:
          return undefined;
        default:
          throw s.rt.unsupported("SharedObject's remote calls");
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.net::SharedObject", SharedObjectNatives);
  return natives;
}

/** An AMF3 U29: 1 to 4 bytes, 7 bits each but the fourth's 8. */
function u29(out: number[], n: number): void {
  if (n < 0x80) {
    out.push(n);
  } else if (n < 0x4000) {
    out.push((n >> 7) | 0x80, n & 0x7f);
  } else if (n < 0x200000) {
    out.push((n >> 14) | 0x80, ((n >> 7) & 0x7f) | 0x80, n & 0x7f);
  } else {
    out.push((n >> 22) | 0x80, ((n >> 15) & 0x7f) | 0x80, ((n >> 8) & 0x7f) | 0x80, n & 0xff);
  }
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
