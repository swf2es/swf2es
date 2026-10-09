// Function: its natives, held to Function.decl.ts, and what calling or
// constructing it does.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { elements } from "../natives/define.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { FunctionDecl } from "./Function.decl.js";

/** A function that does nothing, as `function () {}` makes one. */
const emptyFunction = (rt: Runtime): AsObject => rt.newFunctionObject(() => undefined, null);

/**
 * Function() and new Function(): an empty function; with a body, which
 * would be compiled at run time, EvalError 1066, as FunctionClass has it.
 * Function.prototype is a function, that does nothing.
 */
const functionHook: ClassHook = {
  construct: (rt, _cls, args) => {
    if (args.length) {
      throw rt.error("EvalError", 1066);
    }

    return emptyFunction(rt);
  },
  call: (rt, _cls, args) => {
    if (args.length) {
      throw rt.error("EvalError", 1066);
    }

    return emptyFunction(rt);
  },
  prototype: (rt) => emptyFunction(rt),
};

export const FunctionBuiltin = bindNatives(
  FunctionDecl,
  (rt) =>
    class FunctionNatives {
      // A function object is made by the runtime, never by this.
      Function() {}

      static createEmptyFunction() {
        return emptyFunction(rt);
      }

      get prototype() {
        return rt.functionPrototype(this);
      }

      // As FunctionObject's setter: null and undefined clear it, a primitive is refused.
      set prototype(p: Value) {
        const f = this as AsObject;
        if (p === null || p === undefined) {
          f.$prototype = undefined;
          f.$noPrototype = true;
          return;
        }

        if (typeof p !== "object" && typeof p !== "function") {
          throw rt.error("TypeError", 1049);
        }

        f.$prototype = p;
        f.$noPrototype = false;
      }

      get length(): number {
        const f = this as AsObject;
        return f.$length ?? f.$f.length;
      }

      "AS3::call"(this: AsObject, receiver: Value, ...args: Value[]) {
        // Not a tail call, as the runtime's calls are not (see Runtime.getProperty).
        // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
        let r: Value;
        r = rt.callValue(this, receiver, args, null);
        return r;
      }

      // Its arguments an Array, or none, as FunctionObject::AS3_apply has them.
      "AS3::apply"(this: AsObject, receiver: Value, args: Value) {
        if (args !== null && args !== undefined && args.$a === undefined) {
          throw rt.error("TypeError", 1116);
        }

        // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
        let r: Value;
        r = rt.callValue(this, receiver, elements(args).slice(), null);
        return r;
      }
    },
  functionHook,
);
