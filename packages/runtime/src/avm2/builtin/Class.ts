// Class: its natives, held to Class.decl.ts.

import type { AsObject } from "../descriptors.js";
import { bindNatives } from "./bind.js";
import { ClassClassDecl } from "./Class.decl.js";

export const ClassBuiltin = bindNatives(
  ClassClassDecl,
  () =>
    class ClassNatives {
      // A class object is made by the runtime, never by this.
      Class() {}

      get prototype() {
        return (this as AsObject).$prototype;
      }
    },
);
