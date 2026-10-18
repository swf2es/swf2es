// E4X's internal methods, E4X 9.1.1 and 9.2.1: XML's and XMLList's get,
// put, delete, has and descendants, the tree changes they make, and the
// notifications those send.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp and
// E4XNode.cpp, this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import type { Runtime } from "../../runtime.js";
import { deepCopy, listDeepCopy, toXML } from "./build.js";
import { isXMLName } from "./chars.js";
import { coerce, indexOf, matchesChild, toXMLName } from "./names.js";
import {
  ATTRIBUTE,
  CDATA,
  COMMENT,
  ELEMENT,
  matches,
  PROCESSING_INSTRUCTION,
  TEXT,
  XMLNode,
  type XName,
} from "./node.js";
import {
  ASSIGNMENT_ONE_ITEM_LISTS,
  ASSIGNMENT_TO_INDEXED_XML,
  append,
  appendNode,
  fixTarget,
  ILLEGAL_CYCLICAL_LOOP,
  isList,
  isXML,
  newList,
  xmlOf,
} from "./values.js";

// Notifications, as setNotification sets a function to call on changes.

export function notifyNeeded(node: XMLNode | null): boolean {
  for (let n = node; n; n = n.parent) {
    if (n.notification) {
      return true;
    }
  }

  return false;
}

function issueNotifications(
  rt: Runtime,
  initial: XMLNode,
  target: AsObject,
  type: string,
  value: Value,
  detail: Value,
): void {
  for (let n: XMLNode | null = initial; n; n = n.parent) {
    if (n.notification) {
      rt.callValue(n.notification, null, [xmlOf(rt, n), type, target, value, detail], null);
    }
  }
}

export function childChanges(
  rt: Runtime,
  node: XMLNode,
  type: string,
  value: Value,
  prior: XMLNode | null = null,
): void {
  if (notifyNeeded(node) && (isXML(value) || isList(value))) {
    const detail = prior ? xmlOf(rt, prior) : undefined;
    issueNotifications(rt, node, xmlOf(rt, node), type, value, detail);
  }
}

export function nonChildChanges(
  rt: Runtime,
  node: XMLNode,
  type: string,
  value: Value,
  detail: Value = undefined,
): void {
  if (notifyNeeded(node)) {
    issueNotifications(rt, node, xmlOf(rt, node), type, value, detail);
  }
}

// The tree changed by values, as ElementE4XNode's _insert and _replace.

function checkCycle(rt: Runtime, x: XMLNode, node: XMLNode): void {
  for (let n: XMLNode | null = x; n; n = n.parent) {
    if (n === node) {
      throw rt.error("TypeError", ILLEGAL_CYCLICAL_LOOP);
    }
  }
}

/** As _insert: `value` (an XMLList's nodes, else a node as _replace makes it) at `entry`. */
export function insertAt(rt: Runtime, x: XMLNode, entry: number, value: Value): void {
  if (x.kind !== ELEMENT) {
    return;
  }

  if (isList(value)) {
    const nodes: XMLNode[] = value.$nodes;
    for (let j = 0; j < nodes.length; j++) {
      const child = nodes[j];
      checkCycle(rt, x, child);
      child.parent = x;
      x.children.splice(entry + j, 0, child);
    }

    return;
  }

  if (isXML(value)) {
    checkCycle(rt, x, value.$node);
  }

  x.children.splice(entry, 0, null as unknown as XMLNode);
  replaceAt(rt, x, entry, value);
}

/**
 * As _replace: child `i` (or a new last one) replaced by `v`: an XML
 * node itself, an XMLList's nodes, or a text node of anything else's
 * string. Gives the child it replaced.
 */
export function replaceAt(
  rt: Runtime,
  x: XMLNode,
  index: number,
  v: Value,
  pastValue: Value = undefined,
): XMLNode | null {
  if (x.kind !== ELEMENT) {
    return null;
  }

  let i = index;
  if (i >= x.children.length) {
    i = x.children.length;
    x.children.push(null as unknown as XMLNode);
  }

  const prior: XMLNode | null = x.children[i];
  if (isXML(v) && v.$node.kind & (ELEMENT | COMMENT | PROCESSING_INSTRUCTION | TEXT | CDATA)) {
    const node: XMLNode = v.$node;
    if (node.kind === ELEMENT) {
      checkCycle(rt, x, node);
    }

    node.parent = x;
    if (prior) {
      prior.parent = null;
    }

    x.children[i] = node;
  } else if (isList(v)) {
    x.deleteByIndex(i);
    insertAt(rt, x, i, v);
  } else {
    const text = new XMLNode(TEXT, rt.toString(v));
    text.parent = x;
    if (prior) {
      prior.parent = null;
    }

    x.children[i] = text;
    if (notifyNeeded(text)) {
      const detail = prior && prior.kind !== ELEMENT ? prior.value : pastValue;
      nonChildChanges(rt, text, "textSet", text.value, detail);
    }
  }

  return prior;
}

// XML's internal methods, E4X 9.1.1, on a node, with a name not yet coerced.

/** [[Get]]: the attributes or children the name names, or the node itself as index 0. */
export function getXML(rt: Runtime, o: AsObject, name: XName): Value {
  const n = coerce(rt, name);
  const index = indexOf(n);
  if (index >= 0) {
    return index === 0 ? o : undefined;
  }

  const node: XMLNode = o.$node;
  const list = newList(rt, o, n);
  if (n.attribute) {
    for (const a of node.attributes) {
      if (matches(n, a)) {
        appendNode(list, a);
      }
    }
  } else {
    for (const child of node.children) {
      if (matchesChild(n, child)) {
        appendNode(list, child);
      }
    }
  }

  return list;
}

/** [[Put]]. */
export function setXML(rt: Runtime, o: AsObject, name: XName, value: Value): void {
  const n = coerce(rt, name);
  if (indexOf(n) >= 0) {
    throw rt.error("TypeError", ASSIGNMENT_TO_INDEXED_XML);
  }

  const node: XMLNode = o.$node;
  if (node.kind & (TEXT | CDATA | COMMENT | PROCESSING_INSTRUCTION | ATTRIBUTE)) {
    return;
  }

  let c: Value;
  if (isList(value)) {
    const nodes: XMLNode[] = value.$nodes;
    c =
      nodes.length === 1 && nodes[0].kind & (TEXT | ATTRIBUTE)
        ? rt.toString(value)
        : listDeepCopy(rt, value);
  } else if (isXML(value)) {
    c =
      value.$node.kind & (TEXT | ATTRIBUTE)
        ? rt.toString(value)
        : xmlOf(rt, deepCopy(rt, value.$node));
  } else {
    c = rt.toString(value);
  }

  if (n.attribute) {
    let sc: string;
    if (isList(c)) {
      sc = (c.$nodes as XMLNode[]).map((x) => rt.toString(xmlOf(rt, x))).join(" ");
    } else {
      sc = rt.toString(c);
    }

    let a = -1;
    for (let j = 0; j < node.attributes.length; j++) {
      const x = node.attributes[j];
      if (matches(n, x)) {
        if (a === -1) {
          a = j;
        } else {
          deleteXML(rt, o, x.xname() as XName);
        }
      }
    }

    if (a === -1) {
      const e = new XMLNode(ATTRIBUTE, sc);
      e.parent = node;
      e.setName(n.local, n.namespaces?.length === 1 ? n.namespaces[0] : null);
      node.attributes.push(e);
      nonChildChanges(rt, node, "attributeAdded", n.local, sc);
    } else {
      const x = node.attributes[a];
      const prior = x.value;
      x.value = sc;
      nonChildChanges(rt, node, "attributeChanged", n.local, prior);
    }

    return;
  }

  if (n.local !== null && !isXMLName(n.local)) {
    return;
  }

  let i = -1;
  const primitiveAssign = !isXML(c) && !isList(c) && n.local !== null;
  const notify = notifyNeeded(node);
  for (let k = node.children.length - 1; k >= 0; k--) {
    if (matchesChild(n, node.children[k])) {
      // All but the first of those it names are removed.
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
    i = node.children.length;
    if (primitiveAssign) {
      const e = new XMLNode(ELEMENT);
      e.parent = node;
      const ns =
        n.namespaces === null
          ? null
          : n.namespaces.length === 1
            ? n.namespaces[0]
            : rt.defaultXmlNamespace;
      e.setName(n.local, ns);
      replaceAt(rt, node, i, xmlOf(rt, e));
      e.addInScopeNamespace(ns);
    }
  }

  if (primitiveAssign) {
    const xi = node.children[i];
    let prior: Value;
    if (notifyNeeded(xi)) {
      for (const child of xi.children) {
        if (child.kind === ELEMENT) {
          childChanges(rt, xi, "nodeRemoved", xmlOf(rt, child));
        }
      }

      if (xi.children.length) {
        prior = xmlOf(rt, xi.children[0]);
      }
    }

    xi.children.length = 0;
    const s = rt.toString(c);
    if (s.length) {
      replaceAt(rt, xi, 0, c, prior);
    }
  } else {
    const prior = replaceAt(rt, node, i, c);
    if (notifyNeeded(node) && node.children.length > i) {
      childChanges(
        rt,
        node,
        prior ? "nodeChanged" : "nodeAdded",
        xmlOf(rt, node.children[i]),
        prior,
      );
    }
  }
}

/** [[Delete]]. */
export function deleteXML(rt: Runtime, o: AsObject, name: XName): boolean {
  const n = coerce(rt, name);
  if (indexOf(n) >= 0) {
    return true;
  }

  const node: XMLNode = o.$node;
  if (n.attribute) {
    let j = 0;
    while (j < node.attributes.length) {
      const x = node.attributes[j];
      if (matches(n, x)) {
        x.parent = null;
        node.attributes.splice(j, 1);
        nonChildChanges(rt, node, "attributeRemoved", x.name ?? undefined, x.value);
      } else {
        j++;
      }
    }

    return true;
  }

  const notify = notifyNeeded(node);
  let q = 0;
  while (q < node.children.length) {
    const x = node.children[q];
    if (matchesChild(n, x)) {
      x.parent = null;
      node.deleteByIndex(q);
      if (notify && x.kind === ELEMENT) {
        childChanges(rt, node, "nodeRemoved", xmlOf(rt, x));
      }
    } else {
      q++;
    }
  }

  return true;
}

/** [[HasProperty]]. */
export function hasXML(rt: Runtime, o: AsObject, name: XName): boolean {
  const n = coerce(rt, name);
  const index = indexOf(n);
  if (index >= 0) {
    return index === 0;
  }

  const node: XMLNode = o.$node;
  if (n.attribute) {
    return node.attributes.some((a) => matches(n, a));
  }

  return node.children.some((c) => matchesChild(n, c));
}

/** [[Descendants]]: the attributes or elements the name names, in each child, depth first. */
export function descendantsOf(rt: Runtime, node: XMLNode, name: XName): AsObject {
  const n = coerce(rt, name);
  const list = newList(rt);
  if (n.attribute) {
    for (const a of node.attributes) {
      if (matches(n, a)) {
        appendNode(list, a);
      }
    }
  }

  for (const child of node.children) {
    if (!n.attribute && matchesChild(n, child)) {
      appendNode(list, child);
    }

    const dq = descendantsOf(rt, child, n);
    if (dq.$nodes.length) {
      append(list, dq);
    }
  }

  return list;
}

// XMLList's internal methods, E4X 9.2.1.

export function getList(rt: Runtime, o: AsObject, n: XName): Value {
  const nodes: XMLNode[] = o.$nodes;
  const index = indexOf(n);
  if (index >= 0) {
    return index < nodes.length ? xmlOf(rt, nodes[index]) : undefined;
  }

  const list = newList(rt, o, n);
  for (const node of nodes) {
    if (node.kind === ELEMENT) {
      const gq = getXML(rt, xmlOf(rt, node), n);
      if (gq.$nodes.length) {
        append(list, gq);
      }
    }
  }

  return list;
}

export function setList(rt: Runtime, o: AsObject, n: XName, value: Value): void {
  const index = indexOf(n);
  if (index >= 0) {
    setIndex(rt, o, index, value);
    return;
  }

  const nodes: XMLNode[] = o.$nodes;
  if (nodes.length > 1) {
    throw rt.error("TypeError", ASSIGNMENT_ONE_ITEM_LISTS);
  }

  if (nodes.length === 0) {
    const r = resolveValue(rt, o);
    if (r === null) {
      return;
    }

    // As avmplus: an XML value's own length is its children's.
    if (isXML(r) && r.$node.children.length !== 1) {
      return;
    }

    if (isList(r) && r.$nodes.length !== 1) {
      return;
    }

    append(o, r);
  }

  setXML(rt, xmlOf(rt, nodes[0]), n, value);
}

export function deleteList(rt: Runtime, o: AsObject, n: XName): boolean {
  const index = indexOf(n);
  if (index >= 0) {
    return deleteIndex(rt, o, index);
  }

  for (const node of o.$nodes as XMLNode[]) {
    if (node.kind === ELEMENT) {
      deleteXML(rt, xmlOf(rt, node), n);
    }
  }

  return true;
}

export function hasList(rt: Runtime, o: AsObject, n: XName): boolean {
  const nodes: XMLNode[] = o.$nodes;
  const index = indexOf(n);
  if (index >= 0) {
    return index < nodes.length;
  }

  return nodes.some((node) => node.kind === ELEMENT && hasXML(rt, xmlOf(rt, node), n));
}

export function descendantsOfList(rt: Runtime, o: AsObject, n: XName): AsObject {
  const list = newList(rt);
  for (const node of o.$nodes as XMLNode[]) {
    if (node.kind === ELEMENT) {
      const dq = descendantsOf(rt, node, n);
      if (dq.$nodes.length) {
        append(list, dq);
      }
    }
  }

  return list;
}

/**
 * As _resolveValue: a list with nodes; an empty one, the property of its
 * target it was got from, which is made, empty, if there is none, so that
 * assigning to x.a.b makes <a>.
 */
function resolveValue(rt: Runtime, v: Value): Value {
  if (isXML(v)) {
    return v;
  }

  if (v.$nodes.length > 0) {
    return v;
  }

  fixTarget(rt, v);
  const property: XName = v.$targetProperty;
  if (v.$target === null || property.attribute || property.local === null) {
    return null;
  }

  const base = resolveValue(rt, v.$target);
  if (base === null) {
    return null;
  }

  const get = (b: Value) =>
    isXML(b) ? getXML(rt, b, property) : getList(rt, b, coerce(rt, property));
  const target = get(base);
  if (!isList(target)) {
    return null;
  }

  if (!target.$nodes.length) {
    if (isList(base) && base.$nodes.length > 1) {
      throw rt.error("TypeError", ASSIGNMENT_ONE_ITEM_LISTS);
    }

    if (isXML(base)) {
      setXML(rt, base, property, "");
    } else {
      setList(rt, base, coerce(rt, property), "");
    }

    return get(base);
  }

  return target;
}

/** As XMLListObject::setUintProperty: item i, or a new last one, set to `value`. */
export function setIndex(rt: Runtime, o: AsObject, index: number, value: Value): void {
  const nodes: XMLNode[] = o.$nodes;
  let i = index;
  let v = value;
  let r: Value = null;
  fixTarget(rt, o);
  if (o.$target !== null) {
    r = resolveValue(rt, o.$target);
    if (r === null) {
      return;
    }
  }

  if (i >= nodes.length) {
    if (isList(r)) {
      if (r.$nodes.length !== 1) {
        return;
      }

      r = xmlOf(rt, r.$nodes[0]);
    }

    const rx: XMLNode | null = isXML(r) ? r.$node : null;
    if (rx && rx.kind !== ELEMENT) {
      return;
    }

    const property: XName = o.$targetProperty;
    let y: XMLNode;
    if (property.attribute) {
      if (!rx) {
        return;
      }

      const exists = getXML(rt, r, property);
      if (isList(exists) && exists.$nodes.length > 0) {
        return;
      }

      y = new XMLNode(ATTRIBUTE);
      y.parent = rx;
      y.setName(property.local, property.namespaces?.[0] ?? null);
      nonChildChanges(rt, rx, "attributeAdded", property.local);
    } else if (
      property.local === null ||
      (isXML(v) && (v.$node.kind === ATTRIBUTE || v.$node.kind === TEXT))
    ) {
      y = new XMLNode(TEXT);
      y.parent = rx;
    } else {
      y = new XMLNode(ELEMENT);
      y.parent = rx;
      y.setName(property.local, property.namespaces?.[0] ?? null);
    }

    i = nodes.length;
    if (y.kind !== ATTRIBUTE) {
      const parent = y.parent;
      if (parent) {
        // After the list's last node among the parent's children, else last.
        let j: number;
        if (i > 0) {
          j = 0;
          while (j < parent.children.length - 1 && parent.children[j] !== nodes[i - 1]) {
            j++;
          }

          j++;
        } else {
          j = parent.children.length;
        }

        parent.children.splice(j, 0, y);
      }

      if (isXML(v)) {
        const node: XMLNode = v.$node;
        if (node.name !== null) {
          y.setName(node.name, node.ns);
        }
      } else if (isList(v)) {
        const p: XName = v.$targetProperty;
        if (p.local !== null) {
          y.setName(p.local, p.namespaces?.[0] ?? null);
        }
      }
    }

    appendNode(o, y);
  }

  if (isList(v)) {
    const src: XMLNode[] = v.$nodes;
    if (src.length === 1 && src[0].kind & (TEXT | ATTRIBUTE)) {
      v = rt.toString(v);
    }
  } else if (isXML(v)) {
    if (v.$node.kind & (TEXT | ATTRIBUTE)) {
      v = rt.toString(v);
    }
  } else {
    v = rt.toString(v);
  }

  const xi = nodes[i];
  if (xi.kind === ATTRIBUTE) {
    if (!xi.parent) {
      return;
    }

    const parent = xmlOf(rt, xi.parent);
    const name = xi.xname() as XName;
    setXML(rt, parent, name, v);
    const attr = getXML(rt, parent, name);
    nodes[i] = attr.$nodes[0];
  } else if (isList(v)) {
    const c = newList(rt);
    c.$nodes.push(...v.$nodes);
    const parent = xi.parent;
    if (parent) {
      const q = parent.children.indexOf(xi);
      if (q >= 0) {
        replaceAt(rt, parent, q, c);
        for (let j = 0; j < c.$nodes.length; j++) {
          c.$nodes[j] = parent.children[q + j];
        }
      }
    }

    const notify = parent !== null && notifyNeeded(parent);
    const prior = xi;
    nodes.splice(i, 1, ...c.$nodes);
    if (notify && parent) {
      for (let i2 = 0; i2 < c.$nodes.length; i2++) {
        const node: XMLNode = c.$nodes[i2];
        if (parent === node.parent) {
          if (i2 === 0) {
            if (node !== prior) {
              childChanges(rt, parent, "nodeChanged", xmlOf(rt, node), prior);
            }
          } else {
            childChanges(rt, parent, "nodeAdded", xmlOf(rt, node));
          }
        }
      }
    }
  } else if (isXML(v) || xi.kind & (TEXT | CDATA | COMMENT | PROCESSING_INSTRUCTION)) {
    const parent = xi.parent;
    if (parent) {
      const q = parent.children.indexOf(xi);
      if (q >= 0) {
        replaceAt(rt, parent, q, v);
        v = xmlOf(rt, parent.children[q]);
        if (notifyNeeded(parent)) {
          childChanges(rt, parent, "nodeAdded", v);
        }
      }
    }

    nodes[i] = (isXML(v) ? v : toXML(rt, v)).$node;
  } else {
    setXML(rt, xmlOf(rt, xi), toXMLName(rt, "*"), v);
  }
}

/** As XMLListObject::delUintProperty: item `index` out of the list, and out of its parent. */
export function deleteIndex(rt: Runtime, o: AsObject, index: number): boolean {
  const nodes: XMLNode[] = o.$nodes;
  if (index >= nodes.length) {
    return true;
  }

  const xi = nodes[index];
  const px = xi.parent;
  if (px) {
    if (xi.kind === ATTRIBUTE) {
      deleteXML(rt, xmlOf(rt, px), xi.xname() as XName);
    } else {
      const q = xi.childIndex();
      const x = px.children[q];
      px.deleteByIndex(q);
      if (x && notifyNeeded(px) && x.kind === ELEMENT) {
        childChanges(rt, px, "nodeRemoved", xmlOf(rt, x));
      }
    }
  }

  if (index < nodes.length) {
    nodes.splice(index, 1);
  }

  return true;
}
