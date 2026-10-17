// What a SWF's AVM1 module calls (docs/avm1.md, "Compiling"): its factory
// takes the runtime, asks it for the operations of the SWF's version,
// `V`, once, and each region of each block takes its activation, `cx`.
import { Activation, type Blocks, type Region } from "./activation.js";
import {
  callFrame,
  cloneSprite,
  frameLoaded,
  frameLoaded2,
  getProperty,
  gotoFrame,
  gotoFrame2,
  gotoLabel,
  nextFrame,
  prevFrame,
  removeSprite,
  setProperty,
  setTarget,
  setTarget2,
  startDrag,
  targetPathOf,
} from "./clips.js";
import { caught, enterTry, enterWith, leave, returned, scopes } from "./control.js";
import { Avm1Throw, BASE_REMOVED, Disabled, Halt, NotYet, TimedOut } from "./errors.js";
import { Avm1Super, argumentsOf, ScriptFunction, superOf } from "./functions.js";
import type { Host, Target } from "./host.js";
import { extend, implementsOp, instanceOf } from "./inheritance.js";
import {
  Avm1Function,
  Avm1Object,
  foundDepth,
  get,
  invoke,
  keys,
  nameOf,
  READ_ONLY,
  removeOwn,
  set,
  VERSION_BITS,
} from "./objects.js";
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
import { BUDGET, Realm } from "./realm.js";
import {
  defineLocal,
  defineLocal2,
  deleteVariable,
  foundLocal,
  foundOn,
  getVariable,
  resolve,
  resolveCallable,
  SCOPE_Target,
  Scope,
  setVariable,
} from "./scope.js";
import { getUrl, getUrl2 } from "./urls.js";
import {
  isPrimitive,
  type Primitive,
  stringOf,
  toBoolean,
  toNumber,
  typeOf,
  type Value,
} from "./values.js";

export { Activation, Avm1Throw, type Blocks, Disabled, Halt, NotYet, type Region, TimedOut };

/** The most timers a pass fires, as Ruffle's MAX_TICKS: a timer far behind catches up over frames. */
const MAX_TICKS = 10;

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
  /**
   * DefineFunction: the function of region `region` of the activation's
   * block, defined as a local variable, or pushed where it has no name;
   * `params` its parameters' names.
   */
  defineFunction(cx: Activation, region: number, name: Value, params: string[]): void;
  /** DefineFunction2: as DefineFunction, null for a parameter in a register, and its flags. */
  defineFunction2(
    cx: Activation,
    region: number,
    name: Value,
    params: (string | null)[],
    flags: number,
  ): void;
  /** Extends: the subclass's `prototype` made one whose prototype is the superclass's. */
  extends(cx: Activation, superclass: Value, subclass: Value): void;
  /** InstanceOf: `object instanceof constr`. */
  instanceOf(cx: Activation, constr: Value, object: Value): boolean;
  /** CastOp: the object where it is an instance of the constructor, else null. */
  castOp(cx: Activation, object: Value, constr: Value): Value;
  /** ImplementsOp, which pops its operands itself. */
  implementsOp(cx: Activation): void;
  /** RandomNumber: an int from 0 below `max`, 0 for a max below 1. */
  randomNumber(max: Value): number;
  /** What DefineFunction2 preloads: its `arguments`, its `super`, `_root` and `_parent`, undefined for none. */
  argumentsOf(cx: Activation, args: Value[]): Value;
  superOf(cx: Activation, self: Value): Value;
  root(cx: Activation): Value;
  parentOf(cx: Activation): Value;
  /**
   * With: `object` on the scope chain over the blocks of its body, from
   * `from` to `to`; false where the body is skipped.
   */
  with(cx: Activation, object: Value, from: number, to: number): boolean;
  /**
   * Try: its handlers over its try and catch bodies, the blocks from
   * `from` to `finallyFrom`, the catch's from `catchFrom`; a throw lands at
   * block `catchAt` (-1 for the exit, -2 for no catch), its value into the
   * variable or the register `into`, or at the finally's blocks, from
   * `finallyFrom` to `finallyTo`.
   */
  try(
    cx: Activation,
    from: number,
    catchFrom: number,
    finallyFrom: number,
    finallyTo: number,
    catchAt: number,
    into: string | number,
  ): void;
  throw(value: Value): never;
  /**
   * Where control goes after `error` was thrown in block `at`: a block, -1
   * for the exit; a register catch's value is `cx.thrown`, into `cx.into`.
   */
  caught(cx: Activation, error: unknown, at: number): number;
  /**
   * Where control goes on its way to block `to` (-1: the exit) out of a
   * Try's, a finally's or a scope's body.
   */
  leave(cx: Activation, to: number): number;
  /** After the first action of block `at`, reached from a body: the scopes that do not hold over it come off. */
  scopes(cx: Activation, at: number): void;
  /** Return of the value on top of the stack: where control goes first, a finally's block, or -1 to return `cx.ret`. */
  ret(cx: Activation): number;
  play(cx: Activation): void;
  stop(cx: Activation): void;
  /** SetTarget: the clip `name` names the target, "" the code's own. */
  setTarget(cx: Activation, name: string): void;
  setTarget2(cx: Activation, target: Value): void;
  /** GetProperty: property `index` of the clip `path` names. */
  getProperty(cx: Activation, index: Value, path: Value): Value;
  setProperty(cx: Activation, value: Value, index: Value, path: Value): void;
  /** GotoFrame: frame `frame`, 0 the first, of the target. */
  gotoFrame(cx: Activation, frame: number): void;
  gotoLabel(cx: Activation, label: string): void;
  /** GotoFrame2: the frame the value names, `bias` frames on, played or stopped. */
  gotoFrame2(cx: Activation, frame: Value, play: boolean, bias: number): void;
  nextFrame(cx: Activation): void;
  prevFrame(cx: Activation): void;
  /** WaitForFrame: whether frame `frame`, 0 the first, is loaded. */
  frameLoaded(cx: Activation, frame: number): boolean;
  /** WaitForFrame2: whether the frame the value names, 1 the first, is loaded. */
  frameLoaded2(cx: Activation, frame: Value): boolean;
  /** TargetPath: a clip's path, undefined for anything else. */
  targetPath(cx: Activation, value: Value): Value;
  /** CallFrame: the actions of the frame the value names run now. */
  callFrame(cx: Activation, frame: Value): void;
  stopSounds(cx: Activation): void;
  toggleQuality(cx: Activation): void;
  /** GetTime: ms since the movie started, on the player's clock. */
  getTime(cx: Activation): number;
  /** CloneSprite: the clip `source` names duplicated as `name` at timeline depth `depth`. */
  cloneSprite(cx: Activation, depth: Value, name: Value, source: Value): void;
  /** RemoveSprite: the clip `target` names removed, where a script may remove it. */
  removeSprite(cx: Activation, target: Value): void;
  /** StartDrag: the clip on the stack dragged, its lock and bounds below it. */
  startDrag(cx: Activation): void;
  /** EndDrag: the drag ends. */
  stopDrag(cx: Activation): void;
  /** GetURL: fscommand, a load into a level, or a page to open. */
  getUrl(cx: Activation, url: string, target: string): void;
  /** GetURL2 of the target and the URL on the stack, the target on top, by its flags. */
  getUrl2(cx: Activation, target: Value, url: Value, flags: number): void;
  /**
   * What a jump back counts down, shared by every activation of the
   * version: as it runs out, `timeout` reads the clock.
   */
  budget: number;
  /** The budget ran out: past the script timeout, the movie's actions are disabled. */
  timeout(cx: Activation): void;
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
  // Flash's log writes half a surrogate pair as U+FFFD (adl a low half followed by more as three).
  const written = bytes ? bytesAsUtf8 : wellFormed;
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
    // A toString that throws gives what an object without one does, and
    // the value is thrown once the trace is written (adl).
    trace(cx, value) {
      let text: string;
      try {
        text = value === undefined ? "undefined" : stringOf(value, version);
      } catch (error) {
        if (!(error instanceof Avm1Throw)) {
          throw error;
        }

        cx.host.trace(value instanceof Avm1Function ? "[type Function]" : "[type Object]");
        throw error;
      }

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
    // A SWF 4's variables hold no display objects (Ruffle's as_swf4_variable).
    getVariable:
      version <= 4
        ? (cx, name) => {
            const value = getVariable(cx, nameOf(name, version), version);
            return value instanceof Avm1Object && value.display !== null ? undefined : value;
          }
        : (cx, name) => getVariable(cx, nameOf(name, version), version),
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
      // An array's element by its number, as loops read them: no name made.
      if (typeof name === "number" && object instanceof Avm1Object && object.elems !== null) {
        const p = name >= 0 && name < object.elems.length ? object.elems[name] : undefined;
        if (p !== undefined && p.get === null && (p.flags & VERSION_BITS) === 0) {
          return p.value;
        }
      }

      const key = nameOf(name, version);
      if (object instanceof Avm1Super) {
        return get(object, key, version, object.self);
      }

      if (object instanceof Avm1Object) {
        const live = object.display === null ? object : object.display.live();
        return live === null ? undefined : get(live, key, version);
      }

      return object === undefined || object === null
        ? undefined
        : cx.realm.primitiveMember(object as Primitive, key, version);
    },
    setMember(cx, value, name, object) {
      if (
        typeof name === "number" &&
        object instanceof Avm1Object &&
        object.elems !== null &&
        object.watchers === null
      ) {
        const p = name >= 0 && name < object.elems.length ? object.elems[name] : undefined;
        if (p !== undefined && p.get === null && (p.flags & (READ_ONLY | VERSION_BITS)) === 0) {
          p.value = value;
          return;
        }
      }

      const key = nameOf(name, version);
      if (object instanceof Avm1Super) {
        set(object.self, key, value, version);
      } else if (object instanceof Avm1Object) {
        const live = object.display === null ? object : object.display.live();
        if (live !== null) {
          set(live, key, value, version);
        }
      } else if (object !== undefined && object !== null) {
        set(cx.realm.box(object, version), key, value, version);
      }
    },
    deleteMember(_, name, object) {
      const key = nameOf(name, version);
      const o = live(object);
      return o instanceof Avm1Object && removeOwn(o, key, version);
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
      enumerate(cx, live(object), version);
    },
    callFunction(cx) {
      const st = cx.st;
      const name = nameOf(st.pop(), version);
      const args = popArgs(st, version);
      const fn = resolveCallable(cx, name, version);
      // `this` is what had the name, a function's activation object too,
      // but in a SWF 5, which takes the target's clip for it (adl).
      const self = foundOn === undefined || (version < 6 && foundLocal) ? cx.clip : foundOn;
      // `super(...)` called by name runs the class above's constructor, as CallMethod of it does.
      st.push(
        fn instanceof Avm1Super
          ? superCall(fn, "", args, version)
          : invoke(fn, self, args, version),
      );
      if (fn instanceof ScriptFunction) {
        cx.host.returned?.();
      }

      returnIfRemoved(cx);
    },
    callMethod(cx) {
      // A method of undefined or null is no call: its code goes on (Ruffle).
      if (callMethod(cx, version)) {
        returnIfRemoved(cx);
      }
    },
    newObject(cx) {
      const st = cx.st;
      const name = nameOf(st.pop(), version);
      const args = popArgs(st, version);
      st.push(cx.realm.construct(resolve(cx, name, version), args, version));
      returnIfRemoved(cx);
    },
    newMethod(cx) {
      if (newMethod(cx, version)) {
        returnIfRemoved(cx);
      }
    },
    defineFunction(cx, region, name, params) {
      defineFunction(cx, region, name, params, 0, version);
    },
    defineFunction2(cx, region, name, params, flags) {
      defineFunction(cx, region, name, params, flags, version);
    },
    extends(cx, superclass, subclass) {
      extend(cx, superclass, subclass, version);
    },
    instanceOf: (cx, constr, object) => instanceOf(cx.realm, object, constr, version),
    castOp(cx, object, constr) {
      // Flash boxes a primitive first, for nothing: a class replaced on _global sees it.
      if (object !== undefined && object !== null && isPrimitive(object)) {
        cx.realm.box(object, version);
      }

      return instanceOf(cx.realm, object, constr, version) ? object : null;
    },
    implementsOp(cx) {
      implementsOp(cx, version);
    },
    randomNumber(max) {
      // Rust's cast of the max: saturated, NaN 0.
      const n = toNumber(max, version);
      const m = Number.isNaN(n) ? 0 : Math.trunc(Math.min(Math.max(n, -2147483648), 2147483647));
      return m > 0 ? Math.floor(Math.random() * 0x80000000) % m : 0;
    },
    argumentsOf: (cx, args) => argumentsOf(cx, args, version),
    superOf: (cx, self) => superOf(cx, self, version),
    root: (cx) => cx.host.root?.(),
    parentOf: (cx) => cx.host.parent?.(cx.clip),
    with: (cx, object, from, to) => enterWith(cx, object, from, to, version),
    try: enterTry,
    throw(value) {
      throw new Avm1Throw(value);
    },
    caught,
    leave,
    scopes,
    ret: returned,
    play(cx) {
      if (cx.target !== null) {
        cx.host.play(cx.target);
      }
    },
    stop(cx) {
      if (cx.target !== null) {
        cx.host.stop(cx.target);
      }
    },
    setTarget(cx, name) {
      setTarget(cx, name, version);
    },
    setTarget2(cx, target) {
      setTarget2(cx, target, version);
    },
    getProperty: (cx, index, path) => getProperty(cx, index, path, version),
    setProperty(cx, value, index, path) {
      setProperty(cx, value, index, path, version);
    },
    gotoFrame,
    gotoLabel,
    gotoFrame2(cx, frame, play, bias) {
      gotoFrame2(cx, frame, play, bias, version);
    },
    nextFrame,
    prevFrame,
    frameLoaded: (_, frame) => frameLoaded(frame),
    frameLoaded2: (_, frame) => frameLoaded2(frame, version),
    targetPath: (_, value) => targetPathOf(value),
    callFrame(cx, frame) {
      callFrame(cx, frame, version);
      returnIfRemoved(cx);
    },
    stopSounds(cx) {
      cx.host.stopSounds?.();
    },
    toggleQuality(cx) {
      cx.host.toggleQuality?.();
    },
    getTime: (cx) => cx.host.time?.() ?? 0,
    cloneSprite(cx, depth, name, source) {
      cloneSprite(cx, depth, name, source, version);
    },
    removeSprite(cx, target) {
      removeSprite(cx, target, version);
    },
    startDrag(cx) {
      startDrag(cx, version);
    },
    stopDrag(cx) {
      cx.host.stopDrag?.();
    },
    getUrl,
    getUrl2(cx, target, url, flags) {
      getUrl2(cx, target, url, flags, version);
    },
    budget: BUDGET,
    timeout(cx) {
      this.budget = BUDGET;
      cx.realm.timeout();
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
 * CallMethod, which pops its operands and pushes what the method gives:
 * false where there was no object to call it on.
 */
function callMethod(cx: Activation, version: number): boolean {
  const st = cx.st;
  const name = st.pop();
  const object = live(st.pop());
  const args = popArgs(st, version);
  if (object === undefined || object === null) {
    st.push(undefined);
    return false;
  }

  const key = name === undefined ? "" : nameOf(name, version);
  if (object instanceof Avm1Super) {
    st.push(superCall(object, key, args, version));
  } else if (key === "") {
    st.push(invoke(object, undefined, args, version));
  } else if (!(object instanceof Avm1Object)) {
    const method = cx.realm.primitiveMember(object as Primitive, key, version);
    st.push(invoke(method, object, args, version, 1));
  } else {
    // A method found on the object itself is called as if found on its
    // prototype; up to SWF 6 wherever it was found (adl).
    const method = get(object, key, version);
    st.push(invoke(method, object, args, version, version < 7 ? 1 : Math.max(foundDepth, 1)));
    if (method instanceof ScriptFunction) {
      cx.host.returned?.();
    }
  }

  return true;
}

/** NewMethod: `new object[name](args)`, `new object(args)` for an empty name; false for no object. */
function newMethod(cx: Activation, version: number): boolean {
  const st = cx.st;
  const name = st.pop();
  const object = st.pop();
  const args = popArgs(st, version);
  if (object === undefined || object === null) {
    st.push(undefined);
    return false;
  }

  const key = name === undefined ? "" : nameOf(name, version);
  const boxed = cx.realm.box(object, version);
  const constr = key === "" ? boxed : get(boxed, key, version);
  st.push(cx.realm.construct(constr, args, version));
  return true;
}

/**
 * After a call: where it removed the clip whose code made it, that code
 * returns, as Flash's does. The clip is looked at only where a clip was
 * removed since the code last looked.
 */
function returnIfRemoved(cx: Activation): void {
  const removals = cx.realm.removals;
  if (removals !== cx.removals) {
    cx.removals = removals;
    if (cx.host.removed?.(cx.base)) {
      throw BASE_REMOVED;
    }
  }
}

/** A value as a reference reaches it now: a clip's AVM1 object the one at its path, undefined for none. */
function live(value: Value): Value {
  if (value instanceof Avm1Object && value.display !== null) {
    return value.display.live() ?? undefined;
  }

  return value;
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

function defineFunction(
  cx: Activation,
  region: number,
  name: Value,
  params: (string | null)[],
  flags: number,
  version: number,
): void {
  const fn = cx.realm.newFunction(cx, cx.code[region], params, flags, version);
  const key = nameOf(name, version);
  if (key === "") {
    cx.st.push(fn);
    return;
  }

  // A SWF 5 function's named function is its clip's, not a local variable (adl).
  if (version < 6 && cx.callee !== null) {
    let s: Scope | null = cx.scope;
    while (s !== null && s.kind !== SCOPE_Target) {
      s = s.parent;
    }

    if (s !== null) {
      set(s.object, key, fn, version);
      return;
    }
  }

  defineLocal(cx, key, fn, version);
}

/**
 * CallMethod of `super`: `super()` its prototype's `__constructor__` on
 * `this`, `super.name()` the method above the one running, with its `this`.
 */
function superCall(zuper: Avm1Super, key: string, args: Value[], version: number): Value {
  if (key === "") {
    let base: Value = zuper.self;
    for (let i = 0; i < zuper.depth && base instanceof Avm1Object; i++) {
      base = base.protoFor(version);
    }

    if (!(base instanceof Avm1Object)) {
      return undefined;
    }

    const constr = get(base, "__constructor__", version, base, false);
    if (constr instanceof Avm1Function) {
      return constr.callConstructor(zuper.self, args, version, zuper.depth + 1);
    }

    return undefined;
  }

  const proto = zuper.proto;
  if (!(proto instanceof Avm1Object)) {
    return undefined;
  }

  const method = get(proto, key, version, zuper.self);
  // Up to SWF 6 the method's `super` is one above this one's, wherever it was found (adl).
  const depth = zuper.depth + (version < 7 ? 0 : foundDepth) + 1;
  return invoke(method, zuper.self, args, version, depth);
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

/**
 * Whether `error` is the engine's own stack running out: V8's and
 * JavaScriptCore's RangeError, SpiderMonkey's InternalError. Any other
 * RangeError, such as a string grown past the engine's longest, is an
 * error like the rest.
 */
function stackOverflow(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "RangeError" || error.name === "InternalError") &&
    /call stack|recursion/i.test(error.message)
  );
}

/** The operations of each version asked for, made once and shared by every runtime. */
const versions = new Map<number, Operations>();

/** A player's AVM1 runtime, which its SWFs' modules are loaded into. */
export class Runtime {
  /** The builtins and `_global`, which every SWF the player runs shares. */
  readonly realm = new Realm();
  /**
   * Whether the movie's actions are disabled, as Flash disables them past
   * its recursion limit: no action of it runs again, its timelines play on.
   */
  disabled = false;
  /** Whether that was the script timeout's doing. */
  timedOut = false;

  /** How deep function calls may go: a SWF's ScriptLimits sets it (Flash's default 1000, adl's). */
  get maxRecursion(): number {
    return this.realm.maxCalls;
  }

  set maxRecursion(depth: number) {
    this.realm.maxCalls = depth;
  }

  /**
   * How long, in seconds, a frame's actions may run before Flash offers to
   * stop them: a SWF's ScriptLimits sets it (Flash's default 15). Past
   * it, the movie's actions are disabled, as Flash's are once stopped.
   */
  get scriptTimeout(): number {
    return this.timeout;
  }

  /**
   * Set while scripts run, as a ScriptLimits their gotos reach is, it
   * counts from when they began, not from now: gotos that enter its
   * frame again and again still run into it.
   */
  set scriptTimeout(seconds: number) {
    this.timeout = seconds;
    if (this.realm.deadline !== Number.POSITIVE_INFINITY) {
      this.realm.deadline = this.began + seconds * 1000;
    }
  }

  private timeout = 15;
  /** When the scripts running began, on the player's clock. */
  private began = 0;

  /**
   * The player starts running scripts, a frame's or its timers', at `now`
   * on its clock, `clock`: they have the script timeout from there.
   */
  begin(now: number, clock: () => number): void {
    this.began = now;
    this.realm.clock = clock;
    this.realm.deadline = now + this.timeout * 1000;
  }

  /** The player's scripts are done until it begins again. */
  end(): void {
    this.realm.deadline = Number.POSITIVE_INFINITY;
  }

  /**
   * Run a block's own region, `regions[0]`, in `cx`. A value thrown and
   * not caught ends the block, as Flash ends it, writing nothing. Past the
   * recursion limit or the script timeout, or where JavaScript's own stack
   * runs out first, the movie's actions are disabled from there.
   */
  run(regions: Region[], cx: Activation): void {
    if (regions.length === 0) {
      return;
    }

    cx.code = regions;
    this.call(cx, () => regions[0](cx));
  }

  /**
   * Run `body` in `cx`, as a block runs: what the player calls into AVM1
   * other than a block, an event's method, a class's constructor, a
   * timer's callback, which the limits and an uncaught throw end alike.
   */
  call(cx: Activation, body: () => void): void {
    if (this.disabled) {
      return;
    }

    // The block is a level of the limit itself: a depth of 1 or 0 runs nothing (adl).
    const realm = this.realm;
    if (realm.maxCalls <= 1) {
      this.disabled = true;
      return;
    }

    const outer = realm.current;
    const calls = realm.calls;
    realm.current = cx;
    try {
      body();
    } catch (error) {
      if (error instanceof Avm1Throw || error === BASE_REMOVED) {
        return;
      }

      if (!(error instanceof Disabled || stackOverflow(error))) {
        throw error;
      }

      this.disabled = true;
      this.timedOut ||= error instanceof TimedOut;
    } finally {
      realm.current = outer;
      realm.calls = calls;
    }
  }

  /**
   * `object`'s method `name` called with `args`, as Flash calls an event's
   * (`onEnterFrame`...) and a timer's: found without `__resolve`, nothing
   * where it is no function.
   */
  callMethod(
    cx: Activation,
    object: Avm1Object,
    name: string,
    args: Value[],
    version: number,
  ): void {
    this.call(cx, () => {
      const method = get(object, name, version, object, false);
      invoke(method, object, args, version, Math.max(foundDepth, 1));
    });
  }

  /**
   * Fire the timers due by `time` on the player's clock, the earliest
   * first, at most `MAX_TICKS` of them, each in the activation `cx` gives
   * (the root's), `after` running what each queued; while one runs, the
   * clock reads its time.
   */
  fireTimers(
    time: number,
    version: number,
    cx: () => Activation | null,
    after: () => void,
    removed: (object: Avm1Object) => boolean,
  ): void {
    const timers = this.realm.timers;
    for (let ticks = 0; ticks < MAX_TICKS && !this.disabled; ticks++) {
      const timer = timers.due(time);
      if (timer === null) {
        break;
      }

      timers.now = timer.due;
      timers.fired(timer);
      // A method's object a removed clip: the timer stops, as Ruffle has it.
      if (timer.method !== null && removed(timer.callback)) {
        timers.remove(timer.id);
        continue;
      }

      const activation = cx();
      if (activation !== null) {
        if (timer.method === null) {
          this.call(activation, () => {
            invoke(timer.callback, undefined, timer.args, version);
          });
        } else {
          this.callMethod(activation, timer.callback, timer.method, timer.args, version);
        }
      }

      after();
    }

    timers.now = time;
  }

  /** A new object, as `{}` makes one: what the player gives a clip until clips have their class. */
  newObject(): Avm1Object {
    return new Avm1Object(this.realm.objectProto);
  }

  /**
   * An activation of a timeline's code: `clip`, the target's AVM1 object,
   * above `_global` on the scope chain, and `this`.
   */
  activation(st: Value[], pool: Value[], target: Target, clip: Avm1Object, host: Host): Activation {
    return new Activation(
      st,
      pool,
      target,
      host,
      this.realm,
      new Scope(this.realm.globalScope, SCOPE_Target, clip),
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
