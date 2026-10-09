// int: its methods are Number's, as avmplus' AS3 calls them, on Number(this).

import type { Value } from "../descriptors.js";
import { bindNatives } from "./bind.js";
import { intDecl } from "./int.decl.js";
import { toExponentialOf, toFixedOf, toPrecisionOf, toStringOf } from "./Number.js";

export const intNatives = bindNatives(
  intDecl,
  (rt) =>
    class intNatives {
      // Its class hook makes new int(x) the number: this never runs on one.
      int() {}

      "AS3::toString"(this: number, radix: Value) {
        return toStringOf(rt, this, radix);
      }

      "AS3::valueOf"(this: number) {
        return this;
      }

      "AS3::toExponential"(this: number, p: Value) {
        return toExponentialOf(rt, this, p);
      }

      "AS3::toPrecision"(this: number, p: Value) {
        return toPrecisionOf(rt, this, p);
      }

      "AS3::toFixed"(this: number, p: Value) {
        return toFixedOf(rt, this, p);
      }
    },
);
