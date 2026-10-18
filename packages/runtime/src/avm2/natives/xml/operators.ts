// E4X's operators on XML and XMLList: == and +.
//
// Translated from avmplus' core/XMLObject.cpp, XMLListObject.cpp and E4X's
// parts of AvmCore.cpp, this file is subject to the Mozilla Public License,
// v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import type { Runtime } from "../../runtime.js";
import { ATTRIBUTE, CDATA, TEXT, type XMLNode } from "./node.js";
import { xmlToString } from "./strings.js";
import { append, isList, isXML, newList, xmlOf } from "./values.js";

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
export function equals(rt: Runtime, a: Value, b: Value): boolean | undefined {
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
export function add(rt: Runtime, a: Value, b: Value): Value {
  if ((isXML(a) || isList(a)) && (isXML(b) || isList(b))) {
    const list = newList(rt);
    append(list, a);
    append(list, b);
    return list;
  }

  return undefined;
}
