// AVM1's own functions, those DefineFunction and DefineFunction2 make, and
// what calling them takes, as Ruffle's (https://github.com/ruffle-rs/ruffle)
// core/src/avm1/function.rs and object/super_object.rs have them: MIT OR
// Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// Where adl parts from Ruffle, adl decides (docs/avm1.md, "Functions and
// registers").
//
// A function's code is a region of its block's compiled entry, which
// takes the activation, `this` and the arguments; a DefineFunction2's
// registers are the region's own `let`s, which it loads itself. What
// the call needs of the runtime is here: an activation object for its
// local variables, its parameters without a register among them, and
// `arguments` and `super`, made only if the code asks for them.
import { Activation, PENDING_Arguments, PENDING_Super, type Region } from "./activation.js";
import { targetOrRoot } from "./clips.js";
import { Disabled } from "./errors.js";
import type { Target } from "./host.js";
import { Avm1Function, Avm1Object, DONT_ENUM, fold, type Property } from "./objects.js";
import type { Realm } from "./realm.js";
import { SCOPE_Local, SCOPE_Target, Scope } from "./scope.js";
import { isPrimitive, type Value } from "./values.js";

// DefineFunction2's flags (the SWF's FunctionFlags).
export const FUNCTION_PreloadThis = 0x001;
export const FUNCTION_SuppressThis = 0x002;
export const FUNCTION_PreloadArguments = 0x004;
export const FUNCTION_SuppressArguments = 0x008;
export const FUNCTION_PreloadSuper = 0x010;
export const FUNCTION_SuppressSuper = 0x020;

/** A DefineFunction or DefineFunction2's function. */
export class ScriptFunction extends Avm1Function {
  constructor(
    proto: Value,
    readonly world: Realm,
    /** The region of its body. */
    readonly region: Region,
    /** Its block's regions, which DefineFunction in its body makes functions of. */
    readonly code: Region[],
    /** Its parameters' names, null for those in a register. */
    readonly params: (string | null)[],
    /** DefineFunction2's flags, 0 for a DefineFunction. */
    readonly flags: number,
    /** The version of the SWF that defined it. */
    readonly version: number,
    /** The scope chain it was defined in, which it closes over from SWF 6. */
    readonly scope: Scope,
    /** The constant pool of the activation that defined it, as it was then. */
    readonly pool: Value[],
    /** The clip whose code defined it, its activation's base clip, its target from SWF 6. */
    readonly target: Target,
    readonly clip: Avm1Object,
    /**
     * The `this` of the activation that defined it, which is its own where
     * DefineFunction2 preloads or suppresses `this`; undefined from SWF 5,
     * whose functions close over nothing (adl; Ruffle takes the caller's).
     */
    readonly definer: Value,
  ) {
    super(proto, world, notNative);
  }

  /**
   * Run its body with `self` as `this`, `depth` how far up `this`'s
   * prototypes it was found (which `super` starts from), in an activation
   * of its own above the scope it closes over, or from SWF 5 above the
   * clip of `this` or of the caller's target, as Flash 5 ran functions.
   */
  override call(self: Value, args: Value[], version: number, depth = 0): Value {
    const realm = this.world;
    const caller = realm.current;
    if (caller === null) {
      throw new Error("an AVM1 function called outside of AVM1 code");
    }

    if (realm.calls + 1 >= realm.maxCalls) {
      throw new Disabled(`${realm.maxCalls} levels of recursion were exceeded`);
    }

    if (self !== undefined && self !== null && isPrimitive(self)) {
      self = realm.box(self, version);
    }

    let scope = this.scope;
    let target = this.target;
    let clip = this.clip;
    if (this.version < 6) {
      const own = self instanceof Avm1Object ? caller.host.clipOf?.(self) : undefined;
      if (own !== undefined) {
        target = own;
        clip = self as Avm1Object;
      } else {
        target = targetOrRoot(caller);
        clip = caller.clip;
      }

      scope = new Scope(realm.globalScope, SCOPE_Target, clip);
    }

    const flags = this.flags;
    const local = new Avm1Object();
    const inherited = (flags & (FUNCTION_PreloadThis | FUNCTION_SuppressThis)) !== 0;
    const cx = new Activation(
      caller.st,
      this.pool,
      target,
      caller.host,
      realm,
      // adl counts a SWF 5 function's chain as a timeline's, for the With's limit.
      new Scope(scope, SCOPE_Local, local, this.version < 6 ? scope.depth : scope.depth + 1),
      inherited ? this.definer : self,
      clip,
    );
    cx.code = this.code;
    cx.callee = this;
    cx.caller = caller.callee;
    cx.args = args;
    cx.depth = depth;
    cx.receiver = self;

    const params = this.params;
    for (let i = 0; i < params.length; i++) {
      const name = params[i];
      if (name !== null) {
        defineParam(local, name, i < args.length ? args[i] : undefined, this.version);
      }
    }

    let pending = 0;
    if ((flags & (FUNCTION_PreloadArguments | FUNCTION_SuppressArguments)) === 0) {
      pending |= PENDING_Arguments;
    }

    if (
      (flags & (FUNCTION_PreloadSuper | FUNCTION_SuppressSuper)) === 0 &&
      depth > 0 &&
      this.version >= 6 &&
      self instanceof Avm1Object
    ) {
      pending |= PENDING_Super;
    }

    if (pending !== 0) {
      cx.pending = pending;
      local.lazy = cx;
    }

    realm.calls++;
    realm.current = cx;
    try {
      return this.region(cx, self, args);
    } finally {
      realm.calls--;
      realm.current = caller;
    }
  }

  /** As a constructor: its result is the object `new` made, whatever the body returns. */
  override initialize(self: Avm1Object, args: Value[], version: number): void {
    this.call(self, args, version, 1);
  }

  override callConstructor(self: Avm1Object, args: Value[], version: number, depth: number): Value {
    return this.call(self, args, version, depth);
  }
}

function notNative(): Value {
  return undefined;
}

/** A parameter as a local variable; of two of the same name, the later. */
function defineParam(local: Avm1Object, name: string, value: Value, version: number): void {
  const p = local.own(name, version);
  if (p === undefined) {
    local.add(name, value, 0);
  } else {
    p.value = value;
  }
}

/**
 * `super` in a method: an object whose prototype is the one above where
 * the method was found, whose methods run with the method's `this`.
 */
export class Avm1Super extends Avm1Object {
  constructor(
    /** The `this` of the method that made it. */
    readonly self: Avm1Object,
    /** How far up `self`'s prototypes the method was found. */
    readonly depth: number,
    version: number,
  ) {
    super(superProto(self, depth, version));
  }
}

/** The prototype `depth` steps up from `self`, then its own: where `super` looks. */
function superProto(self: Avm1Object, depth: number, version: number): Value {
  let base: Value = self;
  for (let i = 0; i < depth; i++) {
    if (!(base instanceof Avm1Object)) {
      return undefined;
    }

    base = base.protoFor(version);
  }

  return base instanceof Avm1Object ? base.protoFor(version) : undefined;
}

/**
 * `super` for an activation, undefined where it has none: a plain call has
 * none, nor does a SWF 5 (adl).
 */
export function superOf(cx: Activation, self: Value, version: number): Value {
  return cx.depth > 0 && version >= 6 && self instanceof Avm1Object
    ? new Avm1Super(self, cx.depth, version)
    : undefined;
}

/** A function's `arguments`: an array of them, with `callee` and `caller`. */
export function argumentsOf(cx: Activation, args: Value[], version: number): Avm1Object {
  const array = cx.realm.newArray(args, version);
  array.define("callee", cx.callee, DONT_ENUM);
  array.define("caller", cx.caller, DONT_ENUM);
  return array;
}

/** Whether `name` is `local` for a SWF of `version`. */
const named = (name: string, local: string, version: number) =>
  name === local || (version < 7 && fold(name) === local);

/**
 * `arguments` or `super` on a function's activation object `o`, as a
 * lookup first misses it; any other name stays missing.
 */
export function pendingLocal(
  cx: Activation,
  o: Avm1Object,
  name: string,
  version: number,
): Property | undefined {
  let p: Property | undefined;
  if (cx.pending & PENDING_Arguments && named(name, "arguments", version)) {
    cx.pending &= ~PENDING_Arguments;
    p = o.add("arguments", argumentsOf(cx, cx.args, version), 0);
  } else if (cx.pending & PENDING_Super && named(name, "super", version)) {
    cx.pending &= ~PENDING_Super;
    // Not listed by for..in, as `arguments` is (adl).
    p = o.add("super", superOf(cx, cx.receiver, version), DONT_ENUM);
  }

  if (cx.pending === 0) {
    o.lazy = null;
  }

  return p;
}
