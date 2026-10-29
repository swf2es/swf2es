// The factories of methods whose bodies are not generated, as a module binds
// them through Runtime.native, noBody, unverified and verifyError: once,
// when it loads, never on a call.

import type { AsObject, Factory, Method, TypeRef, Value } from "./descriptors.js";
import type { Runtime } from "./runtime.js";
import { methodKey, untypedSetKey } from "./traits.js";

/**
 * A native with argument counts to check, when it has any, its declared
 * parameter count (see nativeFactory), and, when it declares a parameter
 * of a primitive type, those types to coerce a call's arguments to where
 * the compiler did not (see coercedNative).
 */
export type CountedMethod = Method & {
  $min?: number;
  $max?: number;
  $length?: number;
  $coerce?: TypeRef[];
};

/**
 * The parameter types avmplus' coerceEnter converts to without a class to
 * test against: the primitives, and Object, which takes undefined as null.
 * A native checks a class-typed parameter itself.
 */
const COERCED = new Set<TypeRef>(["String", "Number", "int", "uint", "Boolean", "float", "Object"]);

/** Factories nativeFactory made, whose methods coercedNative coerces. */
const natives = new WeakSet<Factory>();

/** A native method, bound by its name; one the runtime lacks throws when called. */
export function nativeFactory(rt: Runtime, name: string, required: number, max: number): Factory {
  const make = rt.natives[name];
  if (!make) {
    return () => () => {
      throw rt.unsupported(`native ${name}`);
    };
  }

  let f: Method | null = null;
  const factory: Factory = () => {
    if (!f) {
      f = make(rt);
      // Checked where a call was not bound (callBound, methodClosure): the
      // verifier binds only a call its argument count fits.
      if (required > 0 || max >= 0) {
        (f as CountedMethod).$min = required;
        (f as CountedMethod).$max = max;
      }

      // Its Function.length is the ABC's parameter count, as avmplus'
      // (FunctionClass.cpp), not what the JavaScript declares: a native
      // with optional parameters gives them defaults, which length skips.
      if (max >= 0) {
        (f as CountedMethod).$length = max;
      }
    }

    return f;
  };
  natives.add(factory);
  return factory;
}

/**
 * `f`, a method `factory` made, installed in `proto` at dispatch id `d`,
 * with what a call the compiler did not bind needs to coerce its arguments
 * by its declared `params`, if it is a native that declares a primitive or
 * Object one. avmplus coerces a native's arguments on entry, however it was
 * called; a compiled call bound to it has coerced them already, and calls
 * it as it is, so only the runtime's untyped paths pay: callBound, by the
 * types kept on `f`, the same for every runtime, which may share it; and
 * an untyped set, through a wrapper this runtime's `proto` keeps at
 * untypedSetKey(d), which a method that needs none hides from its base's.
 */
export function installMethod(
  rt: Runtime,
  proto: AsObject,
  d: number,
  f: Method,
  factory: Factory,
  params: TypeRef[],
): void {
  proto[methodKey(d)] = f;
  const key = untypedSetKey(d);
  if (!natives.has(factory) || !params.some((t) => COERCED.has(t))) {
    if (key in proto) {
      proto[key] = undefined;
    }

    return;
  }

  const m = f as CountedMethod;
  const types = params.map((t) => (COERCED.has(t) ? t : null));
  m.$coerce = types;
  // callBound coerces only a method with counts.
  m.$min ??= 0;
  m.$max ??= -1;
  const type = types[0];
  proto[key] =
    type === null || type === undefined
      ? undefined
      : function (this: Value, v: Value): Value {
          return f.call(this, rt.coerce(v, type));
        };
}

/** A method with no body, as an interface's: VerifyError 1001 when called. */
export function noBodyFactory(rt: Runtime): Factory {
  return () => () => {
    throw rt.error("VerifyError", 1001, "method");
  };
}

/** A method the compiler did not verify. */
export function unverifiedFactory(rt: Runtime): Factory {
  return () => () => {
    throw rt.unsupported("a method the compiler did not verify");
  };
}

/** A method the verifier rejected with VerifyError `id`, thrown when it is called. */
export function verifyErrorFactory(rt: Runtime, id: number): Factory {
  return () => () => {
    throw rt.error("VerifyError", id);
  };
}
