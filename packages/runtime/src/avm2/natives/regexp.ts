// RegExp: `this` holds its JavaScript RegExp in $re; and the match
// arrays String's methods give too.
import type { AsObject, ClassHook, Runtime, Value } from "../runtime.js";
import { AS3, type Natives, plain } from "./define.js";

export const regexpNatives: Natives = {
  "RegExp#get:source": plain(function (this: AsObject) {
    return this.$source;
  }),
  "RegExp#get:global": plain(function (this: AsObject) {
    return this.$re.global;
  }),
  "RegExp#get:ignoreCase": plain(function (this: AsObject) {
    return this.$re.ignoreCase;
  }),
  "RegExp#get:multiline": plain(function (this: AsObject) {
    return this.$re.multiline;
  }),
  "RegExp#get:dotall": plain(function (this: AsObject) {
    return this.$re.dotAll;
  }),
  "RegExp#get:extended": plain(function (this: AsObject) {
    return this.$extended;
  }),
  "RegExp#get:lastIndex": plain(function (this: AsObject) {
    return this.$re.lastIndex;
  }),
  "RegExp#set:lastIndex": (rt) =>
    function (this: AsObject, i: Value) {
      this.$re.lastIndex = rt.toInt(i);
    },
  [`RegExp#${AS3}::exec`]: (rt) =>
    function (this: AsObject, s: Value = "") {
      const re: RegExp = this.$re;
      const m = re.exec(rt.toString(s));
      return m ? matchArray(rt, m) : null;
    },
};

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
  if (pattern?.$re instanceof RegExp && options === undefined) {
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
  const text = extended
    ? source.replace(/\\.|\s+|#[^\n]*/g, (t) => (t[0] === "\\" ? t : ""))
    : source;
  o.$re = compile(text, js);
  return o;
}

/**
 * The JavaScript RegExp of an AS3 pattern (see fromPcre). One that does
 * not compile throws nothing, as in avmplus: it matches nothing.
 */
export function compile(source: string, flags: string): RegExp {
  try {
    const re = new RegExp(fromPcre(source), flags);
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
 * PCRE's syntax that JavaScript has otherwise: a named group (?P<name>...)
 * as (?<name>...), its reference (?P=name) as \k<name>, and inline flags,
 * (?i) and (?-i), as a modifier group (?i:...) to the end of the group
 * they are in. Escapes and character classes are left as they are.
 */
function fromPcre(source: string): string {
  if (!source.includes("(?")) {
    return source;
  }

  let out = "";
  // For each open group, and the pattern itself, the modifier groups to close with it.
  const closers: number[] = [0];
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

    if (c === "[") {
      inClass = true;
      out += c;
      continue;
    }

    if (c === ")") {
      out += ")".repeat(closers.pop() ?? 0);
      if (!closers.length) {
        closers.push(0);
      }

      out += c;
      continue;
    }

    if (c !== "(") {
      out += c;
      continue;
    }

    if (source.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      closers.push(0);
      continue;
    }

    const reference = /^\(\?P=(\w+)\)/.exec(source.slice(i));
    if (reference) {
      out += `\\k<${reference[1]}>`;
      i += reference[0].length - 1;
      continue;
    }

    const flags = /^\(\?([imsx]*)(?:-([imsx]*))?\)/.exec(source.slice(i));
    if (flags && (flags[1] || flags[2])) {
      // JavaScript's modifiers are i, m and s; x was applied to the whole pattern.
      const on = flags[1].replace("x", "");
      const off = (flags[2] ?? "").replace("x", "");
      if (on || off) {
        out += `(?${on}${off ? `-${off}` : ""}:`;
        closers[closers.length - 1]++;
      }

      i += flags[0].length - 1;
      continue;
    }

    out += c;
    closers.push(0);
  }

  return out + ")".repeat(closers[0]);
}

export const regexpHooks: Record<string, ClassHook> = {
  RegExp: {
    construct: newRegExp,
    // RegExp.prototype is a RegExp, of the empty pattern, which avmplus writes (?:).
    prototype: (rt, cls) => newRegExp(rt, cls, ["(?:)"]),
    call: (rt, cls, args) =>
      args[0]?.$re instanceof RegExp && args[1] === undefined ? args[0] : newRegExp(rt, cls, args),
  },
};
