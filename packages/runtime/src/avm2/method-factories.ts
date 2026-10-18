// The factories of methods whose bodies are not generated, as a module binds
// them through Runtime.native, noBody, unverified and verifyError: once,
// when it loads, never on a call.

import type { Factory, Method } from "./descriptors.js";
import type { Runtime } from "./runtime.js";

/** A native with argument counts to check, when it has any, and its declared parameter count (see nativeFactory). */
export type CountedMethod = Method & { $min?: number; $max?: number; $length?: number };

/** A native method, bound by its name; one the runtime lacks throws when called. */
export function nativeFactory(rt: Runtime, name: string, required: number, max: number): Factory {
  const make = rt.natives[name];
  if (!make) {
    return () => () => {
      throw rt.unsupported(`native ${name}`);
    };
  }

  let f: Method | null = null;
  return () => {
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
