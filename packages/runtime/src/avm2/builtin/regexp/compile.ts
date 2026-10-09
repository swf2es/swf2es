// AS3's regular expressions in JavaScript's: avmplus' PCRE patterns and
// flags translated to a JavaScript RegExp, the match arrays AS3 gives, and
// replacement text. RegExp's natives and String's use them.

import type { AsObject, Value } from "../../descriptors.js";
import type { Runtime } from "../../runtime.js";

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
export function newRegExp(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
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
  if (
    (source.length > 200 && nestedTooDeep(source)) ||
    (!extended && source.includes("(?<") && variableLookbehind(source))
  ) {
    return new RegExp("(?!)", flags);
  }

  try {
    const re = new RegExp(fromPcre(source, extended, flags.includes("m")), flags);
    // V8 compiles on the first match, where a pattern too large throws: here, once.
    re.test("");
    re.lastIndex = 0;
    return re;
  } catch {
    return new RegExp("(?!)", flags);
  }
}

/**
 * Whether a lookbehind in `source` may match strings of more than one
 * length, which PCRE 7.3 does not compile: each alternative of the
 * lookbehind must have a fixed length, and each group within it one
 * length whichever of its alternatives matches. A quantifier other than
 * {n}, and a back reference, have no fixed length. JavaScript compiles
 * them all.
 */
function variableLookbehind(source: string): boolean {
  let i = 0;
  let refused = false;

  /** The lengths of the alternatives from i to the group's ")", which it steps past; NaN for one with none. */
  const alternatives = (): number[] => {
    const lengths: number[] = [];
    let length = 0;
    while (i < source.length && source[i] !== ")") {
      if (source[i] === "|") {
        lengths.push(length);
        length = 0;
        i++;
        continue;
      }

      length += quantified(item());
    }

    lengths.push(length);
    i++;

    return lengths;
  };

  /** A group's length, from after its "(": one length, or NaN; a lookaround's is 0. */
  const group = (): number => {
    const rest = source.slice(i, i + 3);
    if (rest.startsWith("?#")) {
      const end = source.indexOf(")", i);
      i = end < 0 ? source.length : end + 1;
      return 0;
    }

    if (rest.startsWith("?<=") || rest.startsWith("?<!")) {
      i += 3;
      if (alternatives().some(Number.isNaN)) {
        refused = true;
      }

      return 0;
    }

    if (rest.startsWith("?=") || rest.startsWith("?!")) {
      i += 2;
      alternatives();
      return 0;
    }

    if (rest.startsWith("?P=") || /^\?(R|\d)/.test(rest)) {
      i = source.indexOf(")", i) + 1 || source.length;
      return Number.NaN;
    }

    if (source[i] === "?") {
      // ?: ?P<name> or flags, and flags alone, as (?i), are no group.
      const kind = /^\?(?:P<\w*>|[imsxX-]*)/.exec(source.slice(i))?.[0] ?? "?";
      i += kind.length;
      if (source[i] === ")") {
        i++;
        return 0;
      }

      if (source[i] === ":") {
        i++;
      }
    }

    const lengths = alternatives();
    return lengths.every((n) => n === lengths[0]) ? lengths[0] : Number.NaN;
  };

  /** The length of the item at i, which it steps past. */
  const item = (): number => {
    const c = source[i++];
    if (c === "(") {
      return group();
    }

    if (c === "^" || c === "$") {
      return 0;
    }

    if (c === "[") {
      if (source[i] === "^") {
        i++;
      }

      // A ] first is a literal.
      if (source[i] === "]") {
        i++;
      }

      while (i < source.length && source[i] !== "]") {
        i += source[i] === "\\" ? 2 : 1;
      }

      i++;
      return 1;
    }

    if (c !== "\\") {
      // A character beyond the BMP is one in PCRE's UTF-8 too.
      if ((source.codePointAt(i - 1) ?? 0) > 0xffff) {
        i++;
      }

      return 1;
    }

    const e = source[i++];
    if (e >= "1" && e <= "9") {
      return Number.NaN;
    }

    if ("bBAZzG".includes(e)) {
      return 0;
    }

    if (e === "Q") {
      const end = source.indexOf("\\E", i);
      const literal = source.slice(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end + 2;
      return [...literal].length;
    }

    if ((e === "x" || e === "p" || e === "P") && source[i] === "{") {
      i = source.indexOf("}", i) + 1 || source.length;
    } else if (e === "c" || e === "p" || e === "P") {
      i++;
    }

    return 1;
  };

  /** An item's length repeated by the quantifier at i, if any, which it steps past. */
  const quantified = (length: number): number => {
    const c = source[i];
    let times = 1;
    if (c === "*" || c === "+" || c === "?") {
      i++;
      times = Number.NaN;
    } else if (c === "{") {
      const q = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (!q) {
        return length;
      }

      i += q[0].length;
      times = q[2] === undefined || q[3] === q[1] ? Number(q[1]) : Number.NaN;
    } else {
      return length;
    }

    // Lazy or possessive.
    if (source[i] === "?" || source[i] === "+") {
      i++;
    }

    return length * times;
  };

  while (i < source.length && !refused) {
    alternatives();
  }

  return refused;
}

/** What avmplus' PCRE 7.3 has room for in its pre-compile workspace, less its safety margin. */
const WORKSPACE = 2138 - 100;

/**
 * Whether PCRE fails to compile `source` for nesting groups too deeply:
 * its pre-compile phase keeps, for each open group, the group's opcode
 * (5 bytes for a capture, 3 for any other group) and the item before it,
 * and fails once they pass the workspace, at some 400 nested captures.
 * The items' sizes are PCRE's for the common ones: a literal, a class.
 */
function nestedTooDeep(source: string): boolean {
  // The bytes held by the groups open, and by the item before the next one.
  let held = 5;
  let previous = 0;
  const outer: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    let item = 2;
    if (c === "(") {
      const capture = source[i + 1] !== "?" || source.startsWith("(?P<", i);
      outer.push(held);
      held += previous + (capture ? 5 : 3);
      previous = 0;
      if (held > WORKSPACE) {
        return true;
      }

      // Past the group's kind: ?: ?= ?! ?<= ?<! ?P<name> or flags.
      if (source[i + 1] === "?") {
        const end = source.slice(i + 2).search(/[:=!>)]/);
        i = end < 0 ? source.length : i + 2 + end;
      }

      continue;
    }

    if (c === ")") {
      held = outer.pop() ?? held;
      // The group is the next one's previous item, but what it holds is gone.
      previous = 0;
      continue;
    }

    if (c === "|") {
      previous = 0;
      continue;
    }

    if (c === "\\") {
      i++;
    } else if (c === "[") {
      // A class is its opcode and a 32-byte bitmap.
      item = 33;
      i++;
      if (source[i] === "^") {
        i++;
      }

      // A ] first is a literal.
      if (source[i] === "]") {
        i++;
      }

      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") {
          i++;
        }

        i++;
      }
    } else if (c === "." || c === "^" || c === "$") {
      item = 1;
    } else if ("*+?{".includes(c)) {
      continue;
    }

    previous = item;
    if (held + previous > WORKSPACE) {
      return true;
    }
  }

  return false;
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
 * - a comment group (?#...) dropped;
 * - in multiline mode, ^ and $ at PCRE's newlines (LINE_START, LINE_END),
 *   multiline as the m flag, (?m) and (?-m) have it where each stands.
 * Escapes and character classes are left as they are.
 */
function fromPcre(source: string, extended: boolean, multiline: boolean): string {
  if (!extended && !source.includes("(?") && !(multiline && /[$^]/.test(source))) {
    return source;
  }

  let out = "";
  let x = extended;
  let m = multiline;
  // For each open group, and the pattern itself: the modifier groups to
  // close with it, and whether x was on where it opened.
  const closers: number[] = [0];
  const outerX: boolean[] = [x];
  const outerM: boolean[] = [m];
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
      m = outerM.pop() ?? multiline;
      if (!closers.length) {
        closers.push(0);
        outerX.push(x);
        outerM.push(m);
      }

      out += c;
      continue;
    }

    if (m && (c === "^" || c === "$")) {
      out += c === "^" ? LINE_START : LINE_END;
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
      outerM.push(m);
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
        outerM.push(m);
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

      if (on.includes("m")) {
        m = true;
      } else if (off.includes("m")) {
        m = false;
      }

      i += flags[0].length - 1;
      continue;
    }

    out += c;
    closers.push(0);
    outerX.push(x);
    outerM.push(m);
  }

  return out + ")".repeat(closers[0]);
}

// PCRE's newlines, as avmplus builds it: any of these, \r\n as one.
const NEWLINE = "[\\n\\r\\v\\f\\x85\\u2028\\u2029]";

/** Multiline ^: the start, or after a newline, but not at the end, nor within \r\n. */
const LINE_START = `(?:(?<![\\s\\S])|(?<=${NEWLINE})(?!(?<=\\r)\\n)(?=[\\s\\S]))`;

/** Multiline $: the end, or before any newline. */
const LINE_END = `(?=${NEWLINE}|(?![\\s\\S]))`;

const modifiers = (on: string, off: string) => (on || off ? `${on}${off ? `-${off}` : ""}` : "");

/** PCRE's whitespace, which extended mode drops. */
const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
