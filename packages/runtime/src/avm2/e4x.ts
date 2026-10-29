// E4X's opcodes, as the runtime runs them for XML and XMLList through
// their property hook: getdescendants, dxns and dxnslate, checkfilter,
// esc_xelem and esc_xattr.

import type { Value } from "./descriptors.js";
import type { PropertyHook } from "./hooks.js";
import { type Multiname, Namespace, prefixedNamespace } from "./names.js";
import { escapeAttributeValue, escapeElementValue } from "./natives/xml/escape.js";
import type { Runtime } from "./runtime.js";

/** getdescendants: x..name, on XML or XMLList; anything else, as avmplus, TypeError 1016. */
export function getDescendants(rt: Runtime, o: Value, mn: Multiname): Value {
  const properties: PropertyHook | null | undefined = o?.$traits?.properties;
  if (!properties) {
    throw rt.error("TypeError", 1016, rt.describe(o));
  }

  return properties.descendants(rt, o, mn);
}

export function setDefaultXmlNamespace(rt: Runtime, ns: Value): void {
  if (ns instanceof Namespace) {
    rt.defaultXmlNamespace = ns;
  } else {
    const uri = rt.toString(ns);
    rt.defaultXmlNamespace = prefixedNamespace(uri === "" ? "" : undefined, uri);
  }
}

/** checkfilter: x.(...) filters XML and XMLList only, else TypeError 1123. */
export function checkFilter(rt: Runtime, v: Value): void {
  if (!v?.$traits?.properties) {
    throw rt.error("TypeError", 1123, rt.describe(v));
  }
}

/** esc_xelem, as AvmCore::ToXMLString: XML's own XML, else a string escaped and trimmed. */
export function escapeElement(rt: Runtime, v: Value): string {
  if (typeof v === "string") {
    return escapeElementValue(v, true);
  }

  if (typeof v !== "object" || v === null) {
    return rt.toString(v);
  }

  const properties: PropertyHook | null | undefined = v.$traits?.properties;
  if (properties) {
    return properties.toXMLString(rt, v);
  }

  return escapeElementValue(rt.toString(v), true);
}

export function escapeAttribute(rt: Runtime, v: Value): string {
  return escapeAttributeValue(rt.toString(v));
}
