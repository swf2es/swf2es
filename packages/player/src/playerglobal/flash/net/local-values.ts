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

export function writeLocalValues(rt: avm2.Runtime, args: Value[]): Uint8Array {
  // The original AMF3 payload is already bounded; AMF0 can expand small integers.
  const out = new A.Writer(() => null, 8, null, null);
  const references = new Map<Obj, number>();
  let next = 1;
  const write = (value: Value, depth: number): void => {
    if (depth >= A.MAX_DEPTH - 2) {
      out.bytes(A.UNDEFINED);
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
      if (text.length > LOCAL_MESSAGE_LIMIT) {
        throw new RangeError("LocalConnection message too large");
      }

      const bytes = encoder.encode(text);
      out.bytes(A.XML);
      out.u32(bytes.length);
      out.push(bytes);
      return;
    }

    const seen = references.get(value);
    if (seen !== undefined) {
      out.bytes(A.REFERENCE);
      out.u16(seen);
      return;
    }

    references.set(value, next++);
    if (value.$a) {
      const array = value.$a as Value[];
      const properties = value.$d;
      if (properties?.size) {
        out.bytes(A.ECMA_ARRAY);
        out.u32(array.length);
        for (const key of Object.keys(array)) {
          out.name(key);
          write(array[Number(key)], depth + 1);
        }
        for (const [key, field] of properties) {
          out.name(key);
          write(field, depth + 1);
        }

        out.bytes(0, 0, A.OBJECT_END);
        return;
      }

      if (array.length > LOCAL_MESSAGE_LIMIT) {
        throw new RangeError("LocalConnection message too large");
      }

      out.bytes(A.STRICT_ARRAY);
      out.u32(array.length);
      for (let i = 0; i < array.length; i++) {
        write(array[i], depth + 1);
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
      write(field, depth + 1);
    }
    out.bytes(0, 0, A.OBJECT_END);
  };
  out.bytes(A.STRICT_ARRAY);
  out.u32(args.length);
  for (const value of args) {
    write(value, 0);
  }

  const bytes = new Uint8Array(out.size);
  let at = 0;
  for (const chunk of out.chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

export function readLocalValues(rt: avm2.Runtime, bytes: Uint8Array): Value[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const references: Value[] = [];
  let at = 0;
  const u16 = () => {
    const n = view.getUint16(at);
    at += 2;
    return n;
  };
  const u32 = () => {
    const n = view.getUint32(at);
    at += 4;
    return n;
  };
  const utf = (length: number) => {
    if (length > bytes.length - at) {
      throw new RangeError("LocalConnection message ended early");
    }
    const text = decoder.decode(bytes.subarray(at, at + length));
    at += length;

    return text;
  };
  const name = () => utf(u16());
  const read = (depth: number): Value => {
    if (depth >= A.MAX_DEPTH) {
      throw new RangeError("LocalConnection arguments nested too deeply");
    }

    const marker = bytes[at++];
    switch (marker) {
      case A.NUMBER: {
        const n = view.getFloat64(at);
        at += 8;
        return n;
      }
      case A.BOOLEAN:
        return bytes[at++] !== 0;
      case A.STRING:
        return name();
      case A.LONG_STRING:
        return utf(u32());
      case A.NULL:
        return null;
      case A.UNDEFINED:
      case A.UNSUPPORTED:
        return undefined;
      case A.REFERENCE:
        return references[u16()];
      case A.DATE: {
        const time = view.getFloat64(at);
        at += 10;
        return rt.construct(rt.classNamed("Date"), time);
      }
      case A.XML:
        return rt.construct(rt.classNamed("flash.xml::XMLDocument"), utf(u32()));
      case A.STRICT_ARRAY: {
        const count = u32();
        if (count > bytes.length - at) {
          throw new RangeError("LocalConnection message ended early");
        }
        const result = rt.newArray([]);
        references.push(result);
        for (let i = 0; i < count; i++) {
          result.$a.push(read(depth + 1));
        }

        return result;
      }
      case A.OBJECT:
      case A.TYPED_OBJECT:
      case A.ECMA_ARRAY: {
        let result: Obj;
        if (marker === A.TYPED_OBJECT) {
          result = rt.allocate(rt.classByAlias(name(), true)) ?? rt.newObject([]);
        } else {
          result = marker === A.ECMA_ARRAY ? rt.newArray([]) : rt.newObject([]);
        }
        const length = marker === A.ECMA_ARRAY ? u32() : 0;
        references.push(result);
        for (;;) {
          const key = name();
          if (key === "" && bytes[at] === A.OBJECT_END) {
            at++;
            break;
          }
          rt.setProperty(result, rt.publicName(key), read(depth + 1));
        }
        if (marker === A.ECMA_ARRAY && length > result.$a.length) {
          result.$a.length = length;
        }

        return result;
      }
      default:
        throw new RangeError("Invalid LocalConnection AMF0 marker");
    }
  };
  const result = read(0) as Obj;

  return result.$a as Value[];
}
