// AMF0 values crossing LocalConnection's VM boundary. The AS2 codec owns
// the byte format; this adapter creates and reads AS3 objects without
// retaining either VM's live arguments in a queued message.
import { avm2 } from "@swf2es/runtime";
import * as A from "../../../avm1/amf.js";
import { LOCAL_MESSAGE_LIMIT } from "../../../localconnection.js";

type Value = avm2.Value;
type Obj = avm2.AsObject;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * AS3 values as AMF0, through the AS2 codec's writer: LocalConnection's
 * arguments, and Flash Remoting's in AMF0. `limit` bounds strings and
 * arrays (LocalConnection's message size); `next` is the reference the
 * first object takes: 1 where the strict array of arguments is itself the
 * first, as LocalConnection numbers them, 0 for remoting's (adl).
 */
export class Amf0Writer {
  readonly out = new A.Writer(() => null, 8, null, null);
  private readonly references = new Map<Obj, number>();

  constructor(
    private readonly rt: avm2.Runtime,
    private readonly limit = LOCAL_MESSAGE_LIMIT,
    private next = 1,
    private readonly what = "LocalConnection",
  ) {}

  value(value: Value, depth = 0): void {
    const out = this.out;
    const rt = this.rt;
    if (depth >= A.MAX_DEPTH - 2) {
      out.bytes(A.UNDEFINED);
      return;
    }

    if (value instanceof avm2.FloatValue) {
      out.value(value.value);
      return;
    }

    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      out.value(value as number | string | boolean | null | undefined);
      return;
    }

    if (value.$display) {
      out.bytes(A.UNDEFINED);
      return;
    }

    const traits = rt.traitsOf(value);
    if ("$time" in value) {
      out.bytes(A.DATE);
      out.double(value.$time);
      out.u16(0);
      return;
    }

    if (traits.name === "XML" || traits.name === "flash.xml::XMLDocument") {
      const text = rt.toString(
        rt.callProperty(value, rt.publicName(traits.name === "XML" ? "toXMLString" : "toString")),
      );
      if (text.length > this.limit) {
        throw new RangeError(`${this.what} message too large`);
      }

      const bytes = encoder.encode(text);
      out.bytes(A.XML);
      out.u32(bytes.length);
      out.push(bytes);
      return;
    }

    const seen = this.references.get(value);
    if (seen !== undefined) {
      out.bytes(A.REFERENCE);
      out.u16(seen);
      return;
    }

    this.references.set(value, this.next++);
    if (value.$a) {
      const array = value.$a as Value[];
      const properties = value.$d;
      if (properties?.size) {
        out.bytes(A.ECMA_ARRAY);
        out.u32(array.length);
        for (const key of Object.keys(array)) {
          out.name(key);
          this.value(array[Number(key)], depth + 1);
        }
        for (const [key, field] of properties) {
          out.name(key);
          this.value(field, depth + 1);
        }

        out.bytes(0, 0, A.OBJECT_END);
        return;
      }

      if (array.length > this.limit) {
        throw new RangeError(`${this.what} message too large`);
      }

      out.bytes(A.STRICT_ARRAY);
      out.u32(array.length);
      for (let i = 0; i < array.length; i++) {
        this.value(array[i], depth + 1);
      }
      return;
    }

    const alias = rt.aliasOf(traits);
    out.bytes(alias === "" ? A.OBJECT : A.TYPED_OBJECT);
    if (alias !== "") {
      out.name(alias);
    }

    const names = new Set<string>();
    for (let t: typeof traits | null = traits; t !== null; t = t.base) {
      for (const [name, bindings] of t.bindings) {
        for (const binding of bindings) {
          if (
            binding.ns.kind === avm2.publicNs.kind &&
            binding.ns.uri === "" &&
            (binding.value & 7) === 2
          ) {
            names.add(name);
          }
        }
      }
    }
    for (const name of value.$d?.keys() ?? []) {
      names.add(name);
    }
    for (const name of names) {
      const field = rt.getProperty(value, rt.publicName(name));
      if (typeof field === "function" || (field && typeof field === "object" && field.$f)) {
        continue;
      }

      out.name(name);
      this.value(field, depth + 1);
    }
    out.bytes(0, 0, A.OBJECT_END);
  }
}

export function writeLocalValues(rt: avm2.Runtime, args: Value[]): Uint8Array {
  // The original AMF3 payload is already bounded; AMF0 can expand small integers.
  const w = new Amf0Writer(rt);
  w.out.bytes(A.STRICT_ARRAY);
  w.out.u32(args.length);
  for (const value of args) {
    w.value(value);
  }

  return w.out.finish();
}

/** AMF0's marker for an AMF3 value after it, which Flash Remoting writes and reads. */
export const AVMPLUS = 0x11;

/**
 * AMF0 read as AS3 values from `at`: LocalConnection's arguments, and
 * Flash Remoting's answers, whose AMF3 values after 0x11 (with `amf3`)
 * share one AMF3 reader's tables.
 */
export class Amf0Reader {
  at: number;
  private readonly view: DataView;
  private readonly references: Value[] = [];
  private amf3Reader: avm2.Amf3Reader | null = null;
  private amf3Bytes: avm2.Bytes | null = null;

  constructor(
    private readonly rt: avm2.Runtime,
    private readonly bytes: Uint8Array,
    at = 0,
    private readonly amf3 = false,
    private readonly what = "LocalConnection",
  ) {
    this.at = at;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private u16(): number {
    const n = this.view.getUint16(this.at);
    this.at += 2;
    return n;
  }

  private u32(): number {
    const n = this.view.getUint32(this.at);
    this.at += 4;
    return n;
  }

  private utf(length: number): string {
    if (length > this.bytes.length - this.at) {
      throw new RangeError(`${this.what} message ended early`);
    }
    const text = decoder.decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;

    return text;
  }

  name(): string {
    return this.utf(this.u16());
  }

  /** An AMF3 value at the reader's place, its tables those of the values before it. */
  private amf3Value(): Value {
    if (this.amf3Bytes === null) {
      this.amf3Bytes = new avm2.Bytes(this.rt, {});
      this.amf3Bytes.write(this.bytes);
      this.amf3Reader = new avm2.Amf3Reader(this.rt, this.amf3Bytes);
    }

    this.amf3Bytes.position = this.at;
    const value = (this.amf3Reader as avm2.Amf3Reader).value();
    this.at = this.amf3Bytes.position;
    return value;
  }

  value(depth = 0): Value {
    const rt = this.rt;
    const bytes = this.bytes;
    const view = this.view;
    if (depth >= A.MAX_DEPTH) {
      throw new RangeError(`${this.what} arguments nested too deeply`);
    }

    const marker = bytes[this.at++];
    switch (marker) {
      case A.NUMBER: {
        const n = view.getFloat64(this.at);
        this.at += 8;
        return n;
      }
      case A.BOOLEAN:
        return bytes[this.at++] !== 0;
      case A.STRING:
        return this.name();
      case A.LONG_STRING:
        return this.utf(this.u32());
      case A.NULL:
        return null;
      case A.UNDEFINED:
      case A.UNSUPPORTED:
        return undefined;
      case A.REFERENCE:
        return this.references[this.u16()];
      case A.DATE: {
        const time = view.getFloat64(this.at);
        this.at += 10;
        return rt.construct(rt.classNamed("Date"), time);
      }
      case A.XML:
        return rt.construct(rt.classNamed("flash.xml::XMLDocument"), this.utf(this.u32()));
      case A.STRICT_ARRAY: {
        const count = this.u32();
        if (count > bytes.length - this.at) {
          throw new RangeError(`${this.what} message ended early`);
        }
        const result = rt.newArray([]);
        this.references.push(result);
        for (let i = 0; i < count; i++) {
          result.$a.push(this.value(depth + 1));
        }

        return result;
      }
      case A.OBJECT:
      case A.TYPED_OBJECT:
      case A.ECMA_ARRAY: {
        let result: Obj;
        if (marker === A.TYPED_OBJECT) {
          result = rt.allocate(rt.classByAlias(this.name(), true)) ?? rt.newObject([]);
        } else {
          result = marker === A.ECMA_ARRAY ? rt.newArray([]) : rt.newObject([]);
        }
        const length = marker === A.ECMA_ARRAY ? this.u32() : 0;
        this.references.push(result);
        for (;;) {
          const key = this.name();
          if (key === "" && bytes[this.at] === A.OBJECT_END) {
            this.at++;
            break;
          }
          rt.setProperty(result, rt.publicName(key), this.value(depth + 1));
        }
        if (marker === A.ECMA_ARRAY && length > result.$a.length) {
          result.$a.length = length;
        }

        return result;
      }
      case AVMPLUS:
        if (this.amf3) {
          return this.amf3Value();
        }

        throw new RangeError(`Invalid ${this.what} AMF0 marker`);
      default:
        throw new RangeError(`Invalid ${this.what} AMF0 marker`);
    }
  }
}

export function readLocalValues(rt: avm2.Runtime, bytes: Uint8Array): Value[] {
  const result = new Amf0Reader(rt, bytes).value() as Obj;

  return result.$a as Value[];
}
