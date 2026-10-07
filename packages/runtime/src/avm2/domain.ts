// Application domains, as avmplus' DomainMgr keeps them: the scripts each
// one's modules define, by name, and what each has found, from which a
// name's definition is looked up along a domain's chain.

import type { Abc, AsObject, ScriptDesc } from "./descriptors.js";
import type { Multiname, Namespace } from "./names.js";
import type { ClassRef } from "./traits.js";

/** A script: its descriptor, its global object once made, and whether it has run. */
export interface Script {
  desc: ScriptDesc;
  abc: Abc;
  global: AsObject | null;
  /** Not run, running, run, or failed: its initializer threw, which avmplus keeps as run. */
  state: 0 | 1 | 2 | 3;
}

export interface GlobalName {
  ns: Namespace;
  version: number;
  script: Script;
}

/**
 * An application domain, as avmplus' Domain: the scripts its modules
 * define, by name, a name its chain defines already not again (see
 * Runtime.abc); the definitions it has found, by name, which it keeps
 * (see Runtime.findScript), as names and, apart, as types; and the ABCs
 * loaded into it, by hash.
 */
export class Domain {
  readonly globals = new Map<string, GlobalName[]>();
  readonly cached = new Map<string, GlobalName[]>();
  /** As avmplus' m_cachedTraits, which a name's lookup never fills, nor a type's m_cachedScripts. */
  readonly types = new Map<string, GlobalName[]>();
  readonly classRefs = new Map<Namespace, Map<string, ClassRef>>();
  /**
   * The classes classNamed found here, by qualified name: what a name
   * finds in a domain is kept once found, so a player's lookups by name,
   * one for each object it makes, need not name it anew each time.
   */
  readonly named = new Map<string, AsObject>();
  readonly own: string[] = [];
  /** Each of its ABCs' place among all the runtime loads. */
  readonly ownOrder: number[] = [];

  constructor(
    readonly parent: Domain | null,
    /** Its number in its runtime, which a host's compiler knows it by: the root's is 0. */
    readonly id: number,
  ) {}

  /**
   * The ABCs a module loaded into it now is compiled after: its own and
   * its ancestors', including those loaded after it was made, in the order
   * they loaded.
   */
  chain(): string[] {
    if (!this.parent) {
      return [...this.own];
    }

    const loads: [number, string][] = [];
    for (let d: Domain | null = this; d; d = d.parent) {
      const { own, ownOrder } = d;
      for (let i = 0; i < own.length; i++) {
        loads.push([ownOrder[i], own[i]]);
      }
    }

    return loads.sort((a, b) => a[0] - b[0]).map(([, hash]) => hash);
  }
}

/**
 * The scripts a stack's frames name, innermost first: V8's "at f (script:1:2)"
 * and "at script:1:2", and SpiderMonkey's and JavaScriptCore's "f@script:1:2".
 */
export function frameScripts(stack: string | undefined): string[] {
  const scripts: string[] = [];
  for (const line of stack?.split("\n") ?? []) {
    const m =
      /^\s*at .*? \((.*):\d+:\d+\)$/.exec(line) ??
      /^\s*at (.*):\d+:\d+$/.exec(line) ??
      /@(.*):\d+:\d+$/.exec(line);
    if (m) {
      scripts.push(m[1]);
    }
  }

  return scripts;
}

/** The definition of a table's that `mn` names: its namespaces in order, each at a version it sees. */
export function match(
  table: Map<string, GlobalName[]>,
  mn: Multiname,
  name: string,
): GlobalName | null {
  const list = table.get(name);
  if (!list) {
    return null;
  }

  for (let i = 0; i < mn.namespaces.length; i++) {
    const ns = mn.namespaces[i];
    for (const g of list) {
      if (g.ns === ns && g.version <= mn.versions[i]) {
        return g;
      }
    }
  }

  return null;
}

/** Add a definition to a table, unless it has one of that name in that namespace. */
export function add(table: Map<string, GlobalName[]>, g: GlobalName, name: string): void {
  let list = table.get(name);
  if (!list) {
    list = [];
    table.set(name, list);
  }

  if (!list.some((other) => other.ns === g.ns)) {
    list.push(g);
  }
}
