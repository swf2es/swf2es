// Definitions by qualified name, "pkg::Name" or "Name", as a host and
// ApplicationDomain look them up: a SWF's SymbolClass, a player's own
// classes, and getDefinition.

import type { Abc, AsObject, Value } from "./descriptors.js";
import type { Domain } from "./domain.js";
import {
  CONSTANT_Qname,
  Multiname,
  NS_Public,
  namespace,
  publicNs,
  qname,
  userVersions,
} from "./names.js";
import type { Runtime } from "./runtime.js";

/**
 * The class `qualified` names, "pkg::Name" or "Name", its defining script
 * run; a ReferenceError if no script defines it. What a SWF's SymbolClass
 * and a player's lookups by name go through, at every version.
 */
export function classNamed(rt: Runtime, qualified: string, domain: Domain | null): AsObject {
  const named = (domain ?? rt.root).named;
  const known = named.get(qualified);
  if (known) {
    return known;
  }

  const mn = qualifiedNameIn(rt, qualified, domain);
  const cls = rt.resolveName(mn);
  // A script still running its initializer may not have made the class yet.
  if (cls) {
    named.set(qualified, cls);
  }

  return cls;
}

/**
 * The class `qualified` names in `domain` as code finds it, at user code's
 * version, as avmshell's Domain.getClass does: a name of the other series'
 * or the VM's own is a ReferenceError.
 */
export function classNamedByCode(rt: Runtime, qualified: string, domain: Domain): AsObject {
  return rt.resolveName(qualifiedNameIn(rt, qualified, domain, userVersions(rt.apiVersion)));
}

/**
 * What `qualified` names in `domain`, as Flash's
 * ApplicationDomain.getDefinition finds it: a name no script defines is
 * refused by its local name, and a script whose initializer threw runs
 * again, its error coming through each time, where a name's lookup by
 * code keeps it as run, as avmplus does. Seen at user code's version, as
 * avmplus' public namespace is the caller's: a name of the other series'
 * or the VM's own is not defined, as it is not to the code itself.
 */
export function definitionNamed(rt: Runtime, qualified: string, domain: Domain): Value {
  const mn = qualifiedNameIn(rt, qualified, domain, userVersions(rt.apiVersion));
  const script = rt.findScript(mn);
  if (!script) {
    throw rt.error("ReferenceError", 1065, mn.name);
  }

  return rt.getProperty(rt.initScript(script, true), mn);
}

/** The module whose script defines `qualified` for `domain`, or null: by it a player keys what SymbolClass binds. */
export function definingAbc(rt: Runtime, qualified: string, domain: Domain): Abc | null {
  return rt.findScript(qualifiedNameIn(rt, qualified, domain))?.abc ?? null;
}

/**
 * The public name "pkg::Name" or "Name" stands for, looked up in `domain`:
 * at every version, as the host reaches names, or at `versions`.
 */
function qualifiedNameIn(
  rt: Runtime,
  qualified: string,
  domain: Domain | null,
  versions?: readonly number[],
): Multiname {
  const i = qualified.lastIndexOf("::");
  const ns = i < 0 ? publicNs : namespace(NS_Public, qualified.slice(0, i));
  const local = i < 0 ? qualified : qualified.slice(i + 2);
  const mn = versions
    ? new Multiname(CONSTANT_Qname, [ns], versions, local, false)
    : qname(ns, local);
  mn.domain = domain === rt.root ? null : domain;
  return mn;
}
