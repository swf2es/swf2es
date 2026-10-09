// Namespace: its natives, held to Namespace.decl.ts, and what calling or
// constructing it does. A Namespace is the runtime's own Namespace.

import type { Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { Namespace, prefixOf } from "../names.js";
import { constructNamespace } from "./xml/xml.js";
import { bindNatives } from "./bind.js";
import { NamespaceDecl } from "./Namespace.decl.js";

/** As NamespaceClass: Namespace(), Namespace(uri) or Namespace(prefix, uri). */
const namespaceHook: ClassHook = {
  construct: (rt, _cls, args) => constructNamespace(rt, args),
  call: (rt, _cls, args) =>
    args.length === 1 && args[0] instanceof Namespace ? args[0] : constructNamespace(rt, args),
};

const uriOf = (ns: Namespace): string => ns.uri ?? "";

export const NamespaceBuiltin = bindNatives(
  NamespaceDecl,
  () =>
    class NamespaceNatives {
      // Its class hook makes the Namespace: this never runs on one.
      Namespace() {}

      get prefix(): Value {
        return prefixOf(this as unknown as Namespace);
      }

      get uri(): string {
        return uriOf(this as unknown as Namespace);
      }

      "AS3::valueOf"(this: Namespace) {
        return uriOf(this);
      }

      "AS3::toString"(this: Namespace) {
        return uriOf(this);
      }
    },
  namespaceHook,
);
