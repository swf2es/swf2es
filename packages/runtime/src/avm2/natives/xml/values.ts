// E4X's values: XML and XMLList objects over the tree's nodes (node.ts),
// each runtime's XML settings, and the errors E4X throws. An XML value
// stands for one node, and is the same object each time, so that XML
// values compare by the node they are; an XMLList holds nodes, and the
// object and name it was got from, which assignments to it write back to.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp and
// XMLClass.cpp, this file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import type { Runtime } from "../../runtime.js";
import type { Traits } from "../../traits.js";
import { PROCESSING_INSTRUCTION, type XMLNode, type XName } from "./node.js";
import * as P from "./parser.js";

// Error numbers, as avmplus' kXML* errors.
export const PREFIX_NOT_BOUND = 1083;
export const BAD_QNAME = 1084;
export const UNTERMINATED_ELEMENT_TAG = 1085;
export const ONLY_ONE_ITEM_LISTS = 1086;
export const ASSIGNMENT_TO_INDEXED_XML = 1087;
export const MARKUP_MUST_BE_WELL_FORMED = 1088;
export const ASSIGNMENT_ONE_ITEM_LISTS = 1089;
export const NAMESPACE_WITH_PREFIX_AND_NO_URI = 1098;
export const DUPLICATE_ATTRIBUTE = 1104;
export const INVALID_NAME = 1117;
export const ILLEGAL_CYCLICAL_LOOP = 1118;

/** What each of the parser's errors throws. */
export const PARSE_ERRORS: Record<number, number> = {
  [P.MALFORMED_ELEMENT]: 1090,
  [P.UNTERMINATED_CDATA]: 1091,
  [P.UNTERMINATED_XML_DECLARATION]: 1092,
  [P.UNTERMINATED_DOCTYPE]: 1093,
  [P.UNTERMINATED_COMMENT]: 1094,
  [P.UNTERMINATED_ATTRIBUTE_VALUE]: 1095,
  [P.UNTERMINATED_PROCESSING_INSTRUCTION]: 1097,
};

export const XML_1998 = "http://www.w3.org/XML/1998/namespace";

/** Any name in any namespace: an XMLList's target property when it has none. */
export const ANY: XName = { local: null, namespaces: null, attribute: false, qualified: false };

// E4X for each runtime: XML's settings, and the classes' traits.

export interface E4X {
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

export function e4x(rt: Runtime): E4X {
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

export const okToPrettyPrint = (e: E4X) => e.prettyPrinting && e.prettyIndent >= 0;

// XML and XMLList values.

export const isXML = (v: Value): boolean =>
  typeof v === "object" && v !== null && v.$node !== undefined;
export const isList = (v: Value): boolean =>
  typeof v === "object" && v !== null && v.$nodes !== undefined;

/** The XML object that stands for `node`, the same each time. */
export function xmlOf(rt: Runtime, node: XMLNode): AsObject {
  let o = node.object;
  if (!o) {
    o = e4x(rt).xml.instance();
    o.$node = node;
    node.object = o;
  }

  return o;
}

/** A new XMLList, got from `target` by `property`. */
export function newList(
  rt: Runtime,
  target: AsObject | null = null,
  property: XName = ANY,
): AsObject {
  const o = e4x(rt).list.instance();
  o.$nodes = [];
  o.$target = target;
  o.$targetProperty = property;
  o.$appended = false;
  return o;
}

/** As _appendNode. */
export function appendNode(list: AsObject, node: XMLNode): void {
  list.$nodes.push(node);
  list.$appended = true;
}

/** As XMLListObject::_append: an XMLList's nodes, and its target, or an XML value's node. */
export function append(list: AsObject, v: Value): void {
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
export function fixTarget(rt: Runtime, list: AsObject): void {
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
