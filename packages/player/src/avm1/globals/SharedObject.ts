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

/** What a name may not hold: getLocal then gives null (Ruffle's INVALID_CHARS). */
const BAD_NAME = /[~%&\\;:"',<>?#\s]/;

// AMF0's markers.
const NUMBER = 0x00;
const BOOLEAN = 0x01;
const STRING = 0x02;
const OBJECT = 0x03;
const NULL = 0x05;
const UNDEFINED = 0x06;
const REFERENCE = 0x07;
const ECMA_ARRAY = 0x08;
const OBJECT_END = 0x09;
const STRICT_ARRAY = 0x0a;
const DATE = 0x0b;
const LONG_STRING = 0x0c;
const XML = 0x0f;
const TYPED_OBJECT = 0x10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AMF0 written into chunks, joined once: a long save would overflow a spread. */
class Writer {
  readonly chunks: Uint8Array[] = [];
  private length = 0;
  /**
   * The objects and arrays written, by their place: a second sight of one
   * is a reference. Flash counts the data object as the first (adl).
   */
  private readonly references = new Map<Obj, number>();
  private nextReference = 1;

  constructor(
    private readonly host: SharedObjectHost,
    private readonly version: number,
  ) {}

  get size(): number {
    return this.length;
  }

  bytes(...b: number[]): void {
    this.push(Uint8Array.from(b));
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  u16(n: number): void {
    this.bytes((n >> 8) & 0xff, n & 0xff);
  }

  u32(n: number): void {
    this.bytes((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  /**
   * A number as Flash writes it (adl's .sol): NaN as 7FFF FFFF FFFF FFFF,
   * and -0 as 0, as its AVM1 keeps a whole number as an integer.
   */
  double(n: number): void {
    const b = new Uint8Array(8);
    if (Number.isNaN(n)) {
      b.set([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    } else {
      new DataView(b.buffer).setFloat64(0, n === 0 ? 0 : n);
    }

    this.push(b);
  }

  /** A name, a u16-long UTF-8 string without a marker. */
  name(text: string): void {
    const b = encoder.encode(text);
    this.u16(b.length);
    this.push(b);
  }

  string(text: string): void {
    const b = encoder.encode(text);
    if (b.length > 0xffff) {
      this.bytes(LONG_STRING);
      this.u32(b.length);
    } else {
      this.bytes(STRING);
      this.u16(b.length);
    }

    this.push(b);
  }

  value(v: Value): void {
    if (v === undefined) {
      this.bytes(UNDEFINED);
    } else if (v === null) {
      this.bytes(NULL);
    } else if (typeof v === "boolean") {
      this.bytes(BOOLEAN, v ? 1 : 0);
    } else if (typeof v === "number") {
      this.bytes(NUMBER);
      this.double(v);
    } else if (typeof v === "string") {
      this.string(v);
    } else if (v instanceof avm1.Avm1Object) {
      this.object(v);
    } else {
      this.bytes(UNDEFINED);
    }
  }

  private object(o: Obj): void {
    // A clip is no data: Flash writes undefined for it.
    if (o.display !== null) {
      this.bytes(UNDEFINED);
      return;
    }

    // A date's time and its zone's offset as getTimezoneOffset gives it, minutes behind UTC, as
    // Flash writes it (adl: -120 at UTC+2), which reading ignores.
    if (o.primitive instanceof avm1.DateCell) {
      const time = o.primitive.time;
      this.bytes(DATE);
      this.double(time);
      const offset = Number.isFinite(time) ? new Date(time).getTimezoneOffset() : 0;
      this.u16(offset & 0xffff);
      return;
    }

    const seen = this.references.get(o);
    if (seen !== undefined) {
      this.bytes(REFERENCE);
      this.u16(seen);
      return;
    }

    this.references.set(o, this.nextReference++);
    if (o.array) {
      this.bytes(ECMA_ARRAY);
      this.u32(avm1.toNumber(avm1.get(o, "length", this.version), this.version) >>> 0);
    } else {
      const typed = this.host.registeredName(constructorOf(o, this.version));
      if (typed !== null) {
        this.bytes(TYPED_OBJECT);
        this.name(typed);
      } else {
        this.bytes(OBJECT);
      }
    }

    this.properties(o);
    this.bytes(0, 0, OBJECT_END);
  }

  /**
   * `o`'s properties as for..in lists them, reversed, as Flash writes them:
   * a function left out, a getter's never called, written undefined.
   */
  properties(o: Obj): void {
    for (const key of avm1.keys(o, this.version).reverse()) {
      const own = o.own(key, this.version);
      if (own?.get) {
        this.name(key);
        this.bytes(UNDEFINED);
        continue;
      }

      const v = avm1.get(o, key, this.version);
      if (v instanceof avm1.Avm1Function) {
        continue;
      }

      this.name(key);
      this.value(v);
    }
  }
}

/** The constructor AMF0 types an object by: an own `constructor`, else `__constructor__`. */
function constructorOf(o: Obj, version: number): Value {
  const own = o.own("constructor", version);
  if (own) {
    return own.get ? undefined : own.value;
  }

  return avm1.get(o, "__constructor__", version);
}

/** AMF0 read back into AVM1 values; a marker it does not know ends the file there. */
class Reader {
  at = 0;
  private readonly view: DataView;
  /** As the writer's: the data object is the first, which no value refers to. */
  private readonly references: Value[] = [undefined];

  constructor(
    private readonly bytes: Uint8Array,
    private readonly realm: avm1.Realm,
    private readonly version: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(): number {
    const n = this.view.getUint16(this.at);
    this.at += 2;
    return n;
  }

  u32(): number {
    const n = this.view.getUint32(this.at);
    this.at += 4;
    return n;
  }

  utf8(length: number): string {
    if (this.at + length > this.bytes.length) {
      throw new RangeError("past the end");
    }

    const text = decoder.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return text;
  }

  name(): string {
    return this.utf8(this.u16());
  }

  value(): Value {
    const marker = this.bytes[this.at++];
    switch (marker) {
      case NUMBER: {
        const n = this.view.getFloat64(this.at);
        this.at += 8;
        return n;
      }
      case BOOLEAN:
        return this.bytes[this.at++] !== 0;
      case STRING:
        return this.name();
      case LONG_STRING:
        return this.utf8(this.u32());
      case NULL:
        return null;
      case UNDEFINED:
        return undefined;
      case REFERENCE:
        return this.references[this.u16()];
      case OBJECT:
      case TYPED_OBJECT: {
        if (marker === TYPED_OBJECT) {
          this.name();
        }

        const o = this.realm.newObject(this.version);
        this.references.push(o);
        this.entries(o);
        return o;
      }
      case ECMA_ARRAY: {
        this.u32();
        const a = this.realm.newArray([], this.version);
        this.references.push(a);
        this.entries(a);
        return a;
      }
      case STRICT_ARRAY: {
        const a = this.realm.newArray([], this.version);
        this.references.push(a);
        const count = this.u32();
        for (let i = 0; i < count; i++) {
          avm1.set(a, String(i), this.value(), this.version);
        }

        return a;
      }
      case DATE: {
        const time = this.view.getFloat64(this.at);
        this.at += 10;
        const date = avm1.get(this.realm.global, "Date", this.version);
        return this.realm.construct(date, [time], this.version);
      }
      case XML:
        // XML is not AS2's yet: its text, kept, reads as nothing.
        this.utf8(this.u32());
        return undefined;
      default:
        throw new RangeError(`AMF0 marker ${marker}`);
    }
  }

  /** Name and value pairs up to an empty name and the end marker, set on `o`. */
  private entries(o: Obj): void {
    for (;;) {
      const key = this.name();
      if (key === "" && this.bytes[this.at] === OBJECT_END) {
        this.at++;
        return;
      }

      avm1.set(o, key, this.value(), this.version);
    }
  }
}

/** The .sol file of `data` under `name`: empty for no properties, as Flash writes none. */
function serialize(host: SharedObjectHost, name: string, data: Value, version: number): Uint8Array {
  if (!(data instanceof avm1.Avm1Object)) {
    return new Uint8Array(0);
  }

  const body = new Writer(host, version);
  // Each property a name, a value and a 0, the object's own references shared across them.
  const entry = new Writer(host, version);
  for (const key of avm1.keys(data, version).reverse()) {
    const own = data.own(key, version);
    const v = own?.get ? undefined : avm1.get(data, key, version);
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

  const title = encoder.encode(name);
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

  const reader = new Reader(bytes, realm, version);
  reader.at = 16;
  reader.name();
  // An AMF3 file, AS3's, is not AS2's to read.
  if (reader.u32() !== 0) {
    return null;
  }

  const data = realm.newObject(version);
  try {
    while (reader.at < bytes.length) {
      const key = reader.name();
      avm1.set(data, key, reader.value(), version);
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

    const file = serialize(host, entry.name, avm1.get(self, "data", v), v);
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
    return entry ? serialize(host, entry.name, avm1.get(self, "data", v), v).length : undefined;
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
