// Boolean: its natives, held to Boolean.decl.ts. `this` is the boolean.

import { BooleanDecl } from "./Boolean.decl.js";
import { bindNatives } from "./bind.js";

export const booleanNatives = bindNatives(
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
);
