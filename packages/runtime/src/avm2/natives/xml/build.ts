// E4X's trees made from values: text parsed (by parser.ts) into nodes with
// their namespaces, the conversions ToXML and ToXMLList, and deep copies.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp and E4X's
// parts of Toplevel.cpp and AvmCore.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import { type Namespace, prefixedNamespace, prefixOf, publicNs } from "../../names.js";
import type { Runtime } from "../../runtime.js";
import { isSpace } from "./chars.js";
import { hasPrefix, newPrefixedNamespace } from "./names.js";
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
import {
  ANY,
  append,
  appendNode,
  BAD_QNAME,
  DUPLICATE_ATTRIBUTE,
  e4x,
  fixTarget,
  isList,
  isXML,
  MARKUP_MUST_BE_WELL_FORMED,
  newList,
  PARSE_ERRORS,
  PREFIX_NOT_BOUND,
  UNTERMINATED_ELEMENT_TAG,
  XML_1998,
  xmlOf,
} from "./values.js";

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
export function toXML(rt: Runtime, v: Value): AsObject {
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
export function toXMLList(rt: Runtime, v: Value): AsObject {
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

export function isWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!isSpace(s.charCodeAt(i))) {
      return false;
    }
  }

  return true;
}

export function deepCopy(rt: Runtime, node: XMLNode): XMLNode {
  const e = e4x(rt);
  return node.deepCopy(e.ignoreComments, e.ignoreProcessingInstructions);
}

export function listDeepCopy(rt: Runtime, list: AsObject): AsObject {
  fixTarget(rt, list);
  const copy = newList(rt, list.$target, list.$targetProperty);
  for (const node of list.$nodes as XMLNode[]) {
    copy.$nodes.push(deepCopy(rt, node));
  }

  return copy;
}
