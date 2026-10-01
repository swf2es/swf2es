// RegExp: `this` holds its JavaScript RegExp in $re; and the match
// arrays String's methods give too.
import type { AsObject, ClassHook, Runtime, Value } from "../runtime.js";
import { AS3, type Natives, registerNativeClass } from "./define.js";

/** RegExp's natives, for `rt`: written as a class, each running with the RegExp object as `this`. */
export function regexpNatives(rt: Runtime): Natives {
  const natives: Natives = {};

  class RegExpNatives {
    declare $re: RegExp;
    declare $source: string;
    declare $extended: boolean;

    get source(): string {
      return this.$source;
    }

    get global(): boolean {
      return this.$re.global;
    }

    get ignoreCase(): boolean {
      return this.$re.ignoreCase;
    }

    get multiline(): boolean {
      return this.$re.multiline;
    }

    get dotall(): boolean {
      return this.$re.dotAll;
    }

    get extended(): boolean {
      return this.$extended;
    }

    get lastIndex(): number {
      return this.$re.lastIndex;
    }

    set lastIndex(i: Value) {
      this.$re.lastIndex = rt.toInt(i);
    }

    [`${AS3}::exec`](s: Value = ""): Value {
      const m = this.$re.exec(rt.toString(s));
      return m ? matchArray(rt, m) : null;
    }
  }

  registerNativeClass(natives, "RegExp", RegExpNatives);
  return natives;
}

/** A match as AS3 gives it: an Array of the match and its groups, with its index and input. */
export function matchArray(rt: Runtime, m: RegExpMatchArray): AsObject {
  const a = rt.array(Array.from(m));
  if (m.index !== undefined) {
    a.$d.set("index", m.index);
    a.$d.set("input", m.input);
  }

  return a;
}

/**
 * A RegExp from its pattern and options, as RegExpClass::construct: AS3's
 * flags g, i, m and s are JavaScript's, and x, extended, drops whitespace
 * and comments from the pattern.
 */
function newRegExp(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  const [pattern, options] = args;
  const o = cls.$it.instance();
  // A RegExp with flags is a TypeError, as ECMA-262 15.10.4.1 has it.
  if (pattern?.$re instanceof RegExp && options !== undefined) {
    throw rt.error("TypeError", 1100);
  }

  if (pattern?.$re instanceof RegExp) {
    o.$source = pattern.$source;
    o.$extended = pattern.$extended;
    o.$re = new RegExp(pattern.$re.source, pattern.$re.flags);
    return o;
  }

  const source = pattern === undefined ? "" : rt.toString(pattern);
  const flags = options === undefined ? "" : rt.toString(options);
  const extended = flags.includes("x");
  const js = [..."gims"].filter((f) => flags.includes(f)).join("");
  o.$source = source;
  o.$extended = extended;
  o.$re = compile(source, js, extended);
  return o;
}

/**
 * The JavaScript RegExp of an AS3 pattern (see fromPcre). One that does
 * not compile throws nothing, as in avmplus: it matches nothing.
 */
export function compile(source: string, flags: string, extended = false): RegExp {
  try {
    const re = new RegExp(fromPcre(source, extended), flags);
    // V8 compiles on the first match, where a pattern too large throws: here, once.
    re.test("");
    re.lastIndex = 0;
    return re;
  } catch {
    return new RegExp("(?!)", flags);
  }
}

/**
 * A replacement string as avmplus reads it: $0d, a group number d with a
 * leading zero, gives group d and then the digit d again, as avmplus
 * reads both digits but steps past one. JavaScript's $0dd does the same.
 */
export function replacement(re: RegExp, text: string): string {
  if (!/\$0[1-9]/.test(text)) {
    return text;
  }

  const groups = (new RegExp(`${re.source}|`).exec("") as RegExpExecArray).length - 1;
  return text.replace(/\$(\$|0([1-9]))/g, (t, _, d) =>
    d && Number(d) <= groups ? `$0${d}${d}` : t,
  );
}

/**
 * PCRE's syntax that JavaScript has otherwise:
 * - a named group (?P<name>...) as (?<name>...), and its reference
 *   (?P=name) as \\k<name>;
 * - inline flags, (?i) and (?-i), as a modifier group (?i:...) to the end
 *   of the group they are in, and (?i:...) as it is;
 * - extended mode, the x flag, and (?x) and (?x:...) within: whitespace
 *   and # comments dropped where it is on;
 * - a comment group (?#...) dropped.
 * Escapes and character classes are left as they are.
 */
function fromPcre(source: string, extended: boolean): string {
  if (!extended && !source.includes("(?")) {
    return source;
  }

  let out = "";
  let x = extended;
  // For each open group, and the pattern itself: the modifier groups to
  // close with it, and whether x was on where it opened.
  const closers: number[] = [0];
  const outerX: boolean[] = [x];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      out += source.slice(i, i + 2);
      i++;
      continue;
    }

    if (inClass) {
      inClass = c !== "]";
      out += c;
      continue;
    }

    if (x && isSpace(c)) {
      continue;
    }

    if (x && c === "#") {
      while (i + 1 < source.length && source[i + 1] !== "\n") {
        i++;
      }

      continue;
    }

    if (c === "[") {
      inClass = true;
      out += c;
      continue;
    }

    if (c === ")") {
      out += ")".repeat(closers.pop() ?? 0);
      x = outerX.pop() ?? extended;
      if (!closers.length) {
        closers.push(0);
        outerX.push(x);
      }

      out += c;
      continue;
    }

    if (c !== "(") {
      out += c;
      continue;
    }

    if (source.startsWith("(?#", i)) {
      const end = source.indexOf(")", i);
      i = end < 0 ? source.length : end;
      continue;
    }

    if (source.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      closers.push(0);
      outerX.push(x);
      continue;
    }

    const reference = /^\(\?P=(\w+)\)/.exec(source.slice(i));
    if (reference) {
      out += `\\k<${reference[1]}>`;
      i += reference[0].length - 1;
      continue;
    }

    const flags = /^\(\?([imsx]*)(?:-([imsx]*))?([:)])/.exec(source.slice(i));
    if (flags && (flags[1] || flags[2])) {
      const on = flags[1];
      const off = flags[2] ?? "";
      // JavaScript's modifiers are i, m and s; x is applied here.
      const js = modifiers(on.replace("x", ""), off.replace("x", ""));
      const scoped = flags[3] === ":";
      if (scoped) {
        closers.push(0);
        outerX.push(x);
        out += js ? `(?${js}:` : "(?:";
      } else if (js) {
        out += `(?${js}:`;
        closers[closers.length - 1]++;
      }

      if (on.includes("x")) {
        x = true;
      } else if (off.includes("x")) {
        x = false;
      }

      i += flags[0].length - 1;
      continue;
    }

    out += c;
    closers.push(0);
    outerX.push(x);
  }

  return out + ")".repeat(closers[0]);
}

const modifiers = (on: string, off: string) => (on || off ? `${on}${off ? `-${off}` : ""}` : "");

/** PCRE's whitespace, which extended mode drops. */
const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

export const regexpHooks: Record<string, ClassHook> = {
  RegExp: {
    construct: newRegExp,
    // RegExp.prototype is a RegExp, of the empty pattern, which avmplus writes (?:).
    prototype: (rt, cls) => newRegExp(rt, cls, ["(?:)"]),
    call: (rt, cls, args) =>
      args[0]?.$re instanceof RegExp && args[1] === undefined ? args[0] : newRegExp(rt, cls, args),
  },
};
