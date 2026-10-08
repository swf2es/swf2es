// flash.utils.Proxy: an instance's names its traits do not bind go to its
// flash_proxy methods, as avmplus' ProxyObject (core/ProxyGlue.cpp) sends
// them: a name the code wrote, a multiname, as a QName object; a name made
// at run time, as proxy[name], as the value it was, a string or a QName.
// callProperty gets the QName and the arguments; for-in asks
// nextNameIndex, nextName and nextValue.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook, PropertyHook } from "../hooks.js";
import { type Multiname, NS_Public, namespace, publicNs, qname } from "../names.js";
import type { Runtime } from "../runtime.js";
import type { Natives } from "./define.js";

const FLASH_PROXY = namespace(NS_Public, "http://www.adobe.com/2006/actionscript/flash/proxy");

/**
 * The name a flash_proxy method gets for `mn`: a QName that was the name
 * stays one, an index comes as its string, as avmplus' getUintProperty
 * interns it, and any other name as a QName in its namespace.
 */
function nameFor(rt: Runtime, mn: Multiname): Value {
  if (mn.key !== undefined && (mn.key as AsObject)?.$local !== undefined) {
    return mn.key as Value;
  }

  const name = mn.name;
  if (name !== null && !mn.attribute && isIndex(name)) {
    return name;
  }

  // A QName keeps the whole multiname in avmplus; of a set of several it
  // reports the empty URI, and still names all of them as a lookup's name.
  const ns = mn.namespaces.length > 1 ? publicNs : mn.namespaces.length ? mn.namespaces[0] : null;
  const q = rt.builtinClass("QName").$it.instance();
  q.$ns = ns;
  q.$local = name;
  q.$attr = mn.attribute;
  if (mn.namespaces.length > 1) {
    q.$mn = mn;
  }

  return q;
}

function isIndex(name: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(name) && Number(name) < 0xffffffff;
}

function call(rt: Runtime, o: AsObject, method: string, ...args: Value[]): Value {
  // Not a tail call, as the runtime's calls are not (see Runtime.getProperty).
  // biome-ignore lint/style/useConst: a const is folded into a tail call (see Runtime.getProperty)
  let r: Value;
  r = rt.callProperty(o, qname(FLASH_PROXY, method), ...args);
  return r;
}

export const proxyHook: PropertyHook = {
  // A method the traits bind is the method, as for any object; only unbound names reach the proxy.
  hidesMethods: false,
  get: (rt, o, mn) => call(rt, o, "getProperty", nameFor(rt, mn)),
  set: (rt, o, mn, v) => {
    call(rt, o, "setProperty", nameFor(rt, mn), v);
  },
  // The flash_proxy methods declare Boolean results, coerced on their way out.
  delete: (rt, o, mn) => call(rt, o, "deleteProperty", nameFor(rt, mn)) === true,
  // `in` asks with the name's string, as hasAtomProperty gets it.
  has: (rt, o, mn) =>
    call(rt, o, "hasProperty", mn.key !== undefined ? (mn.key as Value) : mn.name) === true,
  callee: (rt, o, mn) => {
    const name = nameFor(rt, mn);
    return rt.newFunctionObject(
      (...args: Value[]) => call(rt, o, "callProperty", name, ...args),
      null,
    );
  },
  descendants: (rt, o, mn) => call(rt, o, "getDescendants", nameFor(rt, mn)),
  nextIndex: (rt, o, index) => rt.toInt(call(rt, o, "nextNameIndex", index)),
  nextName: (rt, o, index) => call(rt, o, "nextName", index),
  nextValue: (rt, o, index) => call(rt, o, "nextValue", index),
  equals: () => undefined,
  add: () => undefined,
  // toString is a call like any other the traits do not bind: callProperty answers it.
  toString: (rt, o) =>
    rt.toString(call(rt, o, "callProperty", nameFor(rt, qname(publicNs, "toString")))),
  toXMLString: (rt, o) =>
    rt.toString(call(rt, o, "callProperty", nameFor(rt, qname(publicNs, "toString")))),
};

export const proxyHooks: Record<string, ClassHook> = {
  "flash.utils::Proxy": { properties: proxyHook },
};

export const proxyNatives: Natives = {
  // As ProxyObject::flash_proxy_isAttribute: whether the name is a QName of an attribute.
  "flash.utils::Proxy#http://www.adobe.com/2006/actionscript/flash/proxy::isAttribute":
    () => (name: Value) =>
      name !== null && typeof name === "object" && name.$local !== undefined && name.$attr === true,
};
