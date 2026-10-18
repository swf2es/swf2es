// E4X: the XML and XMLList classes, as avmplus has them. Names on them are
// looked up by PropertyHook in place of dynamic properties (access.ts);
// here are the hooks, the constructors and the natives. The values are in
// values.ts, names in names.ts, parsing and conversions in build.ts,
// strings in strings.ts and == and + in operators.ts.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp,
// XMLClass.cpp, XMLListClass.cpp and E4X's parts of Toplevel.cpp and
// AvmCore.cpp, this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import type { ClassHook, PropertyHook } from "../../hooks.js";
import { type Multiname, type Namespace, prefixOf, publicNs } from "../../names.js";
import type { Runtime } from "../../runtime.js";
import { AS3, type Natives } from "../define.js";
import {
  childChanges,
  deleteIndex,
  deleteList,
  deleteXML,
  descendantsOf,
  descendantsOfList,
  getList,
  getXML,
  hasList,
  hasXML,
  insertAt,
  nonChildChanges,
  notifyNeeded,
  replaceAt,
  setIndex,
  setList,
  setXML,
} from "./access.js";
import { deepCopy, isWhitespace, listDeepCopy, toXML, toXMLList } from "./build.js";
import { isXMLName } from "./chars.js";
import {
  coerce,
  fromMultiname,
  getNamespace,
  hasPrefix,
  matchesChild,
  newNamespace,
  parseIndex,
  qnameName,
  qnameOf,
  toAttributeName,
  toXMLName,
} from "./names.js";
import {
  ATTRIBUTE,
  CDATA,
  COMMENT,
  ELEMENT,
  matches,
  PROCESSING_INSTRUCTION,
  TEXT,
  type XMLNode,
} from "./node.js";
import { add, equals } from "./operators.js";
import {
  listHasSimpleContent,
  listToString,
  listToXMLString,
  xmlToString,
  xmlToXMLString,
} from "./strings.js";
import {
  append,
  appendNode,
  type E4X,
  e4x,
  INVALID_NAME,
  isList,
  isXML,
  newList,
  ONLY_ONE_ITEM_LISTS,
  xmlOf,
} from "./values.js";

// Calls, as XMLObject::callProperty and XMLListObject::callProperty.

/** A dynamic property of the prototype chain, or undefined. */
function prototypeProperty(rt: Runtime, o: AsObject, mn: Multiname): Value {
  const name = mn.dynamicName();
  if (name === null) {
    return undefined;
  }

  for (let p = rt.protoOf(o); p; p = p.$p) {
    const v = p.$d?.get(name);
    if (v !== undefined) {
      return v;
    }
  }

  return undefined;
}

/** A function that calls `mn` on `receiver`, for a call E4X passes on. */
const forward = (rt: Runtime, receiver: Value, mn: Multiname) =>
  rt.newFunctionObject((...args: Value[]) => rt.callProperty(receiver, mn, ...args), null);

// The hooks.

const xmlProperties: PropertyHook = {
  hidesMethods: true,
  get: (rt, o, mn) => getXML(rt, o, fromMultiname(mn)),
  set: (rt, o, mn, v) => setXML(rt, o, fromMultiname(mn), v),
  delete: (rt, o, mn) => deleteXML(rt, o, fromMultiname(mn)),
  has: (rt, o, mn) => hasXML(rt, o, fromMultiname(mn)),
  callee(rt, o, mn) {
    const f = prototypeProperty(rt, o, mn);
    if (f !== undefined) {
      return f;
    }

    const v = getXML(rt, o, fromMultiname(mn));
    // A simple node with no such child is its string, as 11.2.2.1 has it.
    if (isList(v) && !v.$nodes.length && o.$node.hasSimpleContent()) {
      return forward(rt, xmlToString(rt, o.$node), mn);
    }

    return v;
  },
  descendants: (rt, o, mn) => descendantsOf(rt, o.$node, fromMultiname(mn)),
  nextIndex: (_rt, _o, index) => (index === 0 ? 1 : 0),
  nextName: (_rt, _o, index) => (index === 1 ? "0" : null),
  nextValue: (_rt, o, index) => (index === 1 ? o : undefined),
  equals,
  add,
  toString: (rt, o) => xmlToString(rt, o.$node),
  toXMLString: (rt, o) => xmlToXMLString(rt, o.$node),
};

const listProperties: PropertyHook = {
  hidesMethods: true,
  get: (rt, o, mn) => getList(rt, o, coerce(rt, fromMultiname(mn))),
  set: (rt, o, mn, v) => setList(rt, o, coerce(rt, fromMultiname(mn)), v),
  delete: (rt, o, mn) => deleteList(rt, o, coerce(rt, fromMultiname(mn))),
  has: (rt, o, mn) => hasList(rt, o, coerce(rt, fromMultiname(mn))),
  callee(rt, o, mn) {
    const f = prototypeProperty(rt, o, mn);
    if (f !== undefined) {
      return f;
    }

    const v = getList(rt, o, coerce(rt, fromMultiname(mn)));
    // A list of one with no such child passes the call on to its item.
    if (isList(v) && !v.$nodes.length && o.$nodes.length === 1) {
      return forward(rt, xmlOf(rt, o.$nodes[0]), mn);
    }

    return v;
  },
  descendants: (rt, o, mn) => descendantsOfList(rt, o, coerce(rt, fromMultiname(mn))),
  nextIndex: (_rt, o, index) => (index < o.$nodes.length ? index + 1 : 0),
  nextName: (_rt, o, index) => (index <= o.$nodes.length ? String(index - 1) : null),
  nextValue: (rt, o, index) =>
    index <= o.$nodes.length ? xmlOf(rt, o.$nodes[index - 1]) : undefined,
  equals,
  add,
  toString: (rt, o) => listToString(rt, o),
  toXMLString: (rt, o) => listToXMLString(rt, o),
};

function constructXML(rt: Runtime, _cls: AsObject, args: Value[]): Value {
  const v = args[0];
  if (v === null || v === undefined) {
    return toXML(rt, "");
  }

  const x = toXML(rt, v);
  if (isXML(v) || isList(v)) {
    return xmlOf(rt, deepCopy(rt, x.$node));
  }

  return x;
}

function constructXMLList(rt: Runtime, _cls: AsObject, args: Value[]): Value {
  const v = args[0];
  if (v === null || v === undefined) {
    return toXMLList(rt, "");
  }

  if (isList(v)) {
    const list = newList(rt);
    append(list, v);
    return list;
  }

  return toXMLList(rt, v);
}

export const xmlHooks: Record<string, ClassHook> = {
  XML: {
    properties: xmlProperties,
    construct: constructXML,
    call: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? toXML(rt, "") : toXML(rt, args[0]),
  },
  XMLList: {
    properties: listProperties,
    construct: constructXMLList,
    call: (rt, _cls, args) =>
      args[0] === null || args[0] === undefined ? toXMLList(rt, "") : toXMLList(rt, args[0]),
  },
};

// The natives.

/** An XML method: `f` with the runtime, on the node. */
const onXML =
  (f: (rt: Runtime, o: AsObject, node: XMLNode, ...args: Value[]) => Value) => (rt: Runtime) =>
    function (this: AsObject, ...args: Value[]) {
      return f(rt, this, this.$node, ...args);
    };

/** An XMLList method: `f` with the runtime, on the list and its nodes. */
const onList =
  (f: (rt: Runtime, o: AsObject, nodes: XMLNode[], ...args: Value[]) => Value) => (rt: Runtime) =>
    function (this: AsObject, ...args: Value[]) {
      return f(rt, this, this.$nodes, ...args);
    };

/** An XMLList method that only a list of one has: its item's. */
const onlyOne = (name: string, f: (rt: Runtime, x: AsObject, ...args: Value[]) => Value) =>
  onList((rt, _o, nodes, ...args) => {
    if (nodes.length !== 1) {
      throw rt.error("TypeError", ONLY_ONE_ITEM_LISTS, name);
    }

    return f(rt, xmlOf(rt, nodes[0]), ...args);
  });

/** An XMLList method: the XMLList of each element's results, together. */
const eachElement = (f: (rt: Runtime, x: AsObject, ...args: Value[]) => AsObject) =>
  onList((rt, o, nodes, ...args) => {
    const list = newList(rt, o);
    for (const node of nodes) {
      if (node.kind === ELEMENT) {
        const r = f(rt, xmlOf(rt, node), ...args);
        if (r.$nodes.length) {
          append(list, r);
        }
      }
    }

    return list;
  });

/**
 * As maybeEscapeChild, with the fixes of avmshell's SWF version: a child
 * is added as it is, a string as text, and XML already in a tree is first
 * taken out of it.
 */
function adopt(v: Value): Value {
  if (isXML(v)) {
    const node: XMLNode = v.$node;
    const i = node.childIndex();
    if (node.parent && i !== -1) {
      node.parent.deleteByIndex(i);
    }
  }

  return v;
}

const NOT_ELEMENT = TEXT | COMMENT | PROCESSING_INSTRUCTION | ATTRIBUTE | CDATA;

function addNamespace(rt: Runtime, o: AsObject, node: XMLNode, v: Value): AsObject {
  const ns = newNamespace(rt, v);
  node.addInScopeNamespace(ns);
  nonChildChanges(rt, node, "namespaceAdded", ns);
  return o;
}

function appendChild(rt: Runtime, o: AsObject, node: XMLNode, child: Value): AsObject {
  const c = adopt(child);
  const children = getXML(rt, o, toXMLName(rt, "*"));
  setIndex(rt, children, node.children.length, c);
  return o;
}

function insertChild(
  rt: Runtime,
  o: AsObject,
  node: XMLNode,
  child1: Value,
  child2: Value,
  after: boolean,
): Value {
  if (node.kind & NOT_ELEMENT) {
    return undefined;
  }

  const c2 = adopt(child2);
  if (child1 === null) {
    insertAt(rt, node, after ? 0 : node.children.length, c2);
    childChanges(rt, node, "nodeAdded", c2);
    return o;
  }

  let c1: XMLNode | null = isXML(child1) ? child1.$node : null;
  if (!c1 && isList(child1) && child1.$nodes.length === 1) {
    c1 = child1.$nodes[0];
  }

  if (c1) {
    const i = node.children.indexOf(c1);
    if (i >= 0) {
      insertAt(rt, node, after ? i + 1 : i, c2);
      childChanges(rt, node, "nodeAdded", c2);
      return o;
    }
  }

  return undefined;
}

function namespaceOf(rt: Runtime, node: XMLNode, argc: number, prefix: Value): Value {
  const inScope = node.inScopeNamespaces();
  if (!argc) {
    if (node.kind & (TEXT | COMMENT | CDATA | PROCESSING_INSTRUCTION)) {
      return null;
    }

    return getNamespace(node.ns, inScope);
  }

  const p = rt.toString(prefix);
  return inScope.find((ns) => prefixOf(ns) === p) ?? undefined;
}

function namespaceDeclarations(rt: Runtime, node: XMLNode): AsObject {
  const result: Namespace[] = [];
  if (!(node.kind & NOT_ELEMENT)) {
    const ancestors = node.parent ? node.parent.inScopeNamespaces() : [];
    for (const ns of node.namespaces) {
      if (!hasPrefix(ns)) {
        if (ns.uri !== "" && !ancestors.some((ns2) => ns.uri === ns2.uri)) {
          result.push(ns);
        }
      } else if (!ancestors.some((ns2) => prefixOf(ns) === prefixOf(ns2) && ns.uri === ns2.uri)) {
        result.push(ns);
      }
    }
  }

  return rt.newArray(result);
}

function normalize(rt: Runtime, node: XMLNode): void {
  const notify = notifyNeeded(node);
  let i = 0;
  while (i < node.children.length) {
    const x = node.children[i];
    if (x.kind === ELEMENT) {
      normalize(rt, x);
      i++;
    } else if (x.kind & (TEXT | CDATA)) {
      const prior = x.value;
      while (i + 1 < node.children.length && node.children[i + 1].kind & (TEXT | CDATA)) {
        const x2 = node.children[i + 1];
        x.value += x2.value;
        node.deleteByIndex(i + 1);
        if (notify) {
          childChanges(rt, node, "nodeRemoved", xmlOf(rt, x2));
        }
      }

      if (isWhitespace(x.value)) {
        node.deleteByIndex(i);
        if (notify) {
          childChanges(rt, node, "nodeRemoved", xmlOf(rt, x));
        }
      } else {
        i++;
      }

      if (x.value !== prior && notify) {
        nonChildChanges(rt, x, "textSet", x.value, prior);
      }
    } else {
      i++;
    }
  }
}

function removeNamespace(rt: Runtime, node: XMLNode, v: Value): void {
  if (node.kind & NOT_ELEMENT) {
    return;
  }

  const ns = newNamespace(rt, v);
  if (getNamespace(node.ns, node.namespaces) === ns) {
    return;
  }

  for (const a of node.attributes) {
    if (getNamespace(a.ns, node.namespaces) === ns) {
      return;
    }
  }

  const i = node.findMatchingNamespace(ns);
  if (i !== -1) {
    node.namespaces.splice(i, 1);
  }

  for (const child of node.children) {
    if (child.kind === ELEMENT) {
      removeNamespace(rt, child, ns);
    }
  }

  nonChildChanges(rt, node, "namespaceRemoved", ns);
}

function replace(rt: Runtime, o: AsObject, node: XMLNode, name: Value, value: Value): AsObject {
  if (node.kind & NOT_ELEMENT) {
    return o;
  }

  let c: Value;
  if (isXML(value)) {
    c = xmlOf(rt, deepCopy(rt, value.$node));
  } else if (isList(value)) {
    c = listDeepCopy(rt, value);
  } else {
    c = rt.toString(value);
  }

  const index = parseIndex(rt.toString(name));
  if (index >= 0) {
    const prior = replaceAt(rt, node, index, c);
    childChanges(rt, node, "nodeChanged", c, prior);
    return o;
  }

  const n = qnameName(rt, name);
  const notify = notifyNeeded(node);
  let i = -1;
  for (let k = node.children.length - 1; k >= 0; k--) {
    if (matchesChild(n, node.children[k])) {
      if (i !== -1) {
        const was = node.children[i];
        node.deleteByIndex(i);
        if (notify && was.kind === ELEMENT) {
          childChanges(rt, node, "nodeRemoved", xmlOf(rt, was));
        }
      }

      i = k;
    }
  }

  if (i === -1) {
    return o;
  }

  const prior = replaceAt(rt, node, i, c);
  childChanges(rt, node, prior ? "nodeChanged" : "nodeAdded", c, prior);
  return o;
}

function setLocalName(rt: Runtime, node: XMLNode, name: Value): void {
  if (node.kind & (TEXT | COMMENT | CDATA)) {
    return;
  }

  const newName =
    typeof name === "object" && name !== null && name.$local !== undefined
      ? (name.$local ?? "*")
      : rt.toString(name);
  if (!isXMLName(newName)) {
    throw rt.error("TypeError", INVALID_NAME, newName);
  }

  if (node.name !== null) {
    const prior = node.name;
    node.setName(newName, node.ns);
    nonChildChanges(rt, node, "nameSet", newName, prior);
  }
}

function setName(rt: Runtime, node: XMLNode, value: Value): void {
  if (node.kind & (TEXT | COMMENT | CDATA)) {
    return;
  }

  let name = value;
  if (typeof name === "object" && name !== null && name.$local !== undefined && !name.$ns) {
    name = name.$local ?? "*";
  }

  const n = qnameName(rt, name);
  const local = n.local ?? "*";
  if (!isXMLName(local)) {
    throw rt.error("TypeError", INVALID_NAME, local);
  }

  if (node.name === null) {
    return;
  }

  if (node.kind === PROCESSING_INSTRUCTION) {
    node.setName(local, publicNs);
  } else {
    const ns = n.namespaces?.[0] ?? null;
    node.setName(local, ns);
    if (ns && ns.uri !== "") {
      if (node.kind === ATTRIBUTE && node.parent) {
        node.parent.addInScopeNamespace(node.ns);
      } else if (node.kind === ELEMENT) {
        node.addInScopeNamespace(node.ns);
      }
    }
  }

  nonChildChanges(rt, node, "nameSet", name, node.name);
}

function setNamespace(rt: Runtime, node: XMLNode, v: Value): void {
  if (node.kind & (TEXT | COMMENT | PROCESSING_INSTRUCTION | CDATA)) {
    return;
  }

  const ns = newNamespace(rt, v);
  if (node.name !== null) {
    node.setName(node.name, ns);
  }

  if (node.kind === ATTRIBUTE && node.parent) {
    node.parent.addInScopeNamespace(ns);
  } else if (node.kind === ELEMENT) {
    node.addInScopeNamespace(ns);
  }

  nonChildChanges(rt, node, "namespaceSet", ns);
}

/** A list of `node`'s children of `kinds`, got from `o`. */
function childrenOf(rt: Runtime, o: AsObject, node: XMLNode, kinds: number): AsObject {
  const list = newList(rt, o);
  for (const child of node.children) {
    if (child.kind & kinds) {
      appendNode(list, child);
    }
  }

  return list;
}

function elements(rt: Runtime, o: AsObject, node: XMLNode, name: Value): AsObject {
  const n = toXMLName(rt, name);
  const list = newList(rt, o, n);
  for (const child of node.children) {
    if (child.kind === ELEMENT && matches(n, child)) {
      appendNode(list, child);
    }
  }

  return list;
}

function processingInstructions(rt: Runtime, o: AsObject, node: XMLNode, name: Value): AsObject {
  const n = toXMLName(rt, name);
  const list = newList(rt, o);
  if (n.attribute) {
    return list;
  }

  for (const child of node.children) {
    if (child.kind === PROCESSING_INSTRUCTION && matches(n, child)) {
      appendNode(list, child);
    }
  }

  return list;
}

function child(rt: Runtime, o: AsObject, node: XMLNode, name: Value): AsObject {
  const index = parseIndex(rt.toString(name));
  if (index >= 0) {
    const list = newList(rt);
    if (index < node.children.length) {
      appendNode(list, node.children[index]);
    }

    return list;
  }

  return getXML(rt, o, toXMLName(rt, name));
}

const x = (name: string) => `XML#${AS3}::${name}`;
const l = (name: string) => `XMLList#${AS3}::${name}`;
const star = (v: Value) => (v === undefined ? "*" : v);

/** XML's settings, as its static accessors. */
const setting = <K extends keyof E4X>(key: K, set: (rt: Runtime, v: Value) => E4X[K]): Natives => ({
  [`XML.get:${key}`]: (rt) => () => e4x(rt)[key],
  [`XML.set:${key}`]: (rt) => (v: Value) => {
    e4x(rt)[key] = set(rt, v);
  },
});

const toBoolean = (_rt: Runtime, v: Value) => Boolean(v);

export const xmlNatives: Natives = {
  ...setting("ignoreComments", toBoolean),
  ...setting("ignoreProcessingInstructions", toBoolean),
  ...setting("ignoreWhitespace", toBoolean),
  ...setting("prettyPrinting", toBoolean),
  ...setting("prettyIndent", (rt, v) => rt.toInt(v)),

  [x("toString")]: onXML((rt, _o, node) => xmlToString(rt, node)),
  [x("toXMLString")]: onXML((rt, _o, node) => xmlToXMLString(rt, node)),
  [x("hasOwnProperty")]: onXML((rt, o, _node, p) => hasXML(rt, o, toXMLName(rt, p))),
  [x("propertyIsEnumerable")]: onXML((rt, _o, _node, p) => rt.toString(p) === "0"),
  [x("addNamespace")]: onXML((rt, o, node, v) => addNamespace(rt, o, node, v)),
  [x("appendChild")]: onXML((rt, o, node, c) => appendChild(rt, o, node, c)),
  [x("attribute")]: onXML((rt, o, _node, name) => getXML(rt, o, toAttributeName(rt, name))),
  [x("attributes")]: onXML((rt, o) => getXML(rt, o, toAttributeName(rt, "*"))),
  [x("child")]: onXML((rt, o, node, name) => child(rt, o, node, name)),
  [x("childIndex")]: onXML((_rt, _o, node) => node.childIndex()),
  [x("children")]: onXML((rt, o) => getXML(rt, o, toXMLName(rt, "*"))),
  [x("comments")]: onXML((rt, o, node) => childrenOf(rt, o, node, COMMENT)),
  [x("contains")]: onXML(
    (_rt, o, node, v) => o === v || (isXML(v) && node.equals(v.$node as XMLNode)),
  ),
  [x("copy")]: onXML((rt, _o, node) => xmlOf(rt, deepCopy(rt, node))),
  [x("descendants")]: onXML((rt, _o, node, name) =>
    descendantsOf(rt, node, toXMLName(rt, star(name))),
  ),
  [x("elements")]: onXML((rt, o, node, name) => elements(rt, o, node, star(name))),
  [x("hasComplexContent")]: onXML((_rt, _o, node) => node.hasComplexContent()),
  [x("hasSimpleContent")]: onXML((_rt, _o, node) => node.hasSimpleContent()),
  [x("inScopeNamespaces")]: onXML((rt, _o, node) => {
    const list = node.inScopeNamespaces();
    return rt.newArray(list.length ? list : [publicNs]);
  }),
  [x("insertChildAfter")]: onXML((rt, o, node, c1, c2) => insertChild(rt, o, node, c1, c2, true)),
  [x("insertChildBefore")]: onXML((rt, o, node, c1, c2) => insertChild(rt, o, node, c1, c2, false)),
  [x("localName")]: onXML((_rt, _o, node) => node.name),
  [x("name")]: onXML((rt, _o, node) => (node.name === null ? null : qnameOf(rt, node))),
  "XML#XML::_namespace": onXML((rt, _o, node, prefix, argc) => namespaceOf(rt, node, argc, prefix)),
  [x("namespaceDeclarations")]: onXML((rt, _o, node) => namespaceDeclarations(rt, node)),
  [x("nodeKind")]: onXML((_rt, _o, node) => node.nodeKind()),
  [x("normalize")]: onXML((rt, o, node) => {
    normalize(rt, node);
    return o;
  }),
  [x("parent")]: onXML((rt, _o, node) => (node.parent ? xmlOf(rt, node.parent) : undefined)),
  [x("processingInstructions")]: onXML((rt, o, node, name) =>
    processingInstructions(rt, o, node, star(name)),
  ),
  [x("prependChild")]: onXML((rt, o, node, v) => {
    const c = adopt(v);
    insertAt(rt, node, 0, c);
    childChanges(rt, node, "nodeAdded", c);
    return o;
  }),
  [x("removeNamespace")]: onXML((rt, o, node, v) => {
    removeNamespace(rt, node, v);
    return o;
  }),
  [x("replace")]: onXML((rt, o, node, name, v) => replace(rt, o, node, name, v)),
  [x("setChildren")]: onXML((rt, o, _node, v) => {
    setXML(rt, o, toXMLName(rt, "*"), v);
    return o;
  }),
  [x("setLocalName")]: onXML((rt, _o, node, name) => setLocalName(rt, node, name)),
  [x("setName")]: onXML((rt, _o, node, name) => setName(rt, node, name)),
  [x("setNamespace")]: onXML((rt, _o, node, ns) => setNamespace(rt, node, ns)),
  [x("text")]: onXML((rt, o, node) => childrenOf(rt, o, node, TEXT | CDATA)),
  [x("notification")]: onXML((_rt, _o, node) => node.notification ?? null),
  [x("setNotification")]: onXML((rt, _o, node, f) => {
    if (f !== null && f !== undefined && !f.$f) {
      throw rt.error("ArgumentError", 1508, "f");
    }

    if (node.kind === ELEMENT) {
      node.notification = f ?? null;
    }

    return undefined;
  }),

  [l("toString")]: onList((rt, o) => listToString(rt, o)),
  [l("toXMLString")]: onList((rt, o) => listToXMLString(rt, o)),
  [l("hasOwnProperty")]: onList((rt, o, _nodes, p) => hasList(rt, o, coerce(rt, toXMLName(rt, p)))),
  [l("propertyIsEnumerable")]: onList((rt, _o, nodes, p) => {
    const index = rt.toNumber(p);
    return index >= 0 && index < nodes.length;
  }),
  [l("attribute")]: onList((rt, o, _nodes, name) =>
    getList(rt, o, coerce(rt, toAttributeName(rt, name))),
  ),
  [l("attributes")]: onList((rt, o) => getList(rt, o, coerce(rt, toAttributeName(rt, "*")))),
  [l("child")]: onList((rt, o, nodes, name) => {
    const list = newList(rt, o);
    for (const node of nodes) {
      const r = child(rt, xmlOf(rt, node), node, name);
      if (r.$nodes.length) {
        append(list, r);
      }
    }

    return list;
  }),
  [l("children")]: onList((rt, o) => getList(rt, o, coerce(rt, toXMLName(rt, "*")))),
  [l("comments")]: eachElement((rt, x) => childrenOf(rt, x, x.$node, COMMENT)),
  [l("contains")]: onList((rt, _o, nodes, v) =>
    nodes.some((node) => rt.equals(xmlOf(rt, node), v)),
  ),
  [l("copy")]: onList((rt, o) => listDeepCopy(rt, o)),
  [l("descendants")]: onList((rt, o, _nodes, name) =>
    descendantsOfList(rt, o, toXMLName(rt, star(name))),
  ),
  [l("elements")]: onList((rt, o, nodes, name) => {
    const list = newList(rt, o, toXMLName(rt, star(name)));
    for (const node of nodes) {
      if (node.kind === ELEMENT) {
        const r = elements(rt, xmlOf(rt, node), node, star(name));
        if (r.$nodes.length) {
          append(list, r);
        }
      }
    }

    return list;
  }),
  [l("hasComplexContent")]: onList((_rt, _o, nodes) => {
    if (nodes.length === 1) {
      return nodes[0].hasComplexContent();
    }

    return nodes.some((n) => n.kind === ELEMENT);
  }),
  [l("hasSimpleContent")]: onList((_rt, _o, nodes) => listHasSimpleContent(nodes)),
  [l("length")]: onList((_rt, _o, nodes) => nodes.length),
  [l("name")]: onlyOne("name", (rt, x) => (x.$node.name === null ? null : qnameOf(rt, x.$node))),
  [l("normalize")]: onList((rt, o, nodes) => {
    let i = 0;
    while (i < nodes.length) {
      const xn = nodes[i];
      if (xn.kind === ELEMENT) {
        normalize(rt, xn);
        i++;
      } else if (xn.kind & (TEXT | CDATA)) {
        while (i + 1 < nodes.length && nodes[i + 1].kind & (TEXT | CDATA)) {
          xn.value += nodes[i + 1].value;
          deleteIndex(rt, o, i + 1);
        }

        if (xn.value.length === 0) {
          deleteIndex(rt, o, i);
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return o;
  }),
  [l("parent")]: onList((rt, _o, nodes) => {
    if (!nodes.length) {
      return undefined;
    }

    const parent = nodes[0].parent;
    if (!parent || nodes.some((n) => n.parent !== parent)) {
      return undefined;
    }

    return xmlOf(rt, parent);
  }),
  [l("processingInstructions")]: eachElement((rt, x, name) =>
    processingInstructions(rt, x, x.$node, star(name)),
  ),
  [l("text")]: eachElement((rt, x) => childrenOf(rt, x, x.$node, TEXT | CDATA)),
  [l("addNamespace")]: onlyOne("addNamespace", (rt, x, v) => addNamespace(rt, x, x.$node, v)),
  [l("appendChild")]: onlyOne("appendChild", (rt, x, c) => appendChild(rt, x, x.$node, c)),
  [l("childIndex")]: onlyOne("childIndex", (_rt, x) => x.$node.childIndex()),
  [l("inScopeNamespaces")]: onlyOne("inScopeNamespaces", (rt, x) => {
    const list = x.$node.inScopeNamespaces();
    return rt.newArray(list.length ? list : [publicNs]);
  }),
  [l("insertChildAfter")]: onlyOne("insertChildAfter", (rt, x, c1, c2) =>
    insertChild(rt, x, x.$node, c1, c2, true),
  ),
  [l("insertChildBefore")]: onlyOne("insertChildBefore", (rt, x, c1, c2) =>
    insertChild(rt, x, x.$node, c1, c2, false),
  ),
  [l("nodeKind")]: onlyOne("nodeKind", (_rt, x) => x.$node.nodeKind()),
  "XMLList#XMLList::_namespace": onlyOne("namespace", (rt, x, prefix, argc) =>
    namespaceOf(rt, x.$node, argc, prefix),
  ),
  [l("localName")]: onlyOne("localName", (_rt, x) => x.$node.name),
  [l("namespaceDeclarations")]: onlyOne("namespaceDeclarations", (rt, x) =>
    namespaceDeclarations(rt, x.$node),
  ),
  [l("prependChild")]: onlyOne("prependChild", (rt, x, v) => {
    const c = adopt(v);
    insertAt(rt, x.$node, 0, c);
    childChanges(rt, x.$node, "nodeAdded", c);
    return x;
  }),
  [l("removeNamespace")]: onlyOne("removeNamespace", (rt, x, v) => {
    removeNamespace(rt, x.$node, v);
    return x;
  }),
  [l("replace")]: onlyOne("replace", (rt, x, name, v) => replace(rt, x, x.$node, name, v)),
  [l("setChildren")]: onlyOne("setChildren", (rt, x, v) => {
    setXML(rt, x, toXMLName(rt, "*"), v);
    return x;
  }),
  [l("setLocalName")]: onlyOne("setLocalName", (rt, x, name) => setLocalName(rt, x.$node, name)),
  [l("setName")]: onlyOne("setName", (rt, x, name) => setName(rt, x.$node, name)),
  [l("setNamespace")]: onlyOne("setNamespace", (rt, x, ns) => setNamespace(rt, x.$node, ns)),

  isXMLName: (rt) => (v: Value) => v !== null && v !== undefined && isXMLName(rt.toString(v)),
};
