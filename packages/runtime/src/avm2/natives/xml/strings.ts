// E4X's strings: XML and XMLList as toString and toXMLString write them,
// pretty printed or not.
//
// Translated from avmplus' core/XMLObject.cpp and XMLListObject.cpp, this
// file is subject to the Mozilla Public License, v. 2.0:
// http://mozilla.org/MPL/2.0/.

import type { AsObject } from "../../descriptors.js";
import { type Namespace, prefixedNamespace, prefixOf } from "../../names.js";
import type { Runtime } from "../../runtime.js";
import { escapeAttributeValue, escapeElementValue } from "./escape.js";
import { getNamespace, hasPrefix } from "./names.js";
import {
  ATTRIBUTE,
  CDATA,
  COMMENT,
  ELEMENT,
  PROCESSING_INSTRUCTION,
  TEXT,
  type XMLNode,
} from "./node.js";
import { e4x, okToPrettyPrint } from "./values.js";

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

export function listToXMLString(rt: Runtime, list: AsObject): string {
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
export function xmlToString(rt: Runtime, node: XMLNode): string {
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

export function listHasSimpleContent(nodes: XMLNode[]): boolean {
  if (nodes.length === 0) {
    return true;
  }

  if (nodes.length === 1) {
    return nodes[0].hasSimpleContent();
  }

  return !nodes.some((n) => n.kind === ELEMENT);
}

export function listToString(rt: Runtime, list: AsObject): string {
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
