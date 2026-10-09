// XMLList: its natives, held to XMLList.decl.ts, and what calling or
// constructing it does. They call the E4X engine in xml/.
//
// Its natives translated from avmplus' core/XMLListObject.cpp and
// XMLListClass.cpp, this file is subject to the Mozilla Public License,
// v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { publicNs } from "../names.js";
import type { Runtime } from "../runtime.js";
import { bindNatives } from "./bind.js";
import { XMLListDecl } from "./XMLList.decl.js";
import { CDATA, COMMENT, ELEMENT, TEXT, type XMLNode } from "./xml/node.js";
import {
  addNamespace,
  adopt,
  append,
  appendChild,
  child,
  childChanges,
  childrenOf,
  coerce,
  constructXMLList,
  deleteIndex,
  descendantsOfList,
  elements,
  getList,
  hasList,
  insertAt,
  insertChild,
  listDeepCopy,
  listHasSimpleContent,
  listProperties,
  listToString,
  listToXMLString,
  namespaceDeclarations,
  namespaceOf,
  newList,
  normalize,
  ONLY_ONE_ITEM_LISTS,
  processingInstructions,
  qnameOf,
  removeNamespace,
  replace,
  setLocalName,
  setName,
  setNamespace,
  setXML,
  star,
  toAttributeName,
  toXMLList,
  toXMLName,
  xmlOf,
} from "./xml/xml.js";

/** XMLList's names looked up by the engine, and XMLList(x), new XMLList(x). */
const listHook: ClassHook = {
  properties: listProperties,
  construct: constructXMLList,
  call: (rt, _cls, args) =>
    args[0] === null || args[0] === undefined ? toXMLList(rt, "") : toXMLList(rt, args[0]),
};

/** The one item of a list a method only a list of one has is called on; else TypeError 1086. */
function onlyItem(rt: Runtime, o: AsObject, name: string): AsObject {
  const nodes: XMLNode[] = o.$nodes;
  if (nodes.length !== 1) {
    throw rt.error("TypeError", ONLY_ONE_ITEM_LISTS, name);
  }

  return xmlOf(rt, nodes[0]);
}

/** The list of what `f` gives for each element item, together. */
function eachElement(rt: Runtime, o: AsObject, f: (x: AsObject) => AsObject): AsObject {
  const list = newList(rt, o);
  for (const node of o.$nodes as XMLNode[]) {
    if (node.kind === ELEMENT) {
      const r = f(xmlOf(rt, node));
      if (r.$nodes.length) {
        append(list, r);
      }
    }
  }

  return list;
}

export const XMLListBuiltin = bindNatives(
  XMLListDecl,
  (rt) =>
    class XMLListNatives {
      // Its class hook makes the XMLList: this never runs on one.
      XMLList() {}

      "AS3::valueOf"(this: AsObject) {
        return this;
      }

      // As XML.as: the one item's namespace, as XML's namespace has it.
      "AS3::namespace"(this: AsObject, ...args: Value[]) {
        const x = onlyItem(rt, this, "namespace");
        return args.length
          ? namespaceOf(rt, x.$node, 1, args[0])
          : namespaceOf(rt, x.$node, 0, null);
      }

      "AS3::toJSON"(this: AsObject, k: string | null) {
        return rt.callProperty(this, rt.publicName("toJSON"), k);
      }

      "AS3::toString"(this: AsObject) {
        return listToString(rt, this);
      }

      "AS3::toXMLString"(this: AsObject) {
        return listToXMLString(rt, this);
      }

      "AS3::hasOwnProperty"(this: AsObject, p: Value) {
        return hasList(rt, this, coerce(rt, toXMLName(rt, p)));
      }

      "AS3::propertyIsEnumerable"(this: AsObject, p: Value) {
        const nodes: XMLNode[] = this.$nodes;
        const index = rt.toNumber(p);
        return index >= 0 && index < nodes.length;
      }

      "AS3::attribute"(this: AsObject, name: Value) {
        return getList(rt, this, coerce(rt, toAttributeName(rt, name)));
      }

      "AS3::attributes"(this: AsObject) {
        return getList(rt, this, coerce(rt, toAttributeName(rt, "*")));
      }

      "AS3::child"(this: AsObject, name: Value) {
        const nodes: XMLNode[] = this.$nodes;
        const list = newList(rt, this);
        for (const node of nodes) {
          const r = child(rt, xmlOf(rt, node), node, name);
          if (r.$nodes.length) {
            append(list, r);
          }
        }

        return list;
      }

      "AS3::children"(this: AsObject) {
        return getList(rt, this, coerce(rt, toXMLName(rt, "*")));
      }

      "AS3::comments"(this: AsObject) {
        return eachElement(rt, this, (x: AsObject) => childrenOf(rt, x, x.$node, COMMENT));
      }

      "AS3::contains"(this: AsObject, v: Value) {
        const nodes: XMLNode[] = this.$nodes;
        return nodes.some((node) => rt.equals(xmlOf(rt, node), v));
      }

      "AS3::copy"(this: AsObject) {
        return listDeepCopy(rt, this);
      }

      "AS3::descendants"(this: AsObject, name: Value) {
        return descendantsOfList(rt, this, toXMLName(rt, star(name)));
      }

      "AS3::elements"(this: AsObject, name: Value) {
        const nodes: XMLNode[] = this.$nodes;
        const list = newList(rt, this, toXMLName(rt, star(name)));
        for (const node of nodes) {
          if (node.kind === ELEMENT) {
            const r = elements(rt, xmlOf(rt, node), node, star(name));
            if (r.$nodes.length) {
              append(list, r);
            }
          }
        }

        return list;
      }

      "AS3::hasComplexContent"(this: AsObject) {
        const nodes: XMLNode[] = this.$nodes;
        if (nodes.length === 1) {
          return nodes[0].hasComplexContent();
        }

        return nodes.some((n) => n.kind === ELEMENT);
      }

      "AS3::hasSimpleContent"(this: AsObject) {
        const nodes: XMLNode[] = this.$nodes;
        return listHasSimpleContent(nodes);
      }

      "AS3::length"(this: AsObject) {
        const nodes: XMLNode[] = this.$nodes;
        return nodes.length;
      }

      "AS3::name"(this: AsObject) {
        const x = onlyItem(rt, this, "name");
        return x.$node.name === null ? null : qnameOf(rt, x.$node);
      }

      "AS3::normalize"(this: AsObject) {
        const nodes: XMLNode[] = this.$nodes;
        let i = 0;
        while (i < nodes.length) {
          const xn = nodes[i];
          if (xn.kind === ELEMENT) {
            normalize(rt, xn);
            i++;
          } else if (xn.kind & (TEXT | CDATA)) {
            while (i + 1 < nodes.length && nodes[i + 1].kind & (TEXT | CDATA)) {
              xn.value += nodes[i + 1].value;
              deleteIndex(rt, this, i + 1);
            }

            if (xn.value.length === 0) {
              deleteIndex(rt, this, i);
            } else {
              i++;
            }
          } else {
            i++;
          }
        }

        return this;
      }

      "AS3::parent"(this: AsObject) {
        const nodes: XMLNode[] = this.$nodes;
        if (!nodes.length) {
          return undefined;
        }

        const parent = nodes[0].parent;
        if (!parent || nodes.some((n) => n.parent !== parent)) {
          return undefined;
        }

        return xmlOf(rt, parent);
      }

      "AS3::processingInstructions"(this: AsObject, name: Value) {
        return eachElement(rt, this, (x: AsObject) =>
          processingInstructions(rt, x, x.$node, star(name)),
        );
      }

      "AS3::text"(this: AsObject) {
        return eachElement(rt, this, (x: AsObject) => childrenOf(rt, x, x.$node, TEXT | CDATA));
      }

      "AS3::addNamespace"(this: AsObject, v: Value) {
        const x = onlyItem(rt, this, "addNamespace");
        return addNamespace(rt, x, x.$node, v);
      }

      "AS3::appendChild"(this: AsObject, c: Value) {
        const x = onlyItem(rt, this, "appendChild");
        return appendChild(rt, x, x.$node, c);
      }

      "AS3::childIndex"(this: AsObject) {
        const x = onlyItem(rt, this, "childIndex");
        return x.$node.childIndex();
      }

      "AS3::inScopeNamespaces"(this: AsObject) {
        const x = onlyItem(rt, this, "inScopeNamespaces");
        const list = x.$node.inScopeNamespaces();
        return rt.newArray(list.length ? list : [publicNs]);
      }

      "AS3::insertChildAfter"(this: AsObject, c1: Value, c2: Value) {
        const x = onlyItem(rt, this, "insertChildAfter");
        return insertChild(rt, x, x.$node, c1, c2, true);
      }

      "AS3::insertChildBefore"(this: AsObject, c1: Value, c2: Value) {
        const x = onlyItem(rt, this, "insertChildBefore");
        return insertChild(rt, x, x.$node, c1, c2, false);
      }

      "AS3::nodeKind"(this: AsObject) {
        const x = onlyItem(rt, this, "nodeKind");
        return x.$node.nodeKind();
      }

      "private::_namespace"(this: AsObject, prefix: Value, argc: Value) {
        const x = onlyItem(rt, this, "namespace");
        return namespaceOf(rt, x.$node, argc, prefix);
      }

      "AS3::localName"(this: AsObject) {
        const x = onlyItem(rt, this, "localName");
        return x.$node.name;
      }

      "AS3::namespaceDeclarations"(this: AsObject) {
        const x = onlyItem(rt, this, "namespaceDeclarations");
        return namespaceDeclarations(rt, x.$node);
      }

      "AS3::prependChild"(this: AsObject, v: Value) {
        const x = onlyItem(rt, this, "prependChild");
        const c = adopt(v);
        insertAt(rt, x.$node, 0, c);
        childChanges(rt, x.$node, "nodeAdded", c);
        return x;
      }

      "AS3::removeNamespace"(this: AsObject, v: Value) {
        const x = onlyItem(rt, this, "removeNamespace");
        removeNamespace(rt, x.$node, v);
        return x;
      }

      "AS3::replace"(this: AsObject, name: Value, v: Value) {
        const x = onlyItem(rt, this, "replace");
        return replace(rt, x, x.$node, name, v);
      }

      "AS3::setChildren"(this: AsObject, v: Value) {
        const x = onlyItem(rt, this, "setChildren");
        setXML(rt, x, toXMLName(rt, "*"), v);
        return x;
      }

      "AS3::setLocalName"(this: AsObject, name: Value) {
        const x = onlyItem(rt, this, "setLocalName");
        return setLocalName(rt, x.$node, name);
      }

      "AS3::setName"(this: AsObject, name: Value) {
        const x = onlyItem(rt, this, "setName");
        return setName(rt, x.$node, name);
      }

      "AS3::setNamespace"(this: AsObject, ns: Value) {
        const x = onlyItem(rt, this, "setNamespace");
        return setNamespace(rt, x.$node, ns);
      }
    },
  listHook,
);
