// E4X's tree, as avmplus' E4XNode: elements with their attributes, the
// namespaces they declare and their children; text, CDATA, comments,
// processing instructions and attributes with their values. Each node has
// its parent, and one XML object stands for it (see xml.ts), so that XML
// values compare by the node they are.
//
// Translated from avmplus' core/E4XNode.cpp, this file is subject to the
// Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.

import type { AsObject, Value } from "../../descriptors.js";
import { type Namespace, NS_Public, prefixedNamespace, prefixOf, publicNs } from "../../names.js";

// The node kinds, as E4XNode's NodeTypes: bits, so a set of them is a mask.
export const ATTRIBUTE = 0x02;
export const TEXT = 0x04;
/** Text, written back as CDATA. */
export const CDATA = 0x08;
export const COMMENT = 0x10;
export const PROCESSING_INSTRUCTION = 0x20;
export const ELEMENT = 0x40;

/**
 * A name as E4X matches one against a node's, as avmplus' Multiname: its
 * local name, null for any; its namespaces, null for any; whether it names
 * attributes; and whether it is qualified, one namespace given, as ns::*,
 * not a set of them, as a plain *.
 */
export interface XName {
  local: string | null;
  namespaces: Namespace[] | null;
  attribute: boolean;
  qualified: boolean;
}

export class XMLNode {
  parent: XMLNode | null = null;
  /** Its local name; null for a node without one (text, CDATA, a comment). */
  name: string | null = null;
  /** Its name's namespace, when it has a name: public for none. */
  ns: Namespace = publicNs;
  /** The value of a node that is not an element. */
  value = "";
  /** An element's attributes, in order. */
  readonly attributes: XMLNode[] = [];
  /** The namespaces an element declares. */
  readonly namespaces: Namespace[] = [];
  /** An element's children. */
  readonly children: XMLNode[] = [];
  /** A function called on changes to an element, as setNotification sets it. */
  notification: Value = null;
  /** The XML object that stands for this node, once made. */
  object: AsObject | null = null;

  constructor(
    readonly kind: number,
    value = "",
  ) {
    this.value = value;
  }

  /** As setQName: a name in no namespace, or the public one, is kept as public. */
  setName(name: string | null, ns: Namespace | null): void {
    this.name = name;
    if (!ns || (ns.kind === NS_Public && ns.uri === "")) {
      this.ns = publicNs;
    } else {
      this.ns = ns;
    }
  }

  /**
   * As getQName: its name, if it has one; qualified unless public, which
   * E4X then looks up in the default namespace too.
   */
  xname(): XName | null {
    if (this.name === null) {
      return null;
    }

    return {
      local: this.name,
      namespaces: [this.ns],
      attribute: this.kind === ATTRIBUTE,
      qualified: this.ns !== publicNs,
    };
  }

  /** As _append: `child` its last child. */
  append(child: XMLNode): void {
    child.parent = this;
    this.children.push(child);
  }

  /**
   * As ElementE4XNode::_addInScopeNamespace: declare `ns` here, replacing
   * one with its prefix but another URI; the name, and attributes', in a
   * namespace with its prefix lose the prefix.
   */
  addInScopeNamespace(ns: Namespace | null): void {
    if (this.kind !== ELEMENT || !ns || prefixOf(ns) === undefined) {
      return;
    }

    const prefix = prefixOf(ns);
    if (prefix === "" && this.name !== null && this.ns.uri === "") {
      return;
    }

    let index = -1;
    for (let i = 0; i < this.namespaces.length; i++) {
      if (prefixOf(this.namespaces[i]) === prefix) {
        index = i;
      }
    }

    if (index !== -1 && this.namespaces[index].uri !== ns.uri) {
      this.namespaces.splice(index, 1);
    }

    this.namespaces.push(ns);
    if (this.name !== null && prefixOf(this.ns) === prefix) {
      this.setName(this.name, prefixedNamespace(undefined, this.ns.uri ?? ""));
    }

    for (const attribute of this.attributes) {
      if (attribute.name !== null && prefixOf(attribute.ns) === prefix) {
        attribute.setName(attribute.name, prefixedNamespace(undefined, attribute.ns.uri ?? ""));
      }
    }
  }

  /**
   * As FindMatchingNamespace: the index of a declared namespace with `ns`'s
   * URI and, if it has one, its prefix; -1 if none, or if one with its URI
   * has the empty prefix.
   */
  findMatchingNamespace(ns: Namespace): number {
    for (let i = 0; i < this.namespaces.length; i++) {
      const ns2 = this.namespaces[i];
      if (ns2.uri === ns.uri) {
        if (prefixOf(ns) === undefined) {
          return i;
        }

        if (prefixOf(ns2) === "") {
          return -1;
        }

        if (prefixOf(ns2) === prefixOf(ns)) {
          return i;
        }
      }
    }

    return -1;
  }

  /**
   * As BuildInScopeNamespaceList: the namespaces declared here and up the
   * ancestors, the nearest first, each prefix (or, without one, URI) once.
   */
  inScopeNamespaces(): Namespace[] {
    const list: Namespace[] = [];
    for (let y: XMLNode | null = this; y; y = y.parent) {
      for (const ns1 of y.namespaces) {
        const p1 = prefixOf(ns1);
        const seen = list.some((ns2) =>
          p1 === undefined ? ns1.uri === ns2.uri : p1 === prefixOf(ns2),
        );
        if (!seen) {
          list.push(ns1);
        }
      }
    }

    return list;
  }

  hasSimpleContent(): boolean {
    if (this.kind & (COMMENT | PROCESSING_INSTRUCTION)) {
      return false;
    }

    return !this.children.some((c) => c.kind === ELEMENT);
  }

  hasComplexContent(): boolean {
    if (this.kind & (TEXT | COMMENT | PROCESSING_INSTRUCTION | ATTRIBUTE | CDATA)) {
      return false;
    }

    return this.children.some((c) => c.kind === ELEMENT);
  }

  /** Its index among its parent's children, or -1 for none or an attribute. */
  childIndex(): number {
    if (!this.parent || this.kind === ATTRIBUTE) {
      return -1;
    }

    return this.parent.children.indexOf(this);
  }

  nodeKind(): string {
    switch (this.kind) {
      case ATTRIBUTE:
        return "attribute";
      case TEXT:
      case CDATA:
        return "text";
      case COMMENT:
        return "comment";
      case PROCESSING_INSTRUCTION:
        return "processing-instruction";
      default:
        return "element";
    }
  }

  /** As _deleteByIndex: child i removed, no longer its child. */
  deleteByIndex(i: number): void {
    if (i >= 0 && i < this.children.length) {
      const child = this.children[i];
      if (child) {
        child.parent = null;
      }

      this.children.splice(i, 1);
    }
  }

  /**
   * As _deepCopy: a copy of this node and all below it, with no parent;
   * comments and processing instructions the settings ignore left out.
   */
  deepCopy(ignoreComments: boolean, ignoreProcessingInstructions: boolean): XMLNode {
    const x = new XMLNode(this.kind, this.value);
    if (this.name !== null) {
      x.setName(this.name, this.ns);
    }

    if (this.kind === ELEMENT) {
      x.namespaces.push(...this.namespaces);
      for (const a of this.attributes) {
        const b = a.deepCopy(ignoreComments, ignoreProcessingInstructions);
        b.parent = x;
        x.attributes.push(b);
      }

      for (const child of this.children) {
        if (
          (child.kind === COMMENT && ignoreComments) ||
          (child.kind === PROCESSING_INSTRUCTION && ignoreProcessingInstructions)
        ) {
          continue;
        }

        const c = child.deepCopy(ignoreComments, ignoreProcessingInstructions);
        c.parent = x;
        x.children.push(c);
      }
    }

    return x;
  }

  /**
   * As _equals: the same kind, name, attributes, value and children. The
   * namespaces declared are not compared: those that matter are in names.
   */
  equals(v: XMLNode): boolean {
    if (this === v) {
      return true;
    }

    if (this.kind !== v.kind) {
      return false;
    }

    const name = this.xname();
    if (name ? v.name === null || !matches(name, v) : v.name !== null) {
      return false;
    }

    if (
      this.attributes.length !== v.attributes.length ||
      this.children.length !== v.children.length ||
      this.value !== v.value
    ) {
      return false;
    }

    for (const a1 of this.attributes) {
      if (!v.attributes.some((a2) => a1.equals(a2))) {
        return false;
      }
    }

    for (let i = 0; i < this.children.length; i++) {
      if (!this.children[i].equals(v.children[i])) {
        return false;
      }
    }

    return true;
  }
}

/**
 * As Multiname::matches: whether `name` names `node`. With a name, the
 * node is an attribute if the name names attributes; an unqualified any
 * name matches every node, one without a name too; otherwise the local
 * names are the same, and the node's namespace is one of the name's, by
 * URI and kind, if the name is not in any namespace.
 */
export function matches(name: XName, node: XMLNode | null): boolean {
  const named = node !== null && node.name !== null;
  if (named && name.attribute !== (node.kind === ATTRIBUTE)) {
    return false;
  }

  if (name.local === null && !name.qualified) {
    return true;
  }

  if (!named) {
    return false;
  }

  if (name.local !== null && name.local !== node.name) {
    return false;
  }

  if (name.namespaces === null) {
    return true;
  }

  return name.namespaces.some((ns) => ns.uri === node.ns.uri && ns.kind === node.ns.kind);
}
