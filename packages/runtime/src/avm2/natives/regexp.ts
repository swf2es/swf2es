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
  o.$re = new RegExp(
    extended ? source.replace(/\\.|\s+|#[^\n]*/g, (t) => (t[0] === "\\" ? t : "")) : source,
    js,
  );
  return o;
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
