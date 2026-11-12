// AMF0 of AS3's values, as Flash's ByteArray.writeObject and readObject
// have it for an objectEncoding below 3, and its SharedObjects' .sol files
// of AMF0. avmshell has none (Toplevel::writeObject refuses it with #1508),
// so this is the player's, after what adl writes and reads:
//
// - A number is always a double, an int's too, -0 kept; a string past
//   0xffff bytes a long string (0x0c).
// - An object, an Array, a Date, an XMLDocument or anything else not a
//   primitive takes the next place in one table of references, from 0 at
//   each writeObject (a .sol file's properties share theirs); a second
//   sight of it is 0x07 and its place, cut to 16 bits past 0xffff.
// - An Array is always an ECMA array (0x08): its length, then its elements
//   that exist and its other properties by name; a hole is left out, a
//   function too.
// - A Date is its time and its zone's offset from UTC, in minutes as
//   getTimezoneOffset gives it (0 for an invalid one).
// - An XMLDocument is its text (0x0f); an XML or XMLList an empty object.
// - Any other object is an anonymous (0x03) or, with an alias, typed object
//   (0x10): its public variables and accessors with both a getter and a
//   setter, [Transient] ones too, its own and its bases', then what for-in
//   finds on it (a Vector's indices, a Dictionary's keys as strings), each
//   name a u16 length (cut to 16 bits) and its UTF-8, then 00 00 09. An
//   IExternalizable writes no properties: writeExternal is not called, nor
//   readExternal when it is read. A ByteArray, a Vector, a Dictionary, a
//   class, a Sprite: all are objects so.
// - A function is undefined, and left out where it is a property.
//
// Reading, an unknown marker (0x04, 0x09, 0x0d, 0x0e, 0x11 and on) is
// undefined and takes its byte alone: AMF3 after 0x11 is not read. An XML
// document is read as an XMLDocument, a typed object as its alias's class
// or as an Object, a property it cannot set said on the console as AMF3's
// are. A reference past the table is RangeError #2006, an end too soon
// EOFError #2030.
import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../../as3/types.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;
type Traits = AsObject;

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
const XML_DOCUMENT = 0x0f;
const TYPED_OBJECT = 0x10;

const BIND_Var = 2;
const BIND_GetSet = 7;

/** Whether `traits` or one of its bases is the class `name`. */
function isA(traits: Traits, name: string): boolean {
  for (let t: Traits | null = traits; t; t = t.base) {
    if (t.name === name) {
      return true;
    }
  }

  return false;
}

/** Whether `v` is a function, which AMF0 leaves out. */
function isFunction(v: Value): boolean {
  return typeof v === "function" || (v !== null && typeof v === "object" && v.$f !== undefined);
}

/** An AMF0 writer over a ByteArray's bytes, its table of references its own. */
export class Writer {
  private readonly references = new Map<object, number>();

  constructor(
    private readonly rt: avm2.Runtime,
    private readonly out: avm2.Bytes,
  ) {}

  private u8(v: number): void {
    const at = this.out.shortWrite(1);
    this.out.buffer[at] = v;
  }

  private u16(v: number): void {
    const at = this.out.shortWrite(2);
    this.out.view.setUint16(at, v);
  }

  private u32(v: number): void {
    const at = this.out.shortWrite(4);
    this.out.view.setUint32(at, v);
  }

  private double(v: number): void {
    const at = this.out.shortWrite(8);
    this.out.view.setFloat64(at, v);
  }

  /**
   * A property's or an alias's name: its length as a u16, cut to 16 bits
   * as Flash cuts it, then all of its UTF-8, a long one's too.
   */
  name(s: string): void {
    const bytes = avm2.utf8(s);
    this.u16(bytes.length & 0xffff);
    this.out.write(bytes);
  }

  value(v: Value): void {
    if (v instanceof avm2.FloatValue) {
      v = v.value;
    }

    switch (typeof v) {
      case "undefined":
        this.u8(UNDEFINED);
        return;
      case "boolean":
        this.u8(BOOLEAN);
        this.u8(v ? 1 : 0);
        return;
      case "number":
        this.u8(NUMBER);
        this.double(v);
        return;
      case "string": {
        const bytes = avm2.utf8(v);
        if (bytes.length > 0xffff) {
          this.u8(LONG_STRING);
          this.u32(bytes.length);
        } else {
          this.u8(STRING);
          this.u16(bytes.length);
        }

        this.out.write(bytes);
        return;
      }
      default:
        break;
    }

    if (v === null) {
      this.u8(NULL);
      return;
    }

    if (isFunction(v)) {
      this.u8(UNDEFINED);
      return;
    }

    const known = this.references.get(v);
    if (known !== undefined) {
      this.u8(REFERENCE);
      this.u16(known & 0xffff);
      return;
    }

    this.references.set(v, this.references.size);
    const rt = this.rt;
    const traits: Traits = rt.traitsOf(v);
    if (isA(traits, "Array")) {
      this.array(v);
    } else if (isA(traits, "Date")) {
      const time: number = rt.prop(v as As3<"Date">, "time");
      const offset: number = rt.callProperty(v, rt.publicName("getTimezoneOffset"));
      this.u8(DATE);
      this.double(time);
      this.u16(Number.isFinite(offset) ? offset & 0xffff : 0);
    } else if (isA(traits, "flash.xml::XMLDocument")) {
      const bytes = avm2.utf8(rt.toString(v));
      this.u8(XML_DOCUMENT);
      this.u32(bytes.length);
      this.out.write(bytes);
    } else if (isA(traits, "XML") || isA(traits, "XMLList")) {
      this.u8(OBJECT);
      this.end();
    } else {
      this.object(v, traits);
    }
  }

  private end(): void {
    this.u16(0);
    this.u8(OBJECT_END);
  }

  /** A property, unless its value is a function. */
  private property(name: string, value: Value): void {
    if (isFunction(value)) {
      return;
    }

    this.name(name);
    this.value(value);
  }

  /** An ECMA array: the length, then what for-in finds, elements and the rest. */
  private array(a: AsObject): void {
    const rt = this.rt;
    this.u8(ECMA_ARRAY);
    this.u32(rt.prop(a as As3<"Array">, "length") >>> 0);
    for (const name of rt.enumerableNames(a)) {
      this.property(name, rt.getProperty(a, rt.publicName(name)));
    }

    this.end();
  }

  /** An object, typed if its class has an alias: its sealed properties, then its own. */
  private object(o: AsObject, traits: Traits): void {
    const rt = this.rt;
    const alias: string = rt.aliasOf(traits);
    if (alias === "") {
      this.u8(OBJECT);
    } else {
      this.u8(TYPED_OBJECT);
      this.name(alias);
    }

    if (externalizable(rt, traits)) {
      this.end();
      return;
    }

    for (const name of sealedNames(rt, traits)) {
      this.property(name, rt.getProperty(o, rt.publicName(name)));
    }

    for (const name of rt.enumerableNames(o)) {
      this.property(name, rt.getProperty(o, rt.publicName(name)));
    }

    // A Dictionary's object keys, by their strings.
    if (o.$keys) {
      for (const [key, value] of o.$keys as Map<object, Value>) {
        this.property(rt.toString(key), value);
      }
    }

    this.end();
  }
}

/** Whether a class implements IExternalizable, which AMF0 writes no properties of. */
function externalizable(rt: avm2.Runtime, traits: Traits): boolean {
  const iface = rt.classNamed("flash.utils::IExternalizable").$it as Traits;
  return traits.isSubtypeOf(iface);
}

/** The public variables and read-write accessors of a class and its bases, as AMF3's sealed ones but [Transient] ones too. */
function sealedNames(rt: avm2.Runtime, traits: Traits): string[] {
  const names: string[] = [];
  for (let t: Traits | null = traits; t; t = t.base) {
    for (const [name, list] of t.bindings as Map<
      string,
      { ns: { kind: number; uri: string }; version: number; value: number }[]
    >) {
      for (const b of list) {
        const kind = b.value & 7;
        if (
          b.ns.kind === avm2.publicNs.kind &&
          b.ns.uri === "" &&
          b.version <= rt.apiVersion &&
          (kind === BIND_Var || kind === BIND_GetSet)
        ) {
          names.push(name);
        }
      }
    }
  }

  return names;
}

/** An AMF0 reader over a ByteArray's bytes, from its position, its table of references its own. */
export class Reader {
  private readonly references: Value[] = [];

  constructor(
    private readonly rt: avm2.Runtime,
    private readonly input: avm2.Bytes,
  ) {}

  private u8(): number {
    return this.input.buffer[this.input.shortRead(1)];
  }

  private u16(): number {
    return this.input.view.getUint16(this.input.shortRead(2));
  }

  private u32(): number {
    return this.input.view.getUint32(this.input.shortRead(4));
  }

  private double(): number {
    return this.input.view.getFloat64(this.input.shortRead(8));
  }

  private utf8(length: number): string {
    return avm2.fromUtf8(this.input.readView(length));
  }

  /** A name: a u16 length and its UTF-8. */
  name(): string {
    return this.utf8(this.u16());
  }

  /**
   * As AMF3's: a property that cannot be set, as a read-only one or one a
   * sealed class lacks, is said on the console and skipped.
   */
  private set(o: AsObject, name: string, value: Value): void {
    try {
      this.rt.setProperty(o, this.rt.publicName(name), value);
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      }

      this.rt.print(this.rt.toString(e));
    }
  }

  /** Properties up to an empty name followed by the end marker; an empty name before anything else is a property. */
  private properties(o: AsObject): void {
    for (;;) {
      const name = this.name();
      if (name.length === 0) {
        const input = this.input;
        if (input.position < input.length && input.buffer[input.position] === OBJECT_END) {
          input.position = (input.position + 1) >>> 0;
          return;
        }
      }

      this.set(o, name, this.value());
    }
  }

  value(): Value {
    const rt = this.rt;
    const marker = this.u8();
    switch (marker) {
      case NUMBER:
        return this.double();
      case BOOLEAN:
        return this.u8() !== 0;
      case STRING:
        return this.name();
      case LONG_STRING:
        return this.utf8(this.u32());
      case NULL:
        return null;
      case REFERENCE: {
        const index = this.u16();
        if (index >= this.references.length) {
          throw rt.error("RangeError", 2006);
        }

        return this.references[index];
      }
      case OBJECT: {
        const o = rt.newObject([]);
        this.references.push(o);
        this.properties(o);
        return o;
      }
      case TYPED_OBJECT: {
        const cls = rt.classByAlias(this.name(), true);
        const o = rt.constructClass(cls, []);
        this.references.push(o);
        this.properties(o);
        return o;
      }
      case ECMA_ARRAY: {
        const a = rt.newArray([]);
        this.references.push(a);
        rt.setProp(a as As3<"Array">, "length", this.u32());
        this.properties(a);
        return a;
      }
      case STRICT_ARRAY: {
        const count = this.u32();
        const a = rt.newArray([]);
        this.references.push(a);
        // Each element as it comes, not the count at once: a count can be
        // anything, and the bytes end long before it.
        for (let i = 0; i < count; i++) {
          a.$a.push(this.value());
        }

        return a;
      }
      case DATE: {
        const time = this.double();
        // The zone, which the time does not need.
        this.u16();
        const date = rt.construct(rt.classNamed("Date"), time);
        this.references.push(date);
        return date;
      }
      case XML_DOCUMENT: {
        const text = this.utf8(this.u32());
        const doc = rt.construct(rt.classNamed("flash.xml::XMLDocument"), text);
        this.references.push(doc);
        return doc;
      }
      default:
        return undefined;
    }
  }
}
