// Application domains, as avmplus' DomainMgr keeps them: the scripts each
// one's modules define, by name, and what each has found, from which a
// name's definition is looked up along a domain's chain.

import type { Abc, AsObject, CompileUnit, FoundDefinition, ScriptDesc } from "./descriptors.js";
import { type Multiname, type Namespace, NS_Private } from "./names.js";
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
 * Each frame's site, "script:line:column", innermost first, or null for a
 * frame line it cannot read: V8's "at f (script:1:2)" and "at script:1:2",
 * and SpiderMonkey's and JavaScriptCore's "f@script:1:2". Lines that are
 * no frame, as V8's heading "Error", are left out. The site is read so
 * that nothing a name holds can stand for it: in V8's frames, inside the
 * last parentheses; in the others, after the first "@", since URLs may
 * hold one ("/npm/p@1.0/m.js") and the names a SWF's code can have
 * cannot (codegen spells them from [A-Za-z0-9_$]). One without a line and
 * column is unread: JavaScriptCore's for code a Function or eval made,
 * whatever its sourceURL ("f@"), and for native code ("f@[native code]"),
 * and V8's "native", "<anonymous>" or "index 0".
 */
export function frameSites(stack: string | undefined): (string | null)[] {
  const lines = stack?.split("\n") ?? [];
  const v8 = lines.some((line) => /^\s*at /.test(line));
  const sites: (string | null)[] = [];
  for (const line of lines) {
    if (v8 ? !/^\s*at /.test(line) : !line.includes("@")) {
      continue;
    }

    let site: string;
    if (v8) {
      const text = line.replace(/^\s*at /, "");
      const open = text.lastIndexOf(" (");
      site =
        text.endsWith(")") && open >= 0 ? text.slice(open + 2, -1) : text.replace(/^async /, "");
    } else {
      site = line.slice(line.indexOf("@") + 1);
    }

    sites.push(/:\d+:\d+$/.test(site) ? site : null);
  }

  return sites;
}

/** A frame site's script: "script:1:2" without its line and column. */
export function siteScript(site: string): string | null {
  return /^(.+):\d+:\d+$/.exec(site)?.[1] ?? null;
}

/**
 * The script each of a stack's frames names, innermost first, or null for
 * a frame that names none or a line it cannot read (see frameSites). For
 * security checks, where such a frame must not be passed over;
 * frameScripts leaves them out.
 */
export function stackFrames(stack: string | undefined): (string | null)[] {
  return frameSites(stack).map((site) => (site === null ? null : siteScript(site)));
}

/** The scripts a stack's frames name, innermost first, those that name none left out. */
export function frameScripts(stack: string | undefined): string[] {
  return stackFrames(stack).filter((at) => at !== null);
}

/** The definition of a table's that `mn` names: its namespaces in order, each at a version it sees. */
function match(table: Map<string, GlobalName[]>, mn: Multiname, name: string): GlobalName | null {
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

/**
 * The script that defines `mn` for `domain`, or null, as
 * DomainMgr::findScriptInDomainByMultinameImpl finds it: a definition a
 * domain of the chain has found before, from the name's own up; else the
 * first loaded, from the root down. Either is kept by the name's domain,
 * and one loaded by the domain that loaded it, so a child that found its
 * own keeps it when its parent defines the name later. A type is found
 * the same way through caches of its own (`asType`), as avmplus finds
 * traits, so a class a child found by name is not the type it finds.
 */
export function findScript(domain: Domain, mn: Multiname, asType: boolean): Script | null {
  const name = mn.name;
  if (name === null) {
    return null;
  }

  const cache = (d: Domain) => (asType ? d.types : d.cached);
  for (let d: Domain | null = domain; d; d = d.parent) {
    const found = match(cache(d), mn, name);
    if (found) {
      if (d !== domain) {
        add(cache(domain), found, name);
      }

      return found.script;
    }
  }

  const chain: Domain[] = [];
  for (let d: Domain | null = domain; d; d = d.parent) {
    chain.push(d);
  }

  for (let k = chain.length - 1; k >= 0; k--) {
    const found = match(chain[k].globals, mn, name);
    if (found) {
      add(cache(chain[k]), found, name);
      add(cache(domain), found, name);
      return found.script;
    }
  }

  return null;
}

/** What an ABC loaded into `domain` now compiles in. */
export function compileUnit(domain: Domain): CompileUnit {
  const domains: number[] = [];
  for (let d: Domain | null = domain; d; d = d.parent) {
    domains.push(d.id);
  }

  return { linked: domain.chain(), domains, found: foundIn(domain) };
}

/**
 * What `domain` finds, by name and as a type, that is not the first
 * definition from the root down: what a cache of its chain holds, from
 * the domain up. The root's caches hold only its own first definitions.
 */
function foundIn(domain: Domain): FoundDefinition[] {
  const found: FoundDefinition[] = [];
  for (const asType of [false, true]) {
    const seen = new Set<string>();
    for (let d: Domain | null = domain; d?.parent; d = d.parent) {
      for (const [name, list] of asType ? d.types : d.cached) {
        for (const g of list) {
          const key = `${g.ns.kind}:${g.ns.uri}::${name}`;
          if (seen.has(key) || g.ns.uri === null || g.ns.kind === NS_Private) {
            continue;
          }

          seen.add(key);
          if (firstLoaded(domain, name, g.ns) !== g.script) {
            const abc = g.script.abc;
            found.push({
              nsKind: g.ns.kind,
              uri: g.ns.uri,
              name,
              domain: abc.domain.id,
              index: abc.index,
              hash: abc.hash,
              asType,
            });
          }
        }
      }
    }
  }

  return found;
}

/** The script that first defines `name` in `ns` for `domain`, from the root down. */
function firstLoaded(domain: Domain, name: string, ns: Namespace): Script | null {
  const chain: Domain[] = [];
  for (let d: Domain | null = domain; d; d = d.parent) {
    chain.push(d);
  }

  for (let k = chain.length - 1; k >= 0; k--) {
    const g = chain[k].globals.get(name)?.find((other) => other.ns === ns);
    if (g) {
      return g.script;
    }
  }

  return null;
}

/** Whether `domain`'s chain defines `name` in `ns`, cached or loaded, without keeping what it finds. */
export function definedInChain(domain: Domain, name: string, ns: Namespace): boolean {
  for (let d: Domain | null = domain; d; d = d.parent) {
    if (
      d.cached.get(name)?.some((g) => g.ns === ns) ||
      d.globals.get(name)?.some((g) => g.ns === ns)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * The names `domain`'s own modules define, private ones left out, as
 * Flash's ApplicationDomain.getQualifiedDefinitionNames lists them:
 * "pkg::Name", or the name alone in the top-level package.
 */
export function definitionNames(domain: Domain): string[] {
  const names: string[] = [];
  for (const [name, list] of domain.globals) {
    for (const g of list) {
      if (g.ns.kind !== NS_Private) {
        names.push(g.ns.uri ? `${g.ns.uri}::${name}` : name);
      }
    }
  }

  return names;
}
