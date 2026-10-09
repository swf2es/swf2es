// uint: its methods are Number's, as avmplus' AS3 calls them, on Number(this).

import type { Value } from "../descriptors.js";
import { bindNatives } from "./bind.js";
import { toExponentialOf, toFixedOf, toPrecisionOf, toStringOf } from "./Number.js";
import { uintDecl } from "./uint.decl.js";

export const uintNatives = bindNatives(
  uintDecl,
  (rt) =>
    class uintNatives {
      // Its class hook makes new uint(x) the number: this never runs on one.
      uint() {}

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
