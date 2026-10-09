// QName: its natives, held to QName.decl.ts, and what calling or
// constructing it does. A QName holds its namespace, null for any, and its
// local name, null for any.
//
// Its toString translated from avmplus' core/XML.as, this file is subject
// to the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { Namespace } from "../names.js";
import { newNamespace } from "../natives/xml/xml.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { QNameDecl } from "./QName.decl.js";

/** As QNameClass::construct: QName(name) or QName(namespace, name). */
function newQName(rt: Runtime, cls: AsObject, args: Value[]): AsObject {
  if (args.length === 1 && args[0]?.$local !== undefined) {
    return args[0];
  }

  const name = args.length >= 2 ? args[1] : args[0];
  const o = cls.$it.instance();
  // With no namespace, a name is in the default XML namespace.
  let ns: Namespace | null = rt.defaultXmlNamespace.interned;
  if (args.length >= 2 && args[0] !== undefined) {
    ns =
      args[0] === null
        ? null
        : args[0] instanceof Namespace
          ? args[0].interned
          : newNamespace(rt, args[0]);
  } else if (name?.$local !== undefined) {
    ns = name.$ns;
  }

  const local =
    name === undefined ? "" : name?.$local !== undefined ? name.$local : rt.toString(name);
  // With no namespace given, the any name is in any namespace too.
  if (local === "*" && (args.length < 2 || args[0] === undefined)) {
    ns = null;
  }

  o.$ns = ns;
  o.$local = local === "*" ? null : local;
  o.$attr = false;
  return o;
}

const qnameHook: ClassHook = { construct: newQName, call: newQName };

const localNameOf = (q: AsObject): string => q.$local ?? "*";
const uriOf = (q: AsObject): string | null => (q.$ns ? q.$ns.uri : null);

export const QNameBuiltin = bindNatives(
  QNameDecl,
  () =>
    class QNameNatives {
      // Its class hook makes the QName: this never runs on one.
      QName() {}

      get localName(): string {
        return localNameOf(this);
      }

      get uri(): Value {
        return uriOf(this);
      }

      "AS3::valueOf"(this: AsObject) {
        return this;
      }

      // "uri::localName", "*::localName" for any namespace, the local name
      // alone in the unnamed one; a version mark at the URI's end left out.
      "AS3::toString"(this: AsObject) {
        const uri = uriOf(this);
        const localName = localNameOf(this);
        if (uri === "") {
          return localName;
        }

        if (uri === null) {
          return `*::${localName}`;
        }

        const cc = uri.charCodeAt(uri.length - 1);
        const base = cc >= 0xe000 && cc <= 0xf8ff ? uri.slice(0, -1) : uri;
        return base === "" ? localName : `${base}::${localName}`;
      }
    },
  qnameHook,
);
