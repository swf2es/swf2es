// E4X: XML and XMLList, as avmplus has them. An XML value stands for one
// node of the tree (node.ts), and is the same object each time, so that XML
// values compare by the node they are; an XMLList holds nodes, and the
// object and name it was got from, which assignments to it write back to.
// Names are looked up by PropertyHook in place of dynamic properties.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp,
// XMLClass.cpp, XMLListClass.cpp and E4X's parts of Toplevel.cpp and
// AvmCore.cpp, this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import type { ClassHook, PropertyHook } from "../../hooks.js";
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
import type { Runtime, Traits } from "../../runtime.js";
import { escapeAttributeValue, escapeElementValue } from "../../runtime.js";
import { AS3, type Natives } from "../define.js";
import { isSpace, isXMLName } from "./chars.js";
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
import * as P from "./parser.js";

// Error numbers, as avmplus' kXML* errors.
const PREFIX_NOT_BOUND = 1083;
const BAD_QNAME = 1084;
const UNTERMINATED_ELEMENT_TAG = 1085;
const ONLY_ONE_ITEM_LISTS = 1086;
const ASSIGNMENT_TO_INDEXED_XML = 1087;
const MARKUP_MUST_BE_WELL_FORMED = 1088;
const ASSIGNMENT_ONE_ITEM_LISTS = 1089;
const NAMESPACE_WITH_PREFIX_AND_NO_URI = 1098;
const DUPLICATE_ATTRIBUTE = 1104;
const INVALID_NAME = 1117;
const ILLEGAL_CYCLICAL_LOOP = 1118;

/** What each of the parser's errors throws. */
const PARSE_ERRORS: Record<number, number> = {
  [P.MALFORMED_ELEMENT]: 1090,
  [P.UNTERMINATED_CDATA]: 1091,
  [P.UNTERMINATED_XML_DECLARATION]: 1092,
  [P.UNTERMINATED_DOCTYPE]: 1093,
  [P.UNTERMINATED_COMMENT]: 1094,
  [P.UNTERMINATED_ATTRIBUTE_VALUE]: 1095,
  [P.UNTERMINATED_PROCESSING_INSTRUCTION]: 1097,
};

const XML_1998 = "http://www.w3.org/XML/1998/namespace";

/** Any name in any namespace: an XMLList's target property when it has none. */
const ANY: XName = { local: null, namespaces: null, attribute: false, qualified: false };

// E4X for each runtime: XML's settings, and the classes' traits.

interface E4X {
  ignoreComments: boolean;
  ignoreProcessingInstructions: boolean;
  ignoreWhitespace: boolean;
  prettyPrinting: boolean;
  prettyIndent: number;
  xml: Traits;
  list: Traits;
  qname: Traits;
}

const states = new WeakMap<Runtime, E4X>();

function e4x(rt: Runtime): E4X {
  let state = states.get(rt);
  if (!state) {
    state = {
      ignoreComments: true,
      ignoreProcessingInstructions: true,
      ignoreWhitespace: true,
      prettyPrinting: true,
      prettyIndent: 2,
      xml: rt.builtinClass("XML").$it,
      list: rt.builtinClass("XMLList").$it,
      qname: rt.builtinClass("QName").$it,
    };
    states.set(rt, state);
  }

  return state;
}

const okToPrettyPrint = (e: E4X) => e.prettyPrinting && e.prettyIndent >= 0;

// XML and XMLList values.

const isXML = (v: Value): boolean => typeof v === "object" && v !== null && v.$node !== undefined;
const isList = (v: Value): boolean => typeof v === "object" && v !== null && v.$nodes !== undefined;

/** The XML object that stands for `node`, the same each time. */
function xmlOf(rt: Runtime, node: XMLNode): AsObject {
  let o = node.object;
  if (!o) {
    o = e4x(rt).xml.instance();
    o.$node = node;
    node.object = o;
  }

  return o;
}

/** A new XMLList, got from `target` by `property`. */
function newList(rt: Runtime, target: AsObject | null = null, property: XName = ANY): AsObject {
  const o = e4x(rt).list.instance();
  o.$nodes = [];
  o.$target = target;
  o.$targetProperty = property;
  o.$appended = false;
  return o;
}

/** As _appendNode. */
function appendNode(list: AsObject, node: XMLNode): void {
  list.$nodes.push(node);
  list.$appended = true;
}

/** As XMLListObject::_append: an XMLList's nodes, and its target, or an XML value's node. */
function append(list: AsObject, v: Value): void {
  if (isList(v)) {
    list.$target = v.$target;
    list.$targetProperty = v.$targetProperty;
    list.$appended = false;
    list.$nodes.push(...v.$nodes);
  } else if (isXML(v)) {
    list.$appended = true;
    list.$nodes.push(v.$node);
  }
}

/**
 * As fixTargetObject: once nodes were appended, the list's target is the
 * last one's parent, and its target property the last one's name.
 */
function fixTarget(rt: Runtime, list: AsObject): void {
  const nodes: XMLNode[] = list.$nodes;
  if (!list.$appended || !nodes.length) {
    return;
  }

  const v = nodes[nodes.length - 1];
  if (v.parent) {
    const target = list.$target;
    if (isXML(target) && target.$node !== v.parent) {
      list.$target = xmlOf(rt, v.parent);
    }
  } else {
    list.$target = null;
  }

  if (v.kind !== PROCESSING_INSTRUCTION) {
    const name = v.xname();
    if (name) {
      list.$targetProperty = name;
    }
  }

  list.$appended = false;
}

// Names.

/** As String::parseIndex: a name's index, or -1. */
function parseIndex(name: string): number {
  const c = name.charCodeAt(0);
  if (!(c >= 0x30 && c <= 0x39)) {
    return -1;
  }

  const i = Number(name);
  return i >>> 0 === i && i !== 0xffffffff && String(i) === name ? i : -1;
}

/** An index name: not any name, nor an attribute's. */
const indexOf = (n: XName): number => (n.attribute || n.local === null ? -1 : parseIndex(n.local));

/** Whether `ns` is `other`, prefix, URI and kind, as CoerceE4XMultiname compares them. */
const sameNamespace = (ns: Namespace | null, other: Namespace): boolean =>
  ns !== null && ns.uri === other.uri && ns.kind === other.kind && prefixOf(ns) === prefixOf(other);

/**
 * As CoerceE4XMultiname: an unqualified name in the default XML namespace
 * too, and a name of "*" or starting with "@" as any name or an
 * attribute's.
 */
function coerce(rt: Runtime, n: XName): XName {
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
function fromMultiname(mn: Multiname): XName {
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
function toXMLName(rt: Runtime, p: Value): XName {
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
function toAttributeName(rt: Runtime, v: Value): XName {
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
const matchesChild = (n: XName, child: XMLNode) =>
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
function qnameOf(rt: Runtime, node: XMLNode): AsObject {
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
function qnameName(rt: Runtime, name: Value): XName {
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
function getNamespace(ns: Namespace, list: Namespace[]): Namespace {
  for (const ns2 of list) {
    if (ns2.uri === ns.uri) {
      return ns2;
    }
  }

  return namespace(NS_Public, ns.uri);
}

const hasPrefix = (ns: Namespace) => {
  const p = prefixOf(ns);
  return p !== undefined && p !== "";
};

// Parsing.

/**
 * As the XMLObject constructor: `text` parsed, as the children of an
 * element for `defaultNs`, as E4X parses <parent xmlns=uri>text</parent>.
 */
function parse(rt: Runtime, text: string, defaultNs: Namespace): XMLNode {
  const e = e4x(rt);
  const parser = new P.XMLParser(text);
  parser.parse(e.ignoreWhitespace);
  parser.setCondenseWhite(true);

  const root = new XMLNode(ELEMENT);
  const ns = prefixedNamespace("", defaultNs.uri ?? "");
  root.addInScopeNamespace(ns);
  root.setName("parent", ns);
  let p = root;

  const tag = new P.XMLTag();
  for (;;) {
    const status = parser.getNext(tag);
    if (status === P.END) {
      break;
    }

    if (status !== P.OK) {
      throw rt.error("TypeError", PARSE_ERRORS[status]);
    }

    let node: XMLNode | null = null;
    switch (tag.type) {
      case P.TAG_ELEMENT:
        if (tag.text.charCodeAt(0) === 0x2f) {
          // A closing tag: its element's, else not well formed.
          const parentName = p.name as string;
          const pns = p.ns;
          const name = tag.text.slice(1);
          if (
            !nodeNameEquals(name, parentName, pns) &&
            !(parentName === name && pns.uri === rt.defaultXmlNamespace.uri)
          ) {
            if (p === root) {
              throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
            }

            throw rt.error("TypeError", UNTERMINATED_ELEMENT_TAG, parentName, parentName);
          }

          if (p === root) {
            throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
          }

          p = p.parent as XMLNode;
        } else {
          const element = new XMLNode(ELEMENT);
          p.append(element);
          if (!tag.empty) {
            p = element;
          }

          copyAttributesAndNamespaces(rt, element, tag);
          const [ns, local] = findNamespace(rt, element, tag.text, false);
          element.setName(local, ns ?? publicNs);
        }

        break;
      case P.TAG_COMMENT:
        if (!e.ignoreComments) {
          node = new XMLNode(COMMENT, tag.text);
        }

        break;
      case P.TAG_CDATA:
        node = new XMLNode(CDATA, tag.text);
        break;
      case P.TAG_TEXT:
        node = new XMLNode(TEXT, tag.text);
        break;
      case P.TAG_PROCESSING_INSTRUCTION:
        if (!e.ignoreProcessingInstructions) {
          const s = tag.text;
          let space = s.indexOf(" ");
          let name = s;
          let value = "";
          if (space >= 0) {
            name = s.slice(0, space);
            while (isSpace(s.charCodeAt(++space))) {}
            value = s.slice(space);
          }

          node = new XMLNode(PROCESSING_INSTRUCTION, value);
          node.setName(name, publicNs);
        }

        break;
    }

    if (node) {
      p.append(node);
    }
  }

  if (p !== root) {
    throw rt.error("TypeError", UNTERMINATED_ELEMENT_TAG, p.name, p.name);
  }

  return root;
}

/** As NodeNameEquals: whether a closing tag's name is its element's, with the prefix it has. */
function nodeNameEquals(name: string, parentName: string, ns: Namespace): boolean {
  if (hasPrefix(ns)) {
    return name === `${prefixOf(ns)}:${parentName}`;
  }

  return name === parentName;
}

/**
 * As FindNamespace: a tag's name's namespace, by its prefix among those in
 * scope, and its local name. An attribute without a prefix has none.
 */
function findNamespace(
  rt: Runtime,
  node: XMLNode,
  tagName: string,
  attribute: boolean,
): [Namespace | null, string] {
  const pos = tagName.indexOf(":");
  if (pos === 0) {
    throw rt.error("TypeError", BAD_QNAME, tagName);
  }

  let prefix = "";
  let local = tagName;
  if (pos > 0) {
    prefix = tagName.slice(0, pos);
    local = tagName.slice(pos + 1);
  }

  if (attribute && prefix === "") {
    return [null, local];
  }

  for (let y: XMLNode | null = node; y; y = y.parent) {
    for (const ns of y.namespaces) {
      if ((prefix === "" && !hasPrefix(ns)) || prefixOf(ns) === prefix) {
        return [ns, local];
      }
    }
  }

  if (prefix === "xml") {
    return [prefixedNamespace("", XML_1998), local];
  }

  if (prefix !== "") {
    throw rt.error("TypeError", PREFIX_NOT_BOUND, prefix, local);
  }

  return [null, local];
}

/** Whether an attribute's name is xmlns, or starts with xmlns: (either case). */
function isXmlns(name: string): boolean {
  return (
    name.length >= 5 &&
    name.slice(0, 5).toLowerCase() === "xmlns" &&
    (name.length === 5 || name[5] === ":")
  );
}

/**
 * As CopyAttributesAndNamespaces: a tag's namespace declarations first,
 * as an attribute can be in a namespace declared after it, then its
 * attributes; a second of one name is TypeError 1104.
 */
function copyAttributesAndNamespaces(rt: Runtime, element: XMLNode, tag: P.XMLTag): void {
  const attributes = tag.attributes;
  let count = 0;
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i];
    let ns: Namespace | null = null;
    if (isXmlns(name)) {
      if (name.length > 5) {
        if (name.length === 6) {
          throw rt.error("TypeError", BAD_QNAME, name);
        }

        ns = newPrefixedNamespace(rt, name.slice(6), attributes[i + 1]);
      } else {
        ns = newPrefixedNamespace(rt, "", attributes[i + 1]);
      }

      if (ns) {
        element.addInScopeNamespace(ns);
      }
    }

    if (!ns) {
      count++;
    }
  }

  if (!count) {
    return;
  }

  for (let i = 0; i < attributes.length; i += 2) {
    if (isXmlns(attributes[i])) {
      continue;
    }

    const attribute = new XMLNode(ATTRIBUTE, attributes[i + 1]);
    attribute.parent = element;
    const [ns, local] = findNamespace(rt, element, attributes[i], true);
    attribute.setName(local, ns ?? publicNs);
    for (const other of element.attributes) {
      if (matches(other.xname() as XName, attribute)) {
        throw rt.error("TypeError", DUPLICATE_ATTRIBUTE, local, tag.text, tag.text.length);
      }
    }

    element.attributes.push(attribute);
  }
}

// Conversions.

/** As ToXML: XML itself, a one-item XMLList's, or text parsed as one node. */
function toXML(rt: Runtime, v: Value): AsObject {
  if (v === null || v === undefined) {
    throw rt.error("TypeError", v === undefined ? 1010 : 1009);
  }

  if (isXML(v)) {
    return v;
  }

  if (isList(v)) {
    if (v.$nodes.length === 1) {
      return xmlOf(rt, v.$nodes[0]);
    }

    throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
  }

  const root = parse(rt, rt.toString(v), rt.defaultXmlNamespace);
  const children = root.children;
  let node: XMLNode;
  if (!children.length) {
    node = new XMLNode(TEXT, "");
  } else if (children.length === 1) {
    node = children[0];
  } else {
    // One element, with comments, processing instructions and whitespace around it.
    let element: XMLNode | null = null;
    for (const n of children) {
      if (n.kind === ELEMENT) {
        if (element) {
          throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
        }

        element = n;
      } else if (n.kind === TEXT && !isWhitespace(n.value)) {
        throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
      }
    }

    if (!element) {
      throw rt.error("TypeError", MARKUP_MUST_BE_WELL_FORMED);
    }

    node = element;
  }

  node.parent = null;
  return xmlOf(rt, node);
}

/** As ToXMLList: an XMLList itself, XML as a list of it, or text parsed as nodes. */
function toXMLList(rt: Runtime, v: Value): AsObject {
  if (v === null || v === undefined) {
    throw rt.error("TypeError", v === undefined ? 1010 : 1009);
  }

  if (isList(v)) {
    return v;
  }

  if (isXML(v)) {
    const node: XMLNode = v.$node;
    const list = newList(rt, node.parent ? xmlOf(rt, node.parent) : null, node.xname() ?? ANY);
    append(list, v);
    return list;
  }

  let s = rt.toString(v);
  if (s.startsWith("<>") && s.endsWith("</>")) {
    s = s.slice(2, s.length - 3);
  }

  const dxns = rt.defaultXmlNamespace;
  const root = parse(rt, s, dxns);
  const list = newList(rt);
  for (const c of root.children) {
    c.parent = null;
    c.addInScopeNamespace(dxns);
    appendNode(list, c);
  }

  return list;
}

function isWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!isSpace(s.charCodeAt(i))) {
      return false;
    }
  }

  return true;
}

function deepCopy(rt: Runtime, node: XMLNode): XMLNode {
  const e = e4x(rt);
  return node.deepCopy(e.ignoreComments, e.ignoreProcessingInstructions);
}

function listDeepCopy(rt: Runtime, list: AsObject): AsObject {
  fixTarget(rt, list);
  const copy = newList(rt, list.$target, list.$targetProperty);
  for (const node of list.$nodes as XMLNode[]) {
    copy.$nodes.push(deepCopy(rt, node));
  }

  return copy;
}

// Notifications, as setNotification sets a function to call on changes.

function notifyNeeded(node: XMLNode | null): boolean {
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

function childChanges(
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

function nonChildChanges(
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
function insertAt(rt: Runtime, x: XMLNode, entry: number, value: Value): void {
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
function replaceAt(
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
function getXML(rt: Runtime, o: AsObject, name: XName): Value {
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
function setXML(rt: Runtime, o: AsObject, name: XName, value: Value): void {
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
function deleteXML(rt: Runtime, o: AsObject, name: XName): boolean {
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
function hasXML(rt: Runtime, o: AsObject, name: XName): boolean {
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
function descendantsOf(rt: Runtime, node: XMLNode, name: XName): AsObject {
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

function getList(rt: Runtime, o: AsObject, n: XName): Value {
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

function setList(rt: Runtime, o: AsObject, n: XName, value: Value): void {
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

function deleteList(rt: Runtime, o: AsObject, n: XName): boolean {
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

function hasList(rt: Runtime, o: AsObject, n: XName): boolean {
  const nodes: XMLNode[] = o.$nodes;
  const index = indexOf(n);
  if (index >= 0) {
    return index < nodes.length;
  }

  return nodes.some((node) => node.kind === ELEMENT && hasXML(rt, xmlOf(rt, node), n));
}

function descendantsOfList(rt: Runtime, o: AsObject, n: XName): AsObject {
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
function setIndex(rt: Runtime, o: AsObject, index: number, value: Value): void {
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
function deleteIndex(rt: Runtime, o: AsObject, index: number): boolean {
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

// Strings.

/** As GenerateUniquePrefix: "" if no namespace has it, else the first of aaa to zzz none has. */
function uniquePrefix(ns: Namespace, namespaces: Namespace[]): Namespace {
  if (!namespaces.some((n) => prefixOf(n) === "")) {
    return prefixedNamespace("", ns.uri ?? "");
  }

  const a = 0x61;
  for (let x1 = 0; x1 < 26; x1++) {
    for (let x2 = 0; x2 < 26; x2++) {
      for (let x3 = 0; x3 < 26; x3++) {
        const p = String.fromCharCode(a + x1, a + x2, a + x3);
        if (!namespaces.some((n) => prefixOf(n) === p)) {
          return prefixedNamespace(p, ns.uri ?? "");
        }
      }
    }
  }

  return ns;
}

/** As XMLObject::__toXMLString, E4X 10.2.1: `node` as XML text, into `out`. */
function toXMLStringOf(
  rt: Runtime,
  node: XMLNode,
  ancestors: Namespace[],
  indentLevel: number,
  out: string[],
): void {
  const e = e4x(rt);
  const pretty = okToPrettyPrint(e);
  if (pretty && indentLevel > 0) {
    out.push(" ".repeat(indentLevel));
  }

  switch (node.kind) {
    case TEXT:
      out.push(escapeElementValue(node.value, pretty));
      return;
    case CDATA:
      out.push(`<![CDATA[${node.value}]]>`);
      return;
    case ATTRIBUTE:
      out.push(escapeAttributeValue(node.value));
      return;
    case COMMENT:
      out.push(`<!--${node.value}-->`);
      return;
    case PROCESSING_INSTRUCTION:
      out.push(`<?${node.name} ${node.value}?>`);
      return;
  }

  // The namespaces in scope not already among the ancestors'.
  const origLength = ancestors.length;
  for (const ns of node.inScopeNamespaces()) {
    if (!ancestors.some((ns2) => ns.uri === ns2.uri && prefixOf(ns) === prefixOf(ns2))) {
      ancestors.push(ns);
    }
  }

  // This node's namespace, and its attributes', each with a prefix.
  let own = getNamespace(node.ns, ancestors);
  if (prefixOf(own) === undefined) {
    own = uniquePrefix(own, ancestors);
    ancestors.push(own);
  }

  for (const a of node.attributes) {
    if (a.name !== null) {
      const ns = getNamespace(a.ns, ancestors);
      if (prefixOf(ns) === undefined) {
        ancestors.push(uniquePrefix(ns, ancestors));
      }
    }
  }

  const prefix = prefixOf(own) as string;
  const qualified = prefix !== "" ? `${prefix}:${node.name}` : (node.name as string);
  out.push("<", qualified);
  for (const a of node.attributes) {
    if (a.name !== null) {
      out.push(" ");
      const ns = getNamespace(a.ns, ancestors);
      if (hasPrefix(ns)) {
        out.push(prefixOf(ns) as string, ":");
      }

      out.push(a.name, '="', escapeAttributeValue(a.value), '"');
    }
  }

  for (let i = origLength; i < ancestors.length; i++) {
    const ns = ancestors[i];
    if (ns.uri !== "") {
      const p = prefixOf(ns);
      out.push(p !== "" ? ` xmlns:${p}="` : ' xmlns="', ns.uri ?? "", '"');
    }
  }

  const children = node.children;
  if (!children.length) {
    out.push("/>");
    return;
  }

  out.push(">");
  const indentChildren = children.length > 1 || (children[0].kind & ~(TEXT | CDATA)) !== 0;
  const nextIndentLevel = e.prettyPrinting && indentChildren ? indentLevel + e.prettyIndent : 0;

  // The ancestors' namespaces less those whose prefix one here declares
  // again, so that each is declared where it is shadowed.
  const scope: Namespace[] = [];
  for (let i = 0; i < ancestors.length; i++) {
    const first = ancestors[i];
    if (i < origLength) {
      let j = origLength;
      while (j < ancestors.length && prefixOf(ancestors[j]) !== prefixOf(first)) {
        j++;
      }

      if (j === ancestors.length) {
        scope.push(first);
      }
    } else {
      scope.push(first);
    }
  }

  const scopeLength = scope.length;
  for (const child of children) {
    if (pretty && indentChildren) {
      out.push("\n");
    }

    toXMLStringOf(rt, child, scope, nextIndentLevel, out);
    scope.length = scopeLength;
  }

  if (pretty && indentChildren) {
    out.push("\n");
    if (indentLevel > 0) {
      out.push(" ".repeat(indentLevel));
    }
  }

  out.push("</", qualified, ">");
}

export function xmlToXMLString(rt: Runtime, node: XMLNode): string {
  const out: string[] = [];
  toXMLStringOf(rt, node, [], 0, out);
  return out.join("");
}

function listToXMLString(rt: Runtime, list: AsObject): string {
  const out: string[] = [];
  const nodes: XMLNode[] = list.$nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (i) {
      out.push("\n");
    }

    toXMLStringOf(rt, nodes[i], [], 0, out);
  }

  return out.join("");
}

/** As XMLObject::toString, E4X 10.1.1: a simple node's text, else its XML. */
function xmlToString(rt: Runtime, node: XMLNode): string {
  if (node.kind & (TEXT | CDATA | ATTRIBUTE)) {
    return node.value;
  }

  if (node.hasSimpleContent()) {
    let s = "";
    for (const child of node.children) {
      if (child.kind !== COMMENT && child.kind !== PROCESSING_INSTRUCTION) {
        s += xmlToString(rt, child);
      }
    }

    return s;
  }

  return xmlToXMLString(rt, node);
}

function listHasSimpleContent(nodes: XMLNode[]): boolean {
  if (nodes.length === 0) {
    return true;
  }

  if (nodes.length === 1) {
    return nodes[0].hasSimpleContent();
  }

  return !nodes.some((n) => n.kind === ELEMENT);
}

function listToString(rt: Runtime, list: AsObject): string {
  const nodes: XMLNode[] = list.$nodes;
  if (listHasSimpleContent(nodes)) {
    let s = "";
    for (const node of nodes) {
      if (node.kind !== COMMENT && node.kind !== PROCESSING_INSTRUCTION) {
        s += xmlToString(rt, node);
      }
    }

    return s;
  }

  return listToXMLString(rt, list);
}

// Equality and +.

/** As XMLListObject::_equals. */
function listEquals(rt: Runtime, list: AsObject, v: Value): boolean {
  const nodes: XMLNode[] = list.$nodes;
  if (v === undefined && nodes.length === 0) {
    return true;
  }

  if (isList(v)) {
    const other: XMLNode[] = v.$nodes;
    if (nodes.length !== other.length) {
      return false;
    }

    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i] !== other[i] && !rt.equals(xmlOf(rt, nodes[i]), xmlOf(rt, other[i]))) {
        return false;
      }
    }

    return true;
  }

  if (nodes.length === 1) {
    return rt.equals(xmlOf(rt, nodes[0]), v);
  }

  return false;
}

/** E4X's == (11.5.1) where either side is XML or an XMLList, else undefined. */
function equals(rt: Runtime, a: Value, b: Value): boolean | undefined {
  if (isList(a)) {
    return listEquals(rt, a, b);
  }

  if (isList(b)) {
    return listEquals(rt, b, a);
  }

  if (isXML(a) && isXML(b)) {
    const x: XMLNode = a.$node;
    const y: XMLNode = b.$node;
    if (
      (x.kind & (TEXT | CDATA | ATTRIBUTE) && y.hasSimpleContent()) ||
      (y.kind & (TEXT | CDATA | ATTRIBUTE) && x.hasSimpleContent())
    ) {
      return xmlToString(rt, x) === xmlToString(rt, y);
    }

    return x.equals(y);
  }

  const xml = isXML(a) ? a : b;
  const other = xml === a ? b : a;
  if (other === null || other === undefined) {
    return false;
  }

  if (xml.$node.hasSimpleContent() && !(typeof other === "object" && other.$traits?.properties)) {
    return xmlToString(rt, xml.$node) === rt.toString(other);
  }

  return undefined;
}

/** E4X's + (11.4.1): XML and XMLLists into one XMLList. */
function add(rt: Runtime, a: Value, b: Value): Value {
  if ((isXML(a) || isList(a)) && (isXML(b) || isList(b))) {
    const list = newList(rt);
    append(list, a);
    append(list, b);
    return list;
  }

  return undefined;
}

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
