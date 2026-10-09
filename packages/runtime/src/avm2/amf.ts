// AMF3, as avmplus' AvmPlusObjectOutput and AvmPlusObjectInput write and
// read it for ByteArray's writeObject and readObject: the markers, 29-bit
// references, and the string, object and traits tables, fresh for each
// call. A number is an integer if it is one of avmplus' int atoms: whole,
// not -0, and within 29 bits (avmshell is a 32-bit build). Doubles and
// Vector elements are big-endian whatever the ByteArray's byte order: avmplus
// writes AMF through a wrapper of its own.
// Dates too, as a reference or their time, Dictionaries, by name or object
// key, XML, as a reference or its toXMLString, and an IExternalizable by
// its writeExternal and readExternal.
//
// Translated from avmplus' core/AvmSerializer.cpp, this file is subject to
// the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import { type Bytes, bytesOf, fromUtf8, utf8 } from "./builtin/flash/utils/ByteArray.js";
import { xmlToXMLString } from "./builtin/xml/xml.js";
import type { AsObject, Value } from "./descriptors.js";
import { NS_PackageInternal, NS_Public, namespace, publicNs, qname } from "./names.js";
import type { Runtime } from "./runtime.js";
import type { Traits } from "./traits.js";

const kUndefined = 0;
const kNull = 1;
const kFalse = 2;
const kTrue = 3;
const kInteger = 4;
const kDouble = 5;
const kString = 6;
const kXmlDocument = 7;
const kDate = 8;
const kArray = 9;
const kObject = 10;
const kXml = 11;
const kByteArray = 12;
const kVectorInt = 13;
const kVectorUint = 14;
const kVectorDouble = 15;
const kVectorObject = 16;
const kDictionary = 17;

const VECTOR_KINDS: Record<string, number> = {
  "__AS3__.vec::Vector$int": kVectorInt,
  "__AS3__.vec::Vector$uint": kVectorUint,
  "__AS3__.vec::Vector$double": kVectorDouble,
};

/** A class's AMF3 description: its alias, its sealed properties' names, whether it is dynamic, and externalizable. */
interface ClassInfo {
  name: string;
  sealed: string[];
  dynamic: boolean;
  externalizable: boolean;
}

/**
 * Where an IExternalizable's writeExternal writes or its readExternal
 * reads, as flash.utils' ObjectOutput and ObjectInput see the stream: its
 * ByteArray, and the byte order and encoding of their own, big-endian AMF3
 * until set, whatever the ByteArray's.
 */
export interface ExternalStream {
  readonly bytes: Bytes;
  littleEndian: boolean;
  objectEncoding: number;
}

// IExternalizable's traits, by runtime: each writeObject describes its
// classes afresh, and looking the interface up by name each time cost AMF3
// a tenth of its time. Whether a class implements it is asked each time,
// as an interface it names may link only later.
const externalizableTraits = new WeakMap<Runtime, Traits>();

function isExternalizable(rt: Runtime, traits: Traits): boolean {
  let iface = externalizableTraits.get(rt);
  if (iface === undefined) {
    iface = rt.classNamed("flash.utils::IExternalizable").$it as Traits;
    externalizableTraits.set(rt, iface);
  }

  return traits.isSubtypeOf(iface);
}

/** One of flash.utils' internal ObjectOutput or ObjectInput, over `stream`. */
function externalStream(rt: Runtime, name: string, stream: ExternalStream): AsObject {
  const cls = rt.resolveName(qname(namespace(NS_PackageInternal, "flash.utils"), name));
  const o = rt.constructClass(cls, []);
  o.$amf = stream;
  return o;
}

/** The traits a class's instances have, and their superclasses', for tests of what a value is. */
function isA(traits: Traits, name: string): boolean {
  for (let t: Traits | null = traits; t; t = t.base) {
    if (t.name === name) {
      return true;
    }
  }

  return false;
}

/** The kind of Vector a value is, or 0. */
function vectorKind(traits: Traits): number {
  for (let t: Traits | null = traits; t; t = t.base) {
    const kind = VECTOR_KINDS[t.name];
    if (kind) {
      return kind;
    }

    if (t.name === "__AS3__.vec::Vector$object") {
      return kVectorObject;
    }
  }

  return 0;
}

/**
 * As ClassInfo's constructor for output: the public variables (not
 * constants) and the public accessors with both a getter and a setter, of
 * the traits and then their bases', but [Transient] ones.
 */
function classInfoOf(rt: Runtime, traits: Traits): ClassInfo {
  // An IExternalizable writes itself, and is read back as its alias's class.
  if (isExternalizable(rt, traits)) {
    const name = rt.aliasOf(traits);
    if (name === "") {
      throw rt.error("ArgumentError", 2004);
    }

    return { name, sealed: [], dynamic: traits.dynamic, externalizable: true };
  }

  const sealed: string[] = [];
  for (let t: Traits | null = traits; t; t = t.base) {
    for (const [name, list] of t.bindings) {
      for (const b of list) {
        const kind = b.value & 7;
        const isPublic = b.ns.kind === NS_Public && b.ns.uri === "";
        if (isPublic && (kind === 2 || kind === 7) && !traits.isTransient(b.value)) {
          sealed.push(name);
        }
      }
    }
  }

  return { name: rt.aliasOf(traits), sealed, dynamic: traits.dynamic, externalizable: false };
}

/** An AMF3 writer over a ByteArray, for one writeObject. */
export class Writer implements ExternalStream {
  private readonly strings = new Map<string, number>();
  private readonly objects = new Map<object, number>();
  private readonly traits = new Map<Traits, [number, ClassInfo]>();
  littleEndian = false;
  objectEncoding = 3;

  constructor(
    private readonly rt: Runtime,
    private readonly out: Bytes,
  ) {}

  get bytes(): Bytes {
    return this.out;
  }

  private u8(v: number): void {
    const at = this.out.shortWrite(1);
    this.out.buffer[at] = v;
  }

  /** As WriteUint29: 1 to 4 bytes; 2^29 and above a RangeError. */
  private uint29(ref: number): void {
    if (ref < 0x80) {
      this.u8(ref);
    } else if (ref < 0x4000) {
      this.u8(((ref >> 7) & 0x7f) | 0x80);
      this.u8(ref & 0x7f);
    } else if (ref < 0x200000) {
      this.u8(((ref >> 14) & 0x7f) | 0x80);
      this.u8(((ref >> 7) & 0x7f) | 0x80);
      this.u8(ref & 0x7f);
    } else if (ref < 0x40000000) {
      this.u8(((ref >> 22) & 0x7f) | 0x80);
      this.u8(((ref >> 15) & 0x7f) | 0x80);
      this.u8(((ref >> 8) & 0x7f) | 0x80);
      this.u8(ref & 0xff);
    } else {
      throw this.rt.error("RangeError", 2006);
    }
  }

  private double(v: number): void {
    const at = this.out.shortWrite(8);
    this.out.view.setFloat64(at, v, false);
  }

  /** As WriteString: the empty string as 1, else a reference to it or its UTF-8. */
  string(s: string): void {
    if (s.length === 0) {
      this.uint29(1);
      return;
    }

    const ref = this.strings.get(s);
    if (ref !== undefined) {
      this.uint29(ref << 1);
      return;
    }

    this.strings.set(s, this.strings.size);
    const bytes = utf8(s);
    this.uint29((bytes.length << 1) | 1);
    this.out.write(bytes);
  }

  /** A reference to an object already written, or false, adding it to the table. */
  private reference(o: object): boolean {
    const ref = this.objects.get(o);
    if (ref !== undefined) {
      this.uint29(ref << 1);
      return true;
    }

    this.objects.set(o, this.objects.size);
    return false;
  }

  /** As WriteAtom. */
  value(v: Value): void {
    const rt = this.rt;
    switch (typeof v) {
      case "undefined":
        this.u8(kUndefined);
        return;
      case "boolean":
        this.u8(v ? kTrue : kFalse);
        return;
      case "number":
        if (Number.isInteger(v) && !Object.is(v, -0) && v >= -0x10000000 && v < 0x10000000) {
          this.u8(kInteger);
          this.uint29(v & 0x1fffffff);
        } else {
          this.u8(kDouble);
          this.double(v);
        }
        return;
      case "string":
        this.u8(kString);
        this.string(v);
        return;
      default:
        break;
    }

    if (v === null) {
      this.u8(kNull);
      return;
    }

    // Functions are not serialized.
    if (v.$f) {
      this.u8(kUndefined);
      return;
    }

    const traits: Traits = rt.traitsOf(v);
    if (isA(traits, "Date")) {
      // As WriteDate: in the objects' table; new, an odd reference, 1, then its time.
      this.u8(kDate);
      if (!this.reference(v)) {
        this.uint29(1);
        this.double(v.$time ?? Number.NaN);
      }
    } else if (isA(traits, "Array")) {
      this.u8(kArray);
      this.array(v);
    } else if (isA(traits, "flash.utils::ByteArray")) {
      this.u8(kByteArray);
      if (!this.reference(v)) {
        const b = bytesOf(rt, v);
        this.uint29((b.length << 1) | 1);
        this.out.write(b.buffer.slice(0, b.length));
      }
    } else if (vectorKind(traits)) {
      this.vector(v, vectorKind(traits));
    } else if (isA(traits, "flash.utils::Dictionary")) {
      this.dictionary(v);
    } else if (isA(traits, "XML")) {
      // As WriteXML: toXMLString, as toString leaves out a simple element's tags.
      this.u8(kXml);
      if (!this.reference(v)) {
        const bytes = utf8(xmlToXMLString(rt, v.$node));
        this.uint29((bytes.length << 1) | 1);
        this.out.write(bytes);
      }
    } else {
      this.u8(kObject);
      this.object(v, traits);
    }
  }

  /**
   * As WriteDictionary: a reference, or how many entries, whether its keys
   * are weak, then each key and value. A name is a string, as avmplus writes
   * the integer names its table holds, and an object key the object.
   */
  private dictionary(d: AsObject): void {
    this.u8(kDictionary);
    if (this.reference(d)) {
      return;
    }

    const rt = this.rt;
    const names = rt.enumerableNames(d);
    const keys: Map<object, Value> = d.$keys ?? new Map();
    this.uint29(((names.length + keys.size) << 1) | 1);
    this.u8(d.$weakKeys ? 1 : 0);
    for (const name of names) {
      this.value(name);
      this.value(rt.getProperty(d, qname(publicNs, name)));
    }

    for (const [key, value] of keys) {
      this.value(key);
      this.value(value);
    }
  }

  /** As WriteArray: the dense part up to the first hole or function, then the rest by name. */
  private array(a: AsObject): void {
    if (this.reference(a)) {
      return;
    }

    const rt = this.rt;
    const elements: Value[] = a.$a;
    let dense = elements.length;
    for (let i = 0; i < elements.length; i++) {
      if (!(i in elements)) {
        dense = i;
        break;
      }
    }

    for (let i = 0; i < dense; i++) {
      if (elements[i]?.$f) {
        dense = i;
        break;
      }
    }

    this.uint29((dense << 1) | 1);
    for (const name of rt.enumerableNames(a)) {
      const index = Number(name);
      if (Number.isInteger(index) && index >= 0 && index < dense && String(index) === name) {
        continue;
      }

      const value = rt.getProperty(a, qname(publicNs, name));
      if (value?.$f) {
        continue;
      }

      this.string(name);
      this.value(value);
    }

    this.string("");
    for (let i = 0; i < dense; i++) {
      this.value(elements[i]);
    }
  }

  /** As WriteTypedVector. */
  private vector(v: AsObject, kind: number): void {
    this.u8(kind);
    if (this.reference(v)) {
      return;
    }

    const elements: Value[] = v.$a;
    this.uint29((elements.length << 1) | 1);
    this.u8(v.$fixed ? 1 : 0);
    // A numeric Vector's elements in bytes reserved at once, which may move
    // the buffer: its view is read after.
    if (kind === kVectorDouble) {
      const at = this.out.shortWrite(elements.length * 8);
      const view = this.out.view;
      for (let i = 0; i < elements.length; i++) {
        view.setFloat64(at + i * 8, elements[i], false);
      }
    } else if (kind === kVectorInt || kind === kVectorUint) {
      const at = this.out.shortWrite(elements.length * 4);
      const view = this.out.view;
      for (let i = 0; i < elements.length; i++) {
        view.setUint32(at + i * 4, elements[i] >>> 0);
      }
    } else {
      const param = v.$traits.cls.$param;
      this.string(param ? this.rt.aliasOf(this.rt.classOf(param).$it) : "*");
      for (const e of elements) {
        this.value(e);
      }
    }
  }

  /** As WriteScriptObject: its class, by reference or described, then its sealed and dynamic properties. */
  private object(o: AsObject, traits: Traits): void {
    if (this.reference(o)) {
      return;
    }

    let known = this.traits.get(traits);
    if (known) {
      this.uint29((known[0] << 2) | 1);
    } else {
      const info = classInfoOf(this.rt, traits);
      known = [this.traits.size, info];
      this.traits.set(traits, known);
      const flags = (info.externalizable ? 4 : 0) | (info.dynamic ? 8 : 0);
      this.uint29(3 | flags | (info.sealed.length << 4));
      this.string(info.name);
      for (const name of info.sealed) {
        this.string(name);
      }
    }

    const info = known[1];
    if (info.externalizable) {
      const write = this.rt.getProperty(o, qname(publicNs, "writeExternal"));
      if (write?.$f) {
        this.rt.callValue(write, o, [externalStream(this.rt, "ObjectOutput", this)], null);
      }

      return;
    }

    for (const name of info.sealed) {
      this.value(this.rt.getProperty(o, qname(publicNs, name)));
    }

    if (info.dynamic) {
      const writer = this.rt.dynamicPropertyWriter;
      if (writer) {
        this.dynamicProperties(writer, o);
      } else {
        for (const name of this.rt.enumerableNames(o)) {
          const value = this.rt.getProperty(o, qname(publicNs, name));
          if (value?.$f || name.length === 0) {
            continue;
          }

          this.string(name);
          this.value(value);
        }
      }

      this.string("");
    }
  }

  /**
   * As ObjectEncoding.dynamicPropertyWriter has it: its
   * writeDynamicProperties called with the object and a
   * DynamicPropertyOutput that writes here, if it is an object.
   */
  private dynamicProperties(writer: AsObject, o: AsObject): void {
    const rt = this.rt;
    const f = rt.getProperty(writer, qname(publicNs, "writeDynamicProperties"));
    if (f === null || typeof f !== "object") {
      return;
    }

    const cls = rt.resolveName(
      qname(namespace(NS_PackageInternal, "flash.net"), "DynamicPropertyOutput"),
    );
    const output = rt.constructClass(cls, []);
    output.$amf = this;
    rt.callValue(f, writer, [o, output], null);
  }

  /** As WriteDynamicProperty: a name and its value, whatever they are. */
  dynamicProperty(name: string, value: Value): void {
    this.string(name);
    this.value(value);
  }
}

/** An AMF3 reader over a ByteArray, for one readObject. */
export class Reader implements ExternalStream {
  private readonly strings: string[] = [];
  private readonly objects: AsObject[] = [];
  private readonly classes: [ClassInfo, AsObject][] = [];
  littleEndian = false;
  objectEncoding = 3;

  constructor(
    private readonly rt: Runtime,
    private readonly input: Bytes,
  ) {}

  get bytes(): Bytes {
    return this.input;
  }

  private u8(): number {
    const at = this.input.shortRead(1);
    return this.input.buffer[at];
  }

  /** As ReadUint29. */
  private uint29(): number {
    let byte = this.u8();
    if (byte < 128) {
      return byte;
    }

    let ref = (byte & 0x7f) << 7;
    byte = this.u8();
    if (byte < 128) {
      return ref | byte;
    }

    ref = (ref | (byte & 0x7f)) << 7;
    byte = this.u8();
    if (byte < 128) {
      return ref | byte;
    }

    ref = (ref | (byte & 0x7f)) << 8;
    return (ref | this.u8()) >>> 0;
  }

  private double(): number {
    const at = this.input.shortRead(8);
    return this.input.view.getFloat64(at);
  }

  private u32(): number {
    const at = this.input.shortRead(4);
    return this.input.view.getUint32(at);
  }

  private find<T>(list: T[], i: number): T {
    if (i >= list.length) {
      throw this.rt.error("RangeError", 2006);
    }

    return list[i];
  }

  /** As ReadString. */
  string(): string {
    const ref = this.uint29();
    if ((ref & 1) === 0) {
      return this.find(this.strings, ref >>> 1);
    }

    const length = ref >>> 1;
    if (length === 0) {
      return "";
    }

    // A short ASCII string straight from the input, a character at a time;
    // any other through fromUtf8.
    const input = this.input;
    const at = input.position;
    if (length < 16 && input.available >= length) {
      const b = input.buffer;
      let ascii = "";
      let k = 0;
      for (; k < length && b[at + k] < 0x80; k++) {
        ascii += String.fromCharCode(b[at + k]);
      }

      if (k === length) {
        input.position = (at + length) >>> 0;
        this.strings.push(ascii);
        return ascii;
      }
    }

    const s = fromUtf8(input.readView(length));
    this.strings.push(s);
    return s;
  }

  /**
   * As ObjectInput::SetObjectProperty: a property that cannot be set, as on
   * a sealed class, is skipped, the error written to the console.
   */
  private set(o: AsObject, name: string, value: Value): void {
    try {
      this.rt.setProperty(o, qname(publicNs, name), value);
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }

      this.rt.print(this.rt.toString(e));
    }
  }

  /** As ReadAtom. */
  /** As ReadDictionary: a reference, or its entries, each key a string or an object; anything else is 2004. */
  private dictionary(): AsObject {
    const rt = this.rt;
    const ref = this.uint29();
    if ((ref & 1) === 0) {
      return this.find(this.objects, ref >>> 1);
    }

    const length = ref >>> 1;
    const weakKeys = this.u8() !== 0;
    const d = rt.constructClass(rt.dictionaryClass(), [weakKeys]);
    this.objects.push(d);
    for (let i = 0; i < length; i++) {
      const key = this.value();
      const value = this.value();
      if (typeof key === "string") {
        rt.setProperty(d, qname(publicNs, key), value);
      } else if (typeof key === "object" && key !== null) {
        d.$keys.set(key, value);
      } else {
        throw rt.error("ArgumentError", 2004);
      }
    }

    return d;
  }

  value(): Value {
    const rt = this.rt;
    const type = this.u8();
    switch (type) {
      case kUndefined:
        return undefined;
      case kNull:
        return null;
      case kFalse:
        return false;
      case kTrue:
        return true;
      case kInteger:
        return (this.uint29() << 3) >> 3;
      case kDouble:
        return this.double();
      case kString:
        return this.string();
      case kDictionary:
        return this.dictionary();
      case kDate: {
        // As ReadDate: a reference, or a new Date of the time that follows.
        const ref = this.uint29();
        if ((ref & 1) === 0) {
          return this.find(this.objects, ref >>> 1);
        }

        const date = rt.constructClass(rt.builtinClass("Date"), []);
        date.$time = this.double();
        this.objects.push(date);
        return date;
      }
      case kArray:
        return this.array();
      case kObject:
        return this.object();
      case kByteArray: {
        const ref = this.uint29();
        if ((ref & 1) === 0) {
          return this.find(this.objects, ref >>> 1);
        }

        const o = rt.constructClass(rt.byteArrayClass(), []);
        this.objects.push(o);
        const length = ref >>> 1;
        const b = bytesOf(rt, o);
        b.setLength(length);
        b.buffer.set(this.input.readView(length));
        return o;
      }
      case kVectorInt:
      case kVectorUint:
      case kVectorDouble:
      case kVectorObject:
        return this.vector(type);
      case kXmlDocument:
      case kXml: {
        // As ReadXML: an XMLDocument's too is read as XML, made from its text.
        const ref = this.uint29();
        if ((ref & 1) === 0) {
          return this.find(this.objects, ref >>> 1);
        }

        const text = fromUtf8(this.input.readView(ref >>> 1));
        const xml = rt.constructClass(rt.builtinClass("XML"), [text]);
        this.objects.push(xml);
        return xml;
      }
      default:
        throw rt.error("RangeError", 2006);
    }
  }

  /** As ReadArray: the named part first, then the dense one. */
  private array(): AsObject {
    const rt = this.rt;
    const ref = this.uint29();
    if ((ref & 1) === 0) {
      return this.find(this.objects, ref >>> 1);
    }

    const length = ref >>> 1;
    const a = rt.array(new Array(length));
    this.objects.push(a);
    for (;;) {
      const name = this.string();
      if (name.length === 0) {
        break;
      }

      this.set(a, name, this.value());
    }

    for (let i = 0; i < length; i++) {
      a.$a[i] = this.value();
    }

    return a;
  }

  /** As ReadTypedVector. */
  private vector(type: number): AsObject {
    const rt = this.rt;
    const ref = this.uint29();
    if ((ref & 1) === 0) {
      return this.find(this.objects, ref >>> 1);
    }

    const length = ref >>> 1;
    const fixed = this.u8() !== 0;
    let cls: AsObject;
    if (type === kVectorObject) {
      const name = this.string();
      // As getClassClosureFromAlias: a class with no alias, as String, reads as Object.
      const param = name === "*" ? null : rt.classByAlias(name, true);
      cls = rt.vectorClass(param);
    } else {
      cls = rt.vectorClass(
        rt.builtinClass(type === kVectorInt ? "int" : type === kVectorUint ? "uint" : "Number"),
      );
    }

    const v = rt.constructClass(cls, [length]);
    this.objects.push(v);
    // A numeric Vector's elements, when all are there, at once: into its
    // storage, each as its type reads it. Else each on its own, to fail
    // where avmplus does; an empty one reads none, even at the end, where
    // shortRead would fail even for no bytes.
    const size = type === kVectorDouble ? 8 : 4;
    if (type !== kVectorObject && length > 0 && this.input.available >= length * size) {
      const at = this.input.shortRead(length * size);
      const view = this.input.view;
      const elements: number[] = v.$a;
      for (let i = 0; i < length; i++) {
        elements[i] =
          type === kVectorDouble
            ? view.getFloat64(at + i * 8)
            : type === kVectorInt
              ? view.getInt32(at + i * 4)
              : view.getUint32(at + i * 4);
      }

      v.$fixed = fixed;
      return v;
    }

    // Each element through the Vector's own setter, which converts it to
    // its type, as setProperty would reach it for an index.
    const setIndex = v.$traits.setIndex as NonNullable<Traits["setIndex"]>;
    for (let i = 0; i < length; i++) {
      const value =
        type === kVectorDouble ? this.double() : type === kVectorObject ? this.value() : this.u32();
      setIndex(v, i, value, rt);
    }

    v.$fixed = fixed;
    return v;
  }

  /** As ReadScriptObject: its class, by reference or described, an instance of it, then its properties. */
  private object(): AsObject {
    const rt = this.rt;
    const ref = this.uint29();
    if ((ref & 1) === 0) {
      return this.find(this.objects, ref >>> 1);
    }

    let entry: [ClassInfo, AsObject];
    if ((ref & 3) === 1) {
      entry = this.find(this.classes, ref >>> 2);
    } else {
      const externalizable = (ref & 4) !== 0;
      const dynamic = (ref & 8) !== 0;
      const count = ref >>> 4;
      const name = this.string();
      const sealed: string[] = [];
      for (let i = 0; i < count; i++) {
        sealed.push(this.string());
      }

      // An unknown alias reads as an Object, which cannot read itself.
      const cls = rt.classByAlias(name, true);
      if (externalizable && !isExternalizable(rt, cls.$it)) {
        throw rt.error("ArgumentError", 2173, name);
      }

      entry = [{ name, sealed, dynamic, externalizable }, cls];
      this.classes.push(entry);
    }

    const [info, cls] = entry;
    const o = rt.constructClass(cls, []);
    this.objects.push(o);
    if (info.externalizable) {
      const read = rt.getProperty(o, qname(publicNs, "readExternal"));
      if (read?.$f) {
        rt.callValue(read, o, [externalStream(rt, "ObjectInput", this)], null);
      }

      return o;
    }
    for (const name of info.sealed) {
      this.set(o, name, this.value());
    }

    if (info.dynamic) {
      for (;;) {
        const name = this.string();
        if (name.length === 0) {
          break;
        }

        this.set(o, name, this.value());
      }
    }

    return o;
  }
}

/** As Toplevel::writeObject: AMF3 only, as avmshell has no AMF0. */
export function writeObject(rt: Runtime, b: Bytes, v: Value): void {
  if (b.objectEncoding < 3) {
    throw rt.error("ArgumentError", 1508, "objectEncoding");
  }

  new Writer(rt, b).value(v);
}

/** As Toplevel::readObject. */
export function readObject(rt: Runtime, b: Bytes): Value {
  if (b.objectEncoding < 3) {
    throw rt.error("ArgumentError", 1508, "objectEncoding");
  }

  return new Reader(rt, b).value();
}
