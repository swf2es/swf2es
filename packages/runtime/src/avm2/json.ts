// JSON's natives, as avmplus' JSONParser and JSONSerializer: the parser's
// tokens and SyntaxError 1132, and stringify's toJSON (public only: see
// toJSONOf), replacers, gaps, numbers as the host writes them, and a
// class instance's public variables and readable accessors before its
// dynamic properties, leaving out [Transient] ones.
//
// Translated from avmplus' core/JSONClass.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import { NS_Public, publicNs, qname } from "./names.js";
import type { AsObject, Runtime, Traits, Value } from "./runtime.js";

type Natives = Record<string, (rt: Runtime) => (...args: Value[]) => Value>;

const TO_JSON = qname(publicNs, "toJSON");

/** Whether each traits binds a public toJSON, found once. */
const boundToJSON = new WeakMap<Traits, boolean>();

/**
 * As JSONParser, through the host's JSON.parse, then its values made AS3's
 * in place. The text the host rejects goes to parse(): avmplus reads some
 * of it (numbers with leading zeros, as 01), and fails the rest as
 * SyntaxError 1132.
 */
function parseText(rt: Runtime, text: string): Value {
  let tree: unknown;
  try {
    tree = JSON.parse(text);
  } catch {
    return parse(rt, text);
  }

  return fromHost(rt, tree);
}

/** How deep fromHost recurses before it continues with a stack of its own. */
const RECURSION_DEPTH = 500;

/**
 * A value of the host's JSON.parse as AS3's: an array as an Array holding
 * it, its elements made AS3's in place, and an object as an Object with its
 * keys, each where a public name of a plain Object is set (JSON's
 * `__proto__` is a key of the object's own). Deeper than RECURSION_DEPTH,
 * as deepFromHost does, as avmplus reads any depth.
 */
function fromHost(rt: Runtime, v: unknown, depth = 0): Value {
  if (typeof v !== "object" || v === null) {
    return v;
  }

  if (depth > RECURSION_DEPTH) {
    return deepFromHost(rt, v);
  }

  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      v[i] = fromHost(rt, v[i], depth + 1);
    }

    return rt.array(v);
  }

  const o = rt.newObject([]);
  const d: Map<string, Value> = o.$d;
  const from = v as Record<string, unknown>;
  for (const key in from) {
    d.set(key, fromHost(rt, from[key], depth + 1));
  }

  return o;
}

/** As fromHost, with a stack of its own, not the host's: slower, and at any depth. */
function deepFromHost(rt: Runtime, root: object): Value {
  const pending: [unknown, AsObject][] = [];
  const wrap = (v: unknown): Value => {
    if (typeof v !== "object" || v === null) {
      return v;
    }

    const o = Array.isArray(v) ? rt.array(v) : rt.newObject([]);
    pending.push([v, o]);
    return o;
  };

  const result = wrap(root);
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [host, o] = next;
    if (Array.isArray(host)) {
      for (let i = 0; i < host.length; i++) {
        host[i] = wrap(host[i]);
      }
    } else {
      const d: Map<string, Value> = o.$d;
      const from = host as Record<string, unknown>;
      for (const key in from) {
        d.set(key, wrap(from[key]));
      }
    }
  }

  return result;
}

/** As JSONParser: the JSON text to a value, or SyntaxError 1132. */
function parse(rt: Runtime, text: string): Value {
  let i = 0;
  let token = "";
  // The current token, read through a function: advance() changes it.
  const current = (): string => token;
  let value: Value;
  const fail = (): never => {
    throw rt.error("SyntaxError", 1132);
  };

  const digits = () => {
    const start = i;
    while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) {
      i++;
    }

    if (i <= start) {
      fail();
    }
  };

  const advance = () => {
    token = "";
    while (i < text.length) {
      const c = text[i];
      switch (c) {
        case "\t":
        case "\n":
        case "\r":
        case " ":
          i++;
          continue;
        case ",":
        case ":":
        case "{":
        case "}":
        case "[":
        case "]":
          i++;
          token = c;
          return;
        case '"': {
          i++;
          let s = "";
          let start = i;
          while (i < text.length) {
            const code = text.charCodeAt(i);
            if (code < 32) {
              fail();
            }

            if (code === 34) {
              break;
            }

            if (code === 92) {
              s += text.slice(start, i);
              i++;
              if (i === text.length) {
                fail();
              }

              const e = text[i];
              const simple: Record<string, string> = {
                '"': '"',
                "/": "/",
                "\\": "\\",
                b: "\b",
                f: "\f",
                n: "\n",
                r: "\r",
                t: "\t",
              };
              if (e in simple) {
                s += simple[e];
              } else if (e === "u") {
                const hex = text.slice(i + 1, i + 5);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                  fail();
                }

                s += String.fromCharCode(Number.parseInt(hex, 16));
                i += 4;
              } else {
                fail();
              }

              i++;
              start = i;
            } else {
              i++;
            }
          }

          if (i === text.length) {
            fail();
          }

          value = s + text.slice(start, i);
          i++;
          token = '"';
          return;
        }
        case "-":
        case ".":
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9": {
          const start = i;
          if (text[i] === "-") {
            i++;
          }

          digits();
          if (text[i] === ".") {
            i++;
            digits();
          }

          if (text[i] === "e" || text[i] === "E") {
            i++;
            if (text[i] === "-" || text[i] === "+") {
              i++;
            }

            digits();
          }

          value = text.slice(start, i);
          token = "0";
          return;
        }
        default:
          for (const word of ["null", "true", "false"]) {
            if (text.startsWith(word, i)) {
              i += word.length;
              token = word[0];
              return;
            }
          }

          fail();
      }
    }
  };

  const parseValue = (): Value => {
    switch (current()) {
      case "n":
        advance();
        return null;
      case "t":
        advance();
        return true;
      case "f":
        advance();
        return false;
      case '"': {
        const s = value;
        advance();
        return s;
      }
      case "0": {
        const n = Number(value);
        advance();
        return n;
      }
      case "[": {
        advance();
        const a: Value[] = [];
        if (current() !== "]") {
          for (;;) {
            a.push(parseValue());
            if (current() !== ",") {
              break;
            }

            advance();
          }
        }

        if (current() !== "]") {
          fail();
        }

        advance();
        return rt.array(a);
      }
      case "{": {
        advance();
        const o = rt.newObject([]);
        if (current() !== "}") {
          for (;;) {
            if (current() !== '"') {
              fail();
            }

            const name = parseValue();
            if (current() !== ":") {
              fail();
            }

            advance();
            rt.setProperty(o, qname(publicNs, name), parseValue());
            if (current() !== ",") {
              break;
            }

            advance();
          }
        }

        if (current() !== "}") {
          fail();
        }

        advance();
        return o;
      }
      default:
        return fail();
    }
  };

  advance();
  const result = parseValue();
  if (current() !== "") {
    fail();
  }

  return result;
}

/** A class instance's public variables and readable accessors but [Transient] ones, the class's own first, as TypeDescriber lists them. */
function describedNames(traits: Traits): [string[], string[]] {
  const variables: string[] = [];
  const accessors: string[] = [];
  for (let t: Traits | null = traits; t && t.name !== "Object"; t = t.base) {
    for (const [name, list] of t.bindings) {
      for (const b of list) {
        if (b.ns.kind !== NS_Public || b.ns.uri !== "" || traits.isTransient(b.value)) {
          continue;
        }

        const kind = b.value & 7;
        if (kind === 2 || kind === 3) {
          variables.push(name);
        } else if (kind === 5 || kind === 7) {
          accessors.push(name);
        }
      }
    }
  }

  return [variables, accessors];
}

/**
 * As JSONSerializer, in two steps, as Ruffle's does: the walk over the AS3
 * values, calling toJSON and the replacer in avmplus' order and failing a
 * cycle as it does, builds a tree of the host's values, which the host's
 * JSON.stringify writes, gap and all. The text need not be avmplus' own:
 * key order, escapes and numbers' digits differ, and it reads back as the
 * same keys and values.
 */
class Serializer {
  private readonly active = new Set<AsObject>();

  constructor(
    private readonly rt: Runtime,
    private readonly propertyList: string[] | null,
    private readonly replacer: AsObject | null,
    private readonly gap: string,
  ) {}

  stringify(v: Value): Value {
    const wrapper = this.rt.newObject([]);
    wrapper.$d.set("", v);
    const tree = this.str("", v, wrapper);
    return tree === undefined ? undefined : JSON.stringify(tree, null, this.gap);
  }

  /**
   * As StrFoundValue: the value to write for `valueIn`, the host's, or
   * undefined for none. A number the host writes as null if it is not
   * finite, as avmplus does.
   */
  private str(key: string, valueIn: Value, holder: AsObject): unknown {
    const rt = this.rt;
    let value = valueIn;
    if (value !== null && value !== undefined) {
      const probe = this.toJSONOf(value);
      if (probe?.$f) {
        value = rt.callValue(probe, value, [key], null);
      }
    }

    if (this.replacer) {
      value = rt.callValue(this.replacer, holder, [key, value], null);
    }

    switch (typeof value) {
      case "boolean":
      case "string":
      case "number":
        return value;
      case "object":
        break;
      default:
        return undefined;
    }

    if (value === null) {
      return null;
    }

    if (value.$f) {
      return undefined;
    }

    const traits: Traits = rt.traitsOf(value);
    if (isA(traits, "Array") || isVector(traits)) {
      return this.array(value);
    }

    return this.object(value, traits);
  }

  /**
   * As the probe of StrFoundValue: `value`'s toJSON, or null. A public
   * binding first; else, as hasProperty finds a public name that is not an
   * index, the object's own dynamic one and then its prototype chain's.
   *
   * avmplus probes the AS3 namespace before the public one, with the
   * builtin's own AS3 namespace, which sees AS3 bindings only at the
   * builtin's API version: no class of avmshell's binds an AS3 toJSON
   * (theirs are its prototypes'), and a script's AS3 toJSON is never
   * found, even when it has no public one. So only the public one is.
   */
  private toJSONOf(value: Value): Value {
    const rt = this.rt;
    const traits = rt.traitsOf(value);
    let bound = boundToJSON.get(traits);
    if (bound === undefined) {
      bound = traits.find(TO_JSON) !== 0;
      boundToJSON.set(traits, bound);
    }

    if (bound) {
      return rt.getProperty(value, TO_JSON);
    }

    const own: Map<string, Value> | null | undefined =
      typeof value === "object" ? value.$d : undefined;
    if (own?.has("toJSON")) {
      return own.get("toJSON");
    }

    for (let p = rt.protoOf(value); p; p = p.$p) {
      if (p.$d?.has("toJSON")) {
        return p.$d.get("toJSON");
      }
    }

    return null;
  }

  private enter(value: AsObject): void {
    if (this.active.has(value)) {
      throw this.rt.error("TypeError", 1129);
    }

    this.active.add(value);
  }

  /** As JO: the property list, or the described properties and then the dynamic ones. */
  private object(value: AsObject, traits: Traits): Record<string, unknown> {
    const rt = this.rt;
    this.enter(value);
    const out: Record<string, unknown> = {};
    const own: Map<string, Value> | null = value.$d;
    const prop = (name: string) => {
      // A dynamic property of its own is where getProperty would find it.
      const v = own?.has(name) ? own.get(name) : rt.getProperty(value, qname(publicNs, name));
      const written = this.str(name, v, value);
      if (written === undefined) {
        return;
      }

      if (name === "__proto__") {
        // Assigned, it would set the prototype, not the key.
        Object.defineProperty(out, name, { value: written, enumerable: true, writable: true });
      } else {
        out[name] = written;
      }
    };

    if (this.propertyList) {
      for (const name of this.propertyList) {
        prop(name);
      }
    } else {
      const [variables, accessors] = describedNames(traits);
      for (const name of [...variables, ...accessors]) {
        prop(name);
      }

      for (const name of rt.enumerableNames(value)) {
        prop(name);
      }
    }

    this.active.delete(value);
    return out;
  }

  /** As JAfinish: each element, null for one that writes nothing. */
  private array(value: AsObject): unknown[] {
    this.enter(value);
    const elements: Value[] = value.$a;
    const length = elements.length;
    const out = new Array<unknown>(length);
    for (let i = 0; i < length; i++) {
      // A hole is looked for on the prototype chain, as getUintProperty does.
      const element =
        i in elements ? elements[i] : this.rt.getProperty(value, this.rt.publicName(i));
      const written = this.str(String(i), element, value);
      out[i] = written === undefined ? null : written;
    }

    this.active.delete(value);
    return out;
  }
}

function isVector(traits: Traits): boolean {
  for (let t: Traits | null = traits; t; t = t.base) {
    if (t.name.startsWith("__AS3__.vec::Vector$")) {
      return true;
    }
  }

  return false;
}

function isA(traits: Traits, name: string): boolean {
  for (let t: Traits | null = traits; t; t = t.base) {
    if (t.name === name) {
      return true;
    }
  }

  return false;
}

export function jsonNatives(): Natives {
  return {
    "JSON.JSON::parseCore": (rt) => (text: Value) => parseText(rt, rt.toString(text)),
    "JSON.JSON::stringifySpecializedToString":
      (rt) => (value: Value, propertyList: Value, replacer: Value, gap: Value) =>
        new Serializer(
          rt,
          propertyList?.$a ? propertyList.$a.map((n: Value) => rt.toString(n)) : null,
          replacer?.$f ? replacer : null,
          gap === null || gap === undefined ? "" : rt.toString(gap),
        ).stringify(value),
  };
}
