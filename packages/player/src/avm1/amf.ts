// AMF0 of AVM1's values, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/amf.rs has it: MIT OR Apache-2.0, Copyright (c) 2018-2022
// Ruffle LLC and Ruffle contributors. SharedObject's .sol files
// (globals/SharedObject.ts) and NetConnection's remoting packets
// (globals/NetConnection.ts) write and read their values with it.
import { avm1 } from "@swf2es/runtime";

type Value = avm1.Value;
type Obj = avm1.Avm1Object;

// AMF0's markers.
export const NUMBER = 0x00;
export const BOOLEAN = 0x01;
export const STRING = 0x02;
export const OBJECT = 0x03;
export const NULL = 0x05;
export const UNDEFINED = 0x06;
export const REFERENCE = 0x07;
export const ECMA_ARRAY = 0x08;
export const OBJECT_END = 0x09;
export const UNSUPPORTED = 0x0d;
export const STRICT_ARRAY = 0x0a;
export const DATE = 0x0b;
export const LONG_STRING = 0x0c;
export const XML = 0x0f;
export const TYPED_OBJECT = 0x10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The most values a remoting value writes: a length a script sets, or an
 * object shared down a tree of them (a = [b, b], b = [c, c]...) met each
 * time, would otherwise hang the page or run it out of memory. Arrays
 * and properties stop when it is spent; the reader refuses more values.
 */
export const MAX_VALUES = 1 << 20;

/** How deep values nest as they are written or read; past it, undefined, or a read fails. */
export const MAX_DEPTH = 1024;

/** A remoting packet's ways, where they part from a .sol file's (globals/NetConnection.ts). */
export interface RemotingWays {
  /** An XML node's text, which it is written as; null for anything else. */
  xmlText(o: Obj): string | null;
  /** The place the first object written takes among the references: 1 in a call, 0 in a header (adl). */
  readonly first: number;
}

/** AMF0 written into one growing buffer, so primitive values allocate no chunks. */
export class Writer {
  private buffer = new Uint8Array(64);
  private view = new DataView(this.buffer.buffer);
  private length = 0;
  /**
   * The objects and arrays written, by their place: a second sight of one
   * is a reference. Flash counts the data object as the first (adl).
   */
  private readonly references = new Map<Obj, number>();
  private nextReference: number;
  /** The values a remoting value may still write (MAX_VALUES). */
  private left = MAX_VALUES;
  private depth = 0;

  constructor(
    /** The name Object.registerClass gave a constructor, which an object of is written typed. */
    private readonly typedName: (constr: Value) => string | null,
    private readonly version: number,
    /**
     * A .sol file's data object, which Flash writes as unsupported wherever
     * it is inside itself (adl), and counts as the first reference; null
     * for none, the references counted from 1 still.
     */
    private readonly data: Obj | null,
    /**
     * A remoting packet's ways, where they part from a .sol file's: an XML
     * node as its text, a date's zone as 0, an array of indices alone as a
     * strict array (the corpus's netconnection_serialize_arrays), a getter
     * or an element that throws undefined, its values bounded.
     */
    private readonly remoting: RemotingWays | null = null,
    private readonly maxBytes = Infinity,
  ) {
    this.nextReference = remoting?.first ?? 1;
  }

  get size(): number {
    return this.length;
  }

  /** An owned snapshot: queued messages must not retain spare buffer capacity. */
  finish(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.length);
  }

  private reserve(size: number): number {
    if (size > this.maxBytes - this.length) {
      throw new RangeError("AMF0 message too large");
    }

    const at = this.length;
    const end = at + size;
    if (end > this.buffer.length) {
      const buffer = new Uint8Array(Math.min(this.maxBytes, Math.max(end, this.buffer.length * 2)));
      buffer.set(this.buffer.subarray(0, at));
      this.buffer = buffer;
      this.view = new DataView(buffer.buffer);
    }

    this.length = end;

    return at;
  }

  private byte(n: number): void {
    const at = this.reserve(1);
    this.buffer[at] = n;
  }

  bytes(...b: number[]): void {
    const at = this.reserve(b.length);
    this.buffer.set(b, at);
  }

  push(chunk: Uint8Array): void {
    const at = this.reserve(chunk.length);
    this.buffer.set(chunk, at);
  }

  u16(n: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, n);
  }

  u32(n: number): void {
    const at = this.reserve(4);
    this.view.setUint32(at, n);
  }

  /**
   * A number as Flash writes it (adl's .sol): NaN as 7FFF FFFF FFFF FFFF,
   * and -0 as 0, as its AVM1 keeps a whole number as an integer.
   */
  double(n: number): void {
    const at = this.reserve(8);
    if (Number.isNaN(n)) {
      this.view.setUint32(at, 0x7fffffff);
      this.view.setUint32(at + 4, 0xffffffff);
    } else {
      this.view.setFloat64(at, n === 0 ? 0 : n);
    }
  }

  /** A name, a u16-long UTF-8 string without a marker, cut to fit one. */
  name(text: string): void {
    if (Math.min(text.length, 0xffff) > this.maxBytes - this.length) {
      throw new RangeError("AMF0 message too large");
    }

    const b = encoder.encode(text).subarray(0, 0xffff);
    this.u16(b.length);
    this.push(b);
  }

  string(text: string): void {
    if (text.length > this.maxBytes - this.length) {
      throw new RangeError("AMF0 message too large");
    }

    const b = encoder.encode(text);
    if (b.length > 0xffff) {
      this.byte(LONG_STRING);
      this.u32(b.length);
    } else {
      this.byte(STRING);
      this.u16(b.length);
    }

    this.push(b);
  }

  value(v: Value): void {
    if (this.remoting !== null && this.left-- <= 0) {
      this.left = 0;
      this.byte(UNDEFINED);
    } else if (v === undefined) {
      this.byte(UNDEFINED);
    } else if (v === null) {
      this.byte(NULL);
    } else if (typeof v === "boolean") {
      this.bytes(BOOLEAN, v ? 1 : 0);
    } else if (typeof v === "number") {
      this.byte(NUMBER);
      this.double(v);
    } else if (typeof v === "string") {
      this.string(v);
    } else if (v instanceof avm1.Avm1Object) {
      this.object(v);
    } else {
      this.byte(UNDEFINED);
    }
  }

  /** A call's implicit argument array, already reserved as reference 0 by the caller. */
  arguments(values: Value[]): void {
    this.left--;
    this.depth++;
    try {
      this.array(values.length, (i) => values[i]);
    } finally {
      this.depth--;
    }
  }

  /** A property of `o` as remoting reads it: undefined where its getter throws (Ruffle). */
  private read(o: Obj, key: string): Value {
    if (this.remoting === null) {
      return avm1.get(o, key, this.version);
    }

    try {
      return avm1.get(o, key, this.version);
    } catch (error) {
      if (error instanceof avm1.Avm1Throw) {
        return undefined;
      }

      throw error;
    }
  }

  private object(o: Obj): void {
    // Leave room for the undefined leaf in the reader's depth budget.
    if (this.depth >= MAX_DEPTH - 1) {
      this.byte(UNDEFINED);
      return;
    }

    this.depth++;
    try {
      this.contents(o);
    } finally {
      this.depth--;
    }
  }

  private contents(o: Obj): void {
    // A clip is no data: Flash writes undefined for it.
    if (o.display !== null) {
      this.byte(UNDEFINED);
      return;
    }

    // A date's time and its zone's offset as getTimezoneOffset gives it, minutes behind UTC, as
    // Flash writes it (adl: -120 at UTC+2), which reading ignores.
    if (o.primitive instanceof avm1.DateCell) {
      const time = o.primitive.time;
      this.byte(DATE);
      this.double(time);
      const offset =
        this.remoting === null && Number.isFinite(time) ? new Date(time).getTimezoneOffset() : 0;
      this.u16(offset & 0xffff);
      return;
    }

    const xml = this.remoting?.xmlText(o) ?? null;
    if (xml !== null) {
      if (xml.length > this.maxBytes - this.length) {
        throw new RangeError("AMF0 message too large");
      }

      const b = encoder.encode(xml);
      this.byte(XML);
      this.u32(b.length);
      this.push(b);
      return;
    }

    if (o === this.data) {
      this.byte(UNSUPPORTED);
      return;
    }

    const seen = this.references.get(o);
    if (seen !== undefined) {
      this.byte(REFERENCE);
      this.u16(seen);
      return;
    }

    this.references.set(o, this.nextReference++);
    if (o.array && this.remoting !== null && this.dense(o)) {
      return;
    }

    if (o.array) {
      // Its length, as the int it is kept as.
      this.byte(ECMA_ARRAY);
      this.u32(avm1.toNumber(this.read(o, "length"), this.version) >>> 0);
    } else {
      const typed = this.typedName(constructorOf(o, this.version));
      if (typed !== null) {
        this.byte(TYPED_OBJECT);
        this.name(typed);
      } else {
        this.byte(OBJECT);
      }
    }

    this.properties(o);
    this.bytes(0, 0, OBJECT_END);
  }

  /**
   * An array of indices alone written as a strict array, its length grown
   * past the last index, the holes undefined; false, nothing written, for
   * one with a key that is no index.
   */
  private dense(o: Obj): boolean {
    const keys = avm1.keys(o, this.version);
    if (keys.some((key) => !/^\d+$/.test(key))) {
      return false;
    }

    let length = Math.max(0, avm1.toNumber(this.read(o, "length"), this.version) | 0);
    for (const key of keys) {
      length = Math.max(length, Number(key) + 1);
    }

    this.array(length, (i) => this.read(o, String(i)));
    return true;
  }

  /** An array's elements, shortened where nested values spend the remaining budget. */
  private array(length: number, read: (index: number) => Value): void {
    // No more than the values left to write, which also keeps it a u32.
    length = Math.min(length, this.left);
    this.byte(STRICT_ARRAY);

    // Nested values spend this budget too, so the final count is only known after writing them.
    const count = this.reserve(4);
    let written = 0;
    for (let i = 0; i < length && this.left > 0; i++) {
      this.value(read(i));
      written++;
    }

    this.view.setUint32(count, written);
  }

  /**
   * `o`'s properties as for..in lists them, reversed, as Flash writes them:
   * a function left out, a getter, own or inherited, never called but
   * written undefined (adl).
   */
  properties(o: Obj): void {
    for (const key of avm1.keys(o, this.version).reverse()) {
      if (this.remoting !== null && this.left === 0) {
        break;
      }

      if (avm1.find(o, key, this.version)?.get) {
        this.name(key);
        this.value(undefined);
        continue;
      }

      const v = this.read(o, key);
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

  // Its stored value: a getter is not called (Ruffle's get_stored_property).
  const found = avm1.find(o, "__constructor__", version);
  return found === undefined || found.get ? undefined : found.value;
}

/** AMF0 read back into AVM1 values; a marker it does not know ends the file there. */
export class Reader {
  at = 0;
  private readonly view: DataView;
  private readonly references: Value[];
  private depth = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly realm: avm1.Realm,
    private readonly version: number,
    /** As a .sol file's writer counts its data object first, which Flash never refers to. */
    data = false,
    /** Remoting's value limit; .sol reads use Infinity to match their uncapped writer. */
    private left = MAX_VALUES,
    private readonly xml: ((text: string) => Value) | null = null,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.references = data ? [undefined] : [];
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

  /** A value; past the count or depth budget, a RangeError, as for bytes past the end. */
  value(): Value {
    if (this.left-- <= 0) {
      throw new RangeError("AMF0 too many values");
    }

    if (this.depth >= MAX_DEPTH) {
      throw new RangeError("AMF0 nested too deep");
    }

    this.depth++;
    try {
      return this.marked();
    } finally {
      this.depth--;
    }
  }

  private marked(): Value {
    const marker = this.bytes[this.at++];
    switch (marker) {
      case NUMBER: {
        const n = this.view.getFloat64(this.at);
        this.at += 8;
        return n;
      }
      case BOOLEAN:
        if (this.at >= this.bytes.length) {
          throw new RangeError("past the end");
        }

        return this.bytes[this.at++] !== 0;
      case STRING:
        return this.name();
      case LONG_STRING:
        return this.utf8(this.u32());
      case NULL:
        return null;
      case UNDEFINED:
      case UNSUPPORTED:
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
        // Its length, which holes at its end leave longer than its entries (adl: new Array(5)).
        const length = this.u32();
        const a = this.realm.newArray([], this.version);
        this.references.push(a);
        this.entries(a);
        if (length > avm1.toNumber(avm1.get(a, "length", this.version), this.version)) {
          avm1.set(a, "length", length, this.version);
        }

        return a;
      }
      case STRICT_ARRAY: {
        const a = this.realm.newArray([], this.version);
        this.references.push(a);
        const count = this.u32();
        if (count > this.left) {
          throw new RangeError("AMF0 too many values");
        }

        for (let i = 0; i < count; i++) {
          put(a, String(i), this.value(), this.version);
        }

        const length = a.own("length", this.version);
        if (length) {
          length.value = count;
        }

        return a;
      }
      case DATE: {
        const time = this.view.getFloat64(this.at);
        this.at += 8;
        this.u16();
        // Flash's own Date, whatever a script set _global.Date to.
        return this.realm.construct(this.realm.Date.constr, [time], this.version);
      }
      case XML: {
        const text = this.utf8(this.u32());
        return this.xml?.(text);
      }
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

      put(o, key, this.value(), this.version);
    }
  }
}

/**
 * A property read back, defined as it is rather than set: no setter or
 * watcher a script added to a prototype runs, and no key makes itself the
 * object's prototype.
 */
export function put(o: Obj, key: string, value: Value, version: number): void {
  if (key.toLowerCase() === "__proto__" && (version <= 6 || key === "__proto__")) {
    return;
  }

  o.define(key, value, 0);
}
