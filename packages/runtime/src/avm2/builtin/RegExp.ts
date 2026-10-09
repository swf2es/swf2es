// RegExp: its natives, held to RegExp.decl.ts, and what calling or
// constructing it does. A RegExp holds its JavaScript RegExp in $re (see
// regexp/compile.ts).

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { RegExpDecl } from "./RegExp.decl.js";
import { matchArray, newRegExp } from "./regexp/compile.js";

/** As RegExpObject::exec: a global one from before the start fails, where JavaScript starts from 0. */
function exec(rt: Runtime, o: AsObject, s: string | null): Value {
  const re: RegExp = o.$re;
  if (re.global && re.lastIndex < 0) {
    re.lastIndex = 0;
    return null;
  }

  const m = re.exec(s ?? "null");
  return m ? matchArray(rt, m) : null;
}

const regexpHook: ClassHook = {
  construct: newRegExp,
  // RegExp.prototype is a RegExp, of the empty pattern, which avmplus writes (?:).
  prototype: (rt, cls) => newRegExp(rt, cls, ["(?:)"]),
  call: (rt, cls, args) =>
    args[0]?.$re instanceof RegExp && args[1] === undefined ? args[0] : newRegExp(rt, cls, args),
};

export const RegExpBuiltin = bindNatives(
  RegExpDecl,
  (rt) =>
    class RegExpNatives {
      // Its class hook makes the RegExp: this runs only as a subclass's super().
      RegExp() {}

      get source(): string {
        return (this as AsObject).$source;
      }

      get global(): boolean {
        return (this as AsObject).$re.global;
      }

      get ignoreCase(): boolean {
        return (this as AsObject).$re.ignoreCase;
      }

      get multiline(): boolean {
        return (this as AsObject).$re.multiline;
      }

      get dotall(): boolean {
        return (this as AsObject).$re.dotAll;
      }

      get extended(): boolean {
        return (this as AsObject).$extended;
      }

      get lastIndex(): number {
        return (this as AsObject).$re.lastIndex;
      }

      set lastIndex(i: number) {
        (this as AsObject).$re.lastIndex = i;
      }

      "AS3::exec"(this: AsObject, s: string | null) {
        return exec(rt, this, s);
      }

      "AS3::test"(this: AsObject, s: string | null) {
        return exec(rt, this, s) !== null;
      }
    },
  regexpHook,
);
