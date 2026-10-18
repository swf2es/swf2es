// E4X's names: property names coerced to XML names, and the Namespaces
// and QNames E4X makes and compares.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp and E4X's
// parts of Toplevel.cpp and AvmCore.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import {
  CONSTANT_Qname,
  CONSTANT_QnameA,
  type Multiname,
  Namespace,
  NS_Public,
  namespace,
  prefixedNamespace,
  prefixOf,
  publicNs,
} from "../../names.js";
import type { Runtime } from "../../runtime.js";
import { isXMLName } from "./chars.js";
import { ATTRIBUTE, ELEMENT, matches, type XMLNode, type XName } from "./node.js";
import { ANY, e4x, NAMESPACE_WITH_PREFIX_AND_NO_URI } from "./values.js";

// Names.

/** As String::parseIndex: a name's index, or -1. */
export function parseIndex(name: string): number {
  const c = name.charCodeAt(0);
  if (!(c >= 0x30 && c <= 0x39)) {
    return -1;
  }

  const i = Number(name);
  return i >>> 0 === i && i !== 0xffffffff && String(i) === name ? i : -1;
}

/** An index name: not any name, nor an attribute's. */
export const indexOf = (n: XName): number =>
  n.attribute || n.local === null ? -1 : parseIndex(n.local);

/** Whether `ns` is `other`, prefix, URI and kind, as CoerceE4XMultiname compares them. */
const sameNamespace = (ns: Namespace | null, other: Namespace): boolean =>
  ns !== null && ns.uri === other.uri && ns.kind === other.kind && prefixOf(ns) === prefixOf(other);

/**
 * As CoerceE4XMultiname: an unqualified name in the default XML namespace
 * too, and a name of "*" or starting with "@" as any name or an
 * attribute's.
 */
export function coerce(rt: Runtime, n: XName): XName {
  let namespaces = n.namespaces;
  if (!n.qualified && namespaces !== null) {
    const dxns = rt.defaultXmlNamespace;
    if (!namespaces.some((ns) => sameNamespace(ns, dxns))) {
      namespaces = [...namespaces, dxns];
    }
  }

  let local = n.local;
  let attribute = n.attribute;
  if (local === "*") {
    local = null;
  } else if (local !== null && local.charCodeAt(0) === 0x40 && !attribute) {
    local = local === "@*" ? null : local.slice(1);
    attribute = true;
  }

  if (namespaces === n.namespaces && local === n.local && attribute === n.attribute) {
    return n;
  }

  return { local, namespaces, attribute, qualified: n.qualified };
}

/** A property's multiname as E4X names: a Qname is qualified, its namespace null for any. */
export function fromMultiname(mn: Multiname): XName {
  const qualified = mn.kind === CONSTANT_Qname || mn.kind === CONSTANT_QnameA;
  const all = mn.namespaces;
  let namespaces: Namespace[] | null;
  if (qualified) {
    namespaces = all[0] ? [all[0]] : null;
  } else {
    namespaces = all.some((ns) => ns === null) ? null : (all as Namespace[]);
  }

  return { local: mn.name, namespaces, attribute: mn.attribute, qualified };
}

/**
 * As ToXMLName: a name for a method's argument, as XML's child() takes
 * one. A QName is its local name, in a namespace of its URI; anything else
 * is its string, in the public namespace: "@name" an attribute's, "*" any.
 */
export function toXMLName(rt: Runtime, p: Value): XName {
  if (p === null || p === undefined) {
    throw rt.error("TypeError", 1010);
  }

  let s: string;
  if (p instanceof Namespace) {
    s = p.uri ?? "";
  } else if (p.$local !== undefined) {
    // avmplus makes the namespace of the URI's string: "null" for any.
    return {
      local: p.$local,
      namespaces: [namespace(NS_Public, p.$ns ? p.$ns.uri : "null")],
      attribute: p.$attr === true,
      qualified: false,
    };
  } else {
    s = rt.toString(p);
  }

  let local: string | null = s;
  let attribute = false;
  if (s.charCodeAt(0) === 0x40) {
    local = s.slice(1);
    attribute = true;
  }

  if (local === "*") {
    local = null;
  }

  return { local, namespaces: [publicNs], attribute, qualified: false };
}

/** As ToAttributeName and then ToXMLName: an attribute's name for XML's attribute(). */
export function toAttributeName(rt: Runtime, v: Value): XName {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") {
    throw rt.error("TypeError", 1010);
  }

  if (typeof v === "object" && !(v instanceof Namespace) && v.$local !== undefined) {
    return { ...toXMLName(rt, v), attribute: true };
  }

  const s = v instanceof Namespace ? (v.uri ?? "") : rt.toString(v);
  const uri = s === "*" ? "null" : rt.defaultXmlNamespace.uri;
  return {
    local: s === "*" ? null : s,
    namespaces: [namespace(NS_Public, uri)],
    attribute: true,
    qualified: false,
  };
}

/** Whether `n` names child `child`: only an element has a name to match. */
export const matchesChild = (n: XName, child: XMLNode) =>
  matches(n, child.kind === ELEMENT ? child : null);

// Namespaces and QNames.

/** As AvmCore::newNamespace(uri): a Namespace's own, a QName's URI's, or of a string. */
export function newNamespace(rt: Runtime, uri: Value): Namespace {
  if (uri instanceof Namespace) {
    return uri;
  }

  if (typeof uri === "object" && uri !== null && uri.$local !== undefined && uri.$ns) {
    return namespace(NS_Public, uri.$ns.uri);
  }

  return namespace(NS_Public, rt.toString(uri));
}

/**
 * As AvmCore::newNamespace(prefix, uri): a namespace with a prefix, none
 * if it is not an XML name, or null for a prefix of the empty URI.
 */
export function newPrefixedNamespace(rt: Runtime, prefix: Value, uri: Value): Namespace | null {
  const u =
    typeof uri === "object" && uri !== null && uri.$local !== undefined && uri.$ns
      ? (uri.$ns.uri as string)
      : rt.toString(uri);
  if (u === "") {
    return prefix === undefined || rt.toString(prefix) === "" ? publicNs : null;
  }

  if (prefix === undefined) {
    return namespace(NS_Public, u);
  }

  const p = rt.toString(prefix);
  if (p !== "" && !isXMLName(p)) {
    return namespace(NS_Public, u);
  }

  return prefixedNamespace(p, u);
}

/** As NamespaceClass::construct: Namespace(), Namespace(uri) or Namespace(prefix, uri). */
export function constructNamespace(rt: Runtime, args: Value[]): Namespace {
  if (args.length === 0) {
    return publicNs;
  }

  if (args.length === 1) {
    return newNamespace(rt, args[0]);
  }

  const p = rt.toString(args[0]);
  if (p.length && !rt.toString(args[1]).length) {
    throw rt.error("TypeError", NAMESPACE_WITH_PREFIX_AND_NO_URI, p);
  }

  return newPrefixedNamespace(rt, args[0], args[1]) ?? publicNs;
}

/** A QName object of a node's name, as XML's name() gives it. */
export function qnameOf(rt: Runtime, node: XMLNode): AsObject {
  const q = e4x(rt).qname.instance();
  q.$ns = node.ns;
  q.$local = node.name;
  q.$attr = node.kind === ATTRIBUTE;
  return q;
}

/**
 * As QNameObject(name), with no namespace: a QName's name, else any name
 * in any namespace for "*", or the name in the default XML namespace.
 */
export function qnameName(rt: Runtime, name: Value): XName {
  if (typeof name === "object" && name !== null && name.$local !== undefined) {
    return {
      local: name.$local,
      namespaces: name.$ns ? [name.$ns] : null,
      attribute: name.$attr === true,
      qualified: name.$ns !== null,
    };
  }

  const s = name === undefined ? "" : rt.toString(name);
  if (s === "*") {
    return ANY;
  }

  return { local: s, namespaces: [rt.defaultXmlNamespace], attribute: false, qualified: true };
}

/** As GetNamespace: the namespace of `ns`'s URI among `list`, else one of its URI. */
export function getNamespace(ns: Namespace, list: Namespace[]): Namespace {
  for (const ns2 of list) {
    if (ns2.uri === ns.uri) {
      return ns2;
    }
  }

  return namespace(NS_Public, ns.uri);
}

export const hasPrefix = (ns: Namespace) => {
  const p = prefixOf(ns);
  return p !== undefined && p !== "";
};
