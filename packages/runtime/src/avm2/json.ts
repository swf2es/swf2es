// JSON's natives, as avmplus' JSONParser and JSONSerializer: the parser's
// tokens and SyntaxError 1132, and stringify's toJSON (in the AS3
// namespace first), replacers, gaps, numbers in avmplus' own format, and a
// class instance's public variables and readable accessors before its
// dynamic properties, leaving out [Transient] ones.
//
// Translated from avmplus' core/JSONClass.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import { NS_Public, namespace, publicNs, qname } from "./names.js";
import { convertDoubleToString } from "./numbers.js";
import type { AsObject, Runtime, Traits, Value } from "./runtime.js";

type Natives = Record<string, (rt: Runtime) => (...args: Value[]) => Value>;

const AS3 = namespace(NS_Public, "http://adobe.com/AS3/2006/builtin");

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

/** As JSONSerializer. */
class Serializer {
  private out = "";
  private indent = "";
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
    return this.str("", v, wrapper, "", false) ? this.out : undefined;
  }

  private quote(s: string): void {
    let out = '"';
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 32 && c !== 34 && c !== 92) {
        out += ch;
        continue;
      }

      switch (ch) {
        case '"':
          out += '\\"';
          break;
        case "\\":
          out += "\\\\";
          break;
        case "\b":
          out += "\\b";
          break;
        case "\t":
          out += "\\t";
          break;
        case "\n":
          out += "\\n";
          break;
        case "\f":
          out += "\\f";
          break;
        case "\r":
          out += "\\r";
          break;
        default:
          out += `\\u${(c + 0x10000).toString(16).slice(1)}`;
      }
    }

    this.out += `${out}"`;
  }

  /** As committedToEmitFor: the pending separator, then the key if in an object. */
  private commit(key: string, pending: string, colon: boolean): void {
    this.out += pending;
    if (colon) {
      this.quote(key);
      this.out += this.gap ? ": " : ":";
    }
  }

  /** As StrFoundValue: whether it wrote anything. */
  private str(
    key: string,
    valueIn: Value,
    holder: AsObject,
    pending: string,
    colon: boolean,
  ): boolean {
    const rt = this.rt;
    let value = valueIn;
    if (value !== null && value !== undefined) {
      let probe: Value = null;
      const as3 = qname(AS3, "toJSON");
      const pub = qname(publicNs, "toJSON");
      if (rt.hasProperty(value, as3)) {
        probe = rt.getProperty(value, as3);
      } else if (rt.hasProperty(value, pub)) {
        probe = rt.getProperty(value, pub);
      }

      if (probe?.$f) {
        value = rt.callValue(probe, value, [key], null);
      }
    }

    if (this.replacer) {
      value = rt.callValue(this.replacer, holder, [key, value], null);
    }

    if (value === null) {
      this.commit(key, pending, colon);
      this.out += "null";
      return true;
    }

    switch (typeof value) {
      case "boolean":
        this.commit(key, pending, colon);
        this.out += value ? "true" : "false";
        return true;
      case "string":
        this.commit(key, pending, colon);
        this.quote(value);
        return true;
      case "number":
        this.commit(key, pending, colon);
        this.out += Number.isFinite(value) ? convertDoubleToString(value) : "null";
        return true;
      case "object":
        break;
      default:
        return false;
    }

    if (value.$f) {
      return false;
    }

    this.commit(key, pending, colon);
    const traits: Traits = rt.traitsOf(value);
    if (isA(traits, "Array") || isVector(traits)) {
      return this.array(value);
    }

    return this.object(value, traits);
  }

  private enter(value: AsObject): [string, string, string, string] {
    if (this.active.has(value)) {
      throw this.rt.error("TypeError", 1129);
    }

    this.active.add(value);
    const stepback = this.indent;
    this.indent += this.gap;
    return this.gap
      ? [stepback, `\n${this.indent}`, `,\n${this.indent}`, `\n${stepback}`]
      : [stepback, "", ",", ""];
  }

  private leave(value: AsObject, stepback: string): void {
    this.active.delete(value);
    this.indent = stepback;
  }

  /** As JO: the property list, or the described properties and then the dynamic ones. */
  private object(value: AsObject, traits: Traits): boolean {
    const rt = this.rt;
    const [stepback, first, connective, post] = this.enter(value);
    let pending = first;
    let emitted = false;
    this.out += "{";
    const prop = (name: string) => {
      if (this.str(name, rt.getProperty(value, qname(publicNs, name)), value, pending, true)) {
        pending = connective;
        emitted = true;
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

    if (emitted) {
      this.out += post;
    }

    this.out += "}";
    this.leave(value, stepback);
    return true;
  }

  /** As JAfinish: each element, null for one that writes nothing. */
  private array(value: AsObject): boolean {
    const [stepback, first, connective, post] = this.enter(value);
    let pending = first;
    const length: number = value.$a.length;
    this.out += "[";
    for (let i = 0; i < length; i++) {
      const element = this.rt.getProperty(value, this.rt.publicName(i));
      if (!this.str(String(i), element, value, pending, false)) {
        this.out += `${pending}null`;
      }

      pending = connective;
    }

    if (length > 0) {
      this.out += post;
    }

    this.out += "]";
    this.leave(value, stepback);
    return true;
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
    "JSON.JSON::parseCore": (rt) => (text: Value) => parse(rt, rt.toString(text)),
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
