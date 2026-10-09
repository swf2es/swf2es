// Boolean: its natives, held to Boolean.decl.ts. `this` is the boolean.

import { conversion } from "../natives/define.js";
import { BooleanDecl } from "./Boolean.decl.js";
import { bindNatives } from "./bind.js";

/** Boolean(x) converts, as new Boolean(x) makes, a boolean. */
const booleanHook = conversion((_rt, args) => !!args[0]);

export const BooleanBuiltin = bindNatives(
  BooleanDecl,
  () =>
    class BooleanNatives {
      // Its class hook makes new Boolean(x) the boolean: this never runs on one.
      Boolean() {}

      "AS3::toString"(this: boolean) {
        return this ? "true" : "false";
      }

      "AS3::valueOf"(this: boolean) {
        return this;
      }
    },
  booleanHook,
);
