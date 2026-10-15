// What a SWF's AVM1 module calls (docs/avm1.md, "Compiling"): its factory
// takes the runtime, asks it for the operations of the SWF's version,
// `V`, once, and each region of each block takes its activation, `cx`.
import { Halt, NotYet } from "./errors.js";
import type { Host, Target } from "./host.js";
import { Avm1Object, get, invoke, keys, nameOf, removeOwn, set } from "./objects.js";
import {
  add2,
  charOf,
  extract,
  firstCode,
  lessThan,
  looselyEquals,
  strictlyEquals,
  toInt32,
  wellFormed,
} from "./operators.js";
import { Realm } from "./realm.js";
import {
  defineLocal,
  defineLocal2,
  deleteVariable,
  foundOn,
  getVariable,
  resolve,
  resolveCallable,
  SCOPE_Global,
  SCOPE_Target,
  Scope,
  setVariable,
} from "./scope.js";
import { type Primitive, stringOf, toBoolean, toNumber, typeOf, type Value } from "./values.js";

export { Halt, NotYet };

/**
 * What a region runs in: the operand stack, the constant pool, the target
 * and the host. Flash has one operand stack, not one an activation: every
 * activation of a frame's actions shares the frame's, which the player
 * empties between frames.
 */
export class Activation {
  constructor(
    /** The operand stack, the frame's. */
    public st: Value[],
    /** The constant pool the region reads where the compiler cannot tell which: see V.constantPool. */
    public pool: Value[],
    /** The clip timeline actions act on. */
    public target: Target,
    public host: Host,
    readonly realm: Realm,
    /** The scope chain, searched from here down to `_global`. */
    public scope: Scope,
    /** `this`. */
    public self: Value,
    /** The target's AVM1 object: a function called by name without an object takes it as `this`. */
    public clip: Avm1Object,
  ) {}

  get global(): Avm1Object {
    return this.realm.global;
  }
}

/** A region of a block, the block's own code or a function's body. */
export type Region = (cx: Activation) => void;

/** What the factory of a SWF's module gives: by block, its regions, its own code first. */
export type Blocks = Region[][];

/** A module's default export. */
export type Factory = (rt: Runtime) => Blocks;

/**
 * The operations of a version, `V`: the module's code calls these, never
 * testing its version. A binary action's operands come as the code pops
 * them, the top of the stack, `a`, first: `Subtract` is `b - a`.
 */
export interface Operations {
  readonly version: number;
  /** ConstantPool: the activation's pool from here on, which a frame's later blocks start with. */
  constantPool(cx: Activation, pool: Value[]): void;
  trace(cx: Activation, value: Value): void;
  toBoolean(value: Value): boolean;
  /** ToString, and how every action that takes a string converts a value. */
  toString(value: Value): string;
  /** ToNumber, and how every arithmetic action converts a value. */
  toNumber(value: Value): number;
  /** ToInteger: ToInt32 of the number. */
  toInteger(value: Value): number;
  typeOf(value: Value): string;
  /** SWF 4's Add: numbers, whatever the operands. */
  add(a: Value, b: Value): number;
  add2(a: Value, b: Value): Value;
  subtract(a: Value, b: Value): number;
  multiply(a: Value, b: Value): number;
  /** "#ERROR#" for a division by zero up to SWF 4. */
  divide(a: Value, b: Value): Value;
  modulo(a: Value, b: Value): number;
  increment(a: Value): number;
  decrement(a: Value): number;
  /** SWF 4's Equals: as numbers. */
  equals(a: Value, b: Value): boolean;
  equals2(a: Value, b: Value): boolean;
  strictEquals(a: Value, b: Value): boolean;
  /** SWF 4's Less: as numbers, false for NaN. */
  less(a: Value, b: Value): boolean;
  /** `b < a`: undefined where a number is NaN. */
  less2(a: Value, b: Value): boolean | undefined;
  /** `b > a`: undefined where a number is NaN. */
  greater(a: Value, b: Value): boolean | undefined;
  and(a: Value, b: Value): boolean;
  or(a: Value, b: Value): boolean;
  not(a: Value): boolean;
  bitAnd(a: Value, b: Value): number;
  bitOr(a: Value, b: Value): number;
  bitXor(a: Value, b: Value): number;
  bitLShift(a: Value, b: Value): number;
  bitRShift(a: Value, b: Value): number;
  /** Unsigned, but signed in SWF 8 and 9. */
  bitURShift(a: Value, b: Value): number;
  stringAdd(a: Value, b: Value): string;
  stringEquals(a: Value, b: Value): boolean;
  stringLess(a: Value, b: Value): boolean;
  stringGreater(a: Value, b: Value): boolean;
  stringLength(a: Value): number;
  mbStringLength(a: Value): number;
  /** StringExtract: `count` characters of `s` from the 1-based `index`. */
  stringExtract(count: Value, index: Value, s: Value): string;
  mbStringExtract(count: Value, index: Value, s: Value): string;
  charToAscii(a: Value): number;
  asciiToChar(a: Value): string;
  mbCharToAscii(a: Value): number;
  mbAsciiToChar(a: Value): string;
  /** GetVariable of `name`, a path or not. */
  getVariable(cx: Activation, name: Value): Value;
  setVariable(cx: Activation, value: Value, name: Value): void;
  defineLocal(cx: Activation, value: Value, name: Value): void;
  defineLocal2(cx: Activation, name: Value): void;
  /** `object[name]`. */
  getMember(cx: Activation, name: Value, object: Value): Value;
  setMember(cx: Activation, value: Value, name: Value, object: Value): void;
  /** Delete: whether `object[name]` went. */
  deleteMember(cx: Activation, name: Value, object: Value): boolean;
  /** Delete2: whether the variable went. */
  deleteVariable(cx: Activation, name: Value): boolean;
  /** InitObject and InitArray, which pop their counts and their values themselves. */
  initObject(cx: Activation): void;
  initArray(cx: Activation): void;
  /** Enumerate: a terminator, then the names of the variable's object, the first to visit on top. */
  enumerate(cx: Activation, name: Value): void;
  enumerate2(cx: Activation, object: Value): void;
  /** CallFunction, CallMethod, NewObject and NewMethod, which pop their operands themselves. */
  callFunction(cx: Activation): void;
  callMethod(cx: Activation): void;
  newObject(cx: Activation): void;
  newMethod(cx: Activation): void;
  play(cx: Activation): void;
  stop(cx: Activation): void;
  /** An action Flash cannot read: the SWF stops there. */
  halt(cx: Activation): never;
  /** A block larger than the compiler takes. */
  tooLarge(): never;
  /** An action the runtime does not do yet. */
  notYet(name: string): never;
}

function operations(version: number): Operations {
  /** Whether strings are bytes, up to SWF 5, which the MB actions read as a single-byte locale's. */
  const bytes = version < 6;
  const written = bytes ? bytesAsUtf8 : (text: string) => text;
  const byZero = version < 5 ? () => "#ERROR#" : divideByZero;
  const stringLength = (a: Value) => stringOf(a, version).length;
  const stringExtract = (count: Value, index: Value, s: Value) => {
    const n = toInt32(count, version);
    const i = toInt32(index, version);
    const text = extract(stringOf(s, version), i, n);
    return bytes ? text : wellFormed(text);
  };

  return {
    version,
    constantPool(cx, pool) {
      cx.pool = pool;
    },
    // undefined traces as "undefined" whatever the version, which converts it to "" up to SWF 6;
    // a SWF 5 string's bytes are UTF-8, as Flash's log writes them.
    trace(cx, value) {
      const text = value === undefined ? "undefined" : stringOf(value, version);
      cx.host.trace(written(text));
    },
    toBoolean: (value) => toBoolean(value, version),
    toString: (value) => stringOf(value, version),
    toNumber: (value) => toNumber(value, version),
    toInteger: (value) => toInt32(value, version),
    typeOf,
    add: (a, b) => toNumber(b, version) + toNumber(a, version),
    add2: (a, b) => add2(a, b, version),
    subtract(a, b) {
      const x = toNumber(a, version);
      return toNumber(b, version) - x;
    },
    multiply: (a, b) => toNumber(b, version) * toNumber(a, version),
    divide(a, b) {
      const x = toNumber(a, version);
      const y = toNumber(b, version);
      return x === 0 ? byZero(y) : y / x;
    },
    modulo(a, b) {
      const x = toNumber(a, version);
      return toNumber(b, version) % x;
    },
    increment: (a) => toNumber(a, version) + 1,
    decrement: (a) => toNumber(a, version) - 1,
    equals(a, b) {
      const x = toNumber(a, version);
      return toNumber(b, version) === x;
    },
    equals2: (a, b) => looselyEquals(b, a, version),
    strictEquals: strictlyEquals,
    less(a, b) {
      return toNumber(b, version) < toNumber(a, version);
    },
    less2: (a, b) => lessThan(b, a, version),
    greater: (a, b) => lessThan(a, b, version),
    and(a, b) {
      return toBoolean(b, version) && toBoolean(a, version);
    },
    or(a, b) {
      return toBoolean(b, version) || toBoolean(a, version);
    },
    not: (a) => !toBoolean(a, version),
    bitAnd: (a, b) => toInt32(a, version) & toInt32(b, version),
    bitOr: (a, b) => toInt32(a, version) | toInt32(b, version),
    bitXor: (a, b) => toInt32(a, version) ^ toInt32(b, version),
    bitLShift(a, b) {
      const n = toInt32(a, version);
      return toInt32(b, version) << n;
    },
    bitRShift(a, b) {
      const n = toInt32(a, version);
      return toInt32(b, version) >> n;
    },
    bitURShift:
      version === 8 || version === 9
        ? (a, b) => {
            const n = toInt32(a, version);
            return (toInt32(b, version) >>> n) | 0;
          }
        : (a, b) => {
            const n = toInt32(a, version);
            return toInt32(b, version) >>> n;
          },
    stringAdd(a, b) {
      const x = stringOf(a, version);
      return stringOf(b, version) + x;
    },
    stringEquals(a, b) {
      const x = stringOf(a, version);
      return stringOf(b, version) === x;
    },
    stringLess(a, b) {
      const x = stringOf(a, version);
      const y = stringOf(b, version);
      return bytes && againstHighByte(y, x) ? false : y < x;
    },
    stringGreater(a, b) {
      const x = stringOf(a, version);
      const y = stringOf(b, version);
      return bytes && againstHighByte(y, x) ? true : y > x;
    },
    stringLength,
    mbStringLength: stringLength,
    stringExtract,
    mbStringExtract: stringExtract,
    charToAscii: (a) => firstCode(stringOf(a, version)),
    // Up to SWF 5 a string is bytes: AsciiToChar takes the code's low
    // byte, MBAsciiToChar writes a code past 0xFF as two, high first, and
    // the MB actions read one, as in a single-byte locale such as adl's.
    asciiToChar: bytes
      ? (a) => charOf(toInt32(a, version) & 0xff, false)
      : (a) => charOf(toInt32(a, version) & 0xffff, true),
    mbCharToAscii: bytes
      ? (a) => stringOf(a, version).charCodeAt(0) & 0xff
      : (a) => firstCode(stringOf(a, version)),
    mbAsciiToChar: bytes
      ? (a) => {
          const code = toInt32(a, version) & 0xffff;
          return code > 0xff
            ? charOf(code >> 8, false) + charOf(code & 0xff, false)
            : charOf(code, false);
        }
      : (a) => charOf(toInt32(a, version) & 0xffff, true),
    getVariable: (cx, name) => getVariable(cx, nameOf(name, version), version),
    setVariable(cx, value, name) {
      setVariable(cx, nameOf(name, version), value, version);
    },
    defineLocal(cx, value, name) {
      defineLocal(cx, nameOf(name, version), value, version);
    },
    defineLocal2(cx, name) {
      defineLocal2(cx, nameOf(name, version), version);
    },
    getMember(cx, name, object) {
      const key = nameOf(name, version);
      if (object instanceof Avm1Object) {
        return get(object, key, version);
      }

      return object === undefined || object === null
        ? undefined
        : cx.realm.primitiveMember(object as Primitive, key, version);
    },
    setMember(cx, value, name, object) {
      const key = nameOf(name, version);
      if (object instanceof Avm1Object) {
        set(object, key, value, version);
      } else if (object !== undefined && object !== null) {
        set(cx.realm.box(object, version), key, value, version);
      }
    },
    deleteMember(_, name, object) {
      const key = nameOf(name, version);
      return object instanceof Avm1Object && removeOwn(object, key, version);
    },
    deleteVariable: (cx, name) => deleteVariable(cx, nameOf(name, version), version),
    initObject(cx) {
      const st = cx.st;
      const n = countOf(st.pop(), version);
      if (n < 0) {
        st.push(undefined);
        return;
      }

      // Pairs past the stack's are all undefined, which set the same name each time: one does.
      const object = cx.realm.newObject(version);
      const pairs = Math.min(n, (st.length >> 1) + 2);
      for (let i = 0; i < pairs; i++) {
        const value = st.pop();
        set(object, nameOf(st.pop(), version), value, version);
      }

      st.push(object);
    },
    initArray(cx) {
      const st = cx.st;
      const n = countOf(st.pop(), version);
      if (n < 0) {
        st.push(undefined);
        return;
      }

      // Past the stack's values, undefined ones; a count far past it is cut short, as no
      // compiler writes one and Flash would make billions of elements.
      const count = Math.min(n, st.length + 0x10000);
      const elements: Value[] = new Array(count);
      for (let i = 0; i < count; i++) {
        elements[i] = st.pop();
      }

      st.push(cx.realm.newArray(elements, version));
    },
    enumerate(cx, name) {
      enumerate(cx, getVariable(cx, nameOf(name, version), version), version);
    },
    enumerate2(cx, object) {
      enumerate(cx, object, version);
    },
    callFunction(cx) {
      const st = cx.st;
      const name = nameOf(st.pop(), version);
      const args = popArgs(st, version);
      const fn = resolveCallable(cx, name, version);
      st.push(invoke(fn, foundOn === undefined ? cx.clip : foundOn, args, version));
    },
    callMethod(cx) {
      const st = cx.st;
      const name = st.pop();
      const object = st.pop();
      const args = popArgs(st, version);
      if (object === undefined || object === null) {
        st.push(undefined);
        return;
      }

      const key = name === undefined ? "" : nameOf(name, version);
      if (key === "") {
        st.push(invoke(object, undefined, args, version));
        return;
      }

      const method =
        object instanceof Avm1Object
          ? get(object, key, version)
          : cx.realm.primitiveMember(object as Primitive, key, version);
      st.push(invoke(method, object, args, version));
    },
    newObject(cx) {
      const st = cx.st;
      const name = nameOf(st.pop(), version);
      const args = popArgs(st, version);
      st.push(cx.realm.construct(resolve(cx, name, version), args, version));
    },
    newMethod(cx) {
      const st = cx.st;
      const name = st.pop();
      const object = st.pop();
      const args = popArgs(st, version);
      if (object === undefined || object === null) {
        st.push(undefined);
        return;
      }

      const key = name === undefined ? "" : nameOf(name, version);
      const boxed = cx.realm.box(object, version);
      const constr = key === "" ? boxed : get(boxed, key, version);
      st.push(cx.realm.construct(constr, args, version));
    },
    play(cx) {
      cx.host.play(cx.target);
    },
    stop(cx) {
      cx.host.stop(cx.target);
    },
    halt(cx) {
      cx.host.halt();
      throw new Halt("the SWF stopped at an action Flash cannot read");
    },
    tooLarge() {
      throw new Error("an AVM1 block too large to compile");
    },
    notYet(name) {
      throw new NotYet(name);
    },
  };
}

/**
 * Whether one of two SWF 5 strings is empty and the other starts with a
 * byte from 0x80: adl's StringLess has neither less than the other, and
 * its StringGreater each greater.
 */
function againstHighByte(x: string, y: string): boolean {
  return (x === "" && y.charCodeAt(0) >= 0x80) || (y === "" && x.charCodeAt(0) >= 0x80);
}

/**
 * A division by zero from SWF 5, whose sign the zero does not change, as
 * adl divides: 1 / -0 is Infinity.
 */
function divideByZero(n: number): number {
  if (n > 0) {
    return Number.POSITIVE_INFINITY;
  }

  return n < 0 ? Number.NEGATIVE_INFINITY : Number.NaN;
}

// The web's and node's alike, though not ECMAScript's.
declare const TextEncoder: new () => { encode(s: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options: { ignoreBOM: boolean },
) => { decode(bytes: Uint8Array): string };

/** Text that is the same as bytes and as UTF-8, as most is. */
const ascii = /^[ -~\t\n\r]*$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * A SWF 5 string, its bytes, as Flash's log writes it: read as UTF-8, what
 * is not UTF-8 as U+FFFD, as the encoding standard's decoder has it (adl's
 * replacements agree). A character past a byte, from code of a later
 * version, is its UTF-8.
 */
function bytesAsUtf8(text: string): string {
  if (ascii.test(text)) {
    return text;
  }

  const bytes: number[] = [];
  for (const c of text) {
    const code = c.codePointAt(0) as number;
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...encoder.encode(c));
    }
  }

  return decoder.decode(new Uint8Array(bytes));
}

/** InitObject's and InitArray's count: truncated, then -1 where it is not an int from 0 (adl). */
function countOf(value: Value, version: number): number {
  const n = Math.trunc(toNumber(value, version));
  return n >= 0 && n <= 0x7fffffff ? n : -1;
}

/**
 * A call's arguments, their count on top and the first argument under it:
 * as many as the stack has, the count taken as a u32.
 */
function popArgs(st: Value[], version: number): Value[] {
  const n = Math.min(toNumber(st.pop(), version) >>> 0, st.length);
  const args: Value[] = new Array(n);
  for (let i = 0; i < n; i++) {
    args[i] = st.pop();
  }

  return args;
}

/** Enumerate's and Enumerate2's pushes: a terminator, then the names, the first to visit on top. */
function enumerate(cx: Activation, object: Value, version: number): void {
  const st = cx.st;
  st.push(undefined);
  if (object instanceof Avm1Object) {
    const names = keys(object, version);
    for (let i = names.length - 1; i >= 0; i--) {
      st.push(names[i]);
    }
  }
}

/** The operations of each version asked for, made once and shared by every runtime. */
const versions = new Map<number, Operations>();

/** A player's AVM1 runtime, which its SWFs' modules are loaded into. */
export class Runtime {
  /** The builtins and `_global`, which every SWF the player runs shares. */
  readonly realm = new Realm();

  /** A new object, as `{}` makes one: what the player gives a clip until clips have their class. */
  newObject(): Avm1Object {
    return new Avm1Object(this.realm.objectProto);
  }

  /**
   * An activation of a timeline's code: `clip`, the target's AVM1 object,
   * above `_global` on the scope chain, and `this`.
   */
  activation(st: Value[], pool: Value[], target: Target, clip: Avm1Object, host: Host): Activation {
    const global = new Scope(null, SCOPE_Global, this.realm.global);
    return new Activation(
      st,
      pool,
      target,
      host,
      this.realm,
      new Scope(global, SCOPE_Target, clip),
      clip,
      clip,
    );
  }

  /** The operations of SWF version `version`. */
  version(version: number): Operations {
    let ops = versions.get(version);
    if (!ops) {
      ops = operations(version);
      versions.set(version, ops);
    }

    return ops;
  }
}
