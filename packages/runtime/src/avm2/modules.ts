// The modules a runtime loads into its application domains, and which of
// them the code on a stack is from: a Runtime's (Runtime.modules), apart
// from its object model, as nothing compiled code calls goes through it.

import type { Abc, AbcDesc } from "./descriptors.js";
import { add, Domain, definedInChain, frameScripts, stackFrames } from "./domain.js";
import { TypeName } from "./names.js";

export class Modules {
  private domainCount = 1;
  private loads = 0;
  /**
   * The domain of each loaded module's code, by the script a stack's frame
   * names it with (see Runtime.codeDomain); found from the stacks its loads
   * took, which wait in `unlocated` until a domain other than the root
   * exists. Weakly: a module's code keeps its domain, through its Abc, for
   * as long as it can run, and a domain no code is left of is let go, an
   * entry dropped with it.
   */
  private readonly moduleDomains = new Map<string, WeakRef<Domain>>();
  private readonly moduleDomainGone = new FinalizationRegistry<string>((at) => {
    if (!this.moduleDomains.get(at)?.deref()) {
      this.moduleDomains.delete(at);
    }
  });
  private readonly unlocated: [Error, Domain][] = [];

  /** A domain whose definitions are looked up after `parent`'s. */
  newDomain(parent: Domain): Domain {
    return new Domain(parent, this.domainCount++);
  }

  /**
   * Load a module into `domain`: its scripts' names become visible there.
   * `at` is the stack its load took, made in Runtime.abc, whose frame is
   * its first and the module's factory its second (see locate); null for a
   * player's own, whose code is not a domain's to Runtime.codeDomain.
   */
  load(desc: AbcDesc, domain: Domain, at: Error | null): Abc {
    // Its layouts are those of its ABC after exactly these ABCs; the
    // root's, which a player loads thousands into, are not copied.
    const loaded = domain.parent ? domain.chain() : domain.own;
    const linked = desc.linked;
    if (linked.length !== loaded.length || linked.some((h, i) => h !== loaded[i])) {
      throw new Error(
        `swf2es: a module compiled after [${linked.join(", ")}] cannot load after [${loaded.join(", ")}]`,
      );
    }

    const abc = desc as Abc;
    abc.domain = domain;
    abc.index = domain.own.length;
    domain.own.push(desc.hash);
    domain.ownOrder.push(this.loads++);
    if (at !== null) {
      this.unlocated.push([at, domain]);
    }
    for (const name of abc.names) {
      if (name instanceof TypeName) {
        name.names = abc.names;
      }
    }

    for (const cls of abc.classes) {
      cls.abc = abc;
    }

    abc.scriptStates = abc.scripts.map((s) => ({ desc: s, abc, global: null, state: 0 }));
    // As DomainMgr::addNamedScript: a name the domain's chain defines
    // already, cached or loaded, is unreachable, and not added.
    for (const script of abc.scriptStates) {
      for (const [ns, version, name] of script.desc.traits.bindings) {
        if (!definedInChain(domain, name, ns)) {
          add(domain.globals, { ns, version, script }, name);
        }
      }
    }

    return abc;
  }

  /**
   * The domain of the innermost code in `stack` that a module defines, or
   * null. A frame is a module's by its script, so a host gives each module
   * a script of its own: its URL, or a sourceURL comment for code it
   * evaluates.
   */
  domainOf(stack: string | undefined): Domain | null {
    this.locate();
    for (const at of frameScripts(stack)) {
      const domain = this.moduleDomains.get(at)?.deref();
      if (domain) {
        return domain;
      }
    }

    return null;
  }

  /**
   * The scripts of the modules loaded since last asked, by the stacks their
   * loads took. Their stacks reach the modules' code, so they are not kept
   * past the load once there are domains to tell apart.
   */
  locate(): void {
    for (const [error, domain] of this.unlocated) {
      // Its first frame is abc's own, its second the module's factory. An
      // engine may name no script for the factory's frame (JavaScriptCore,
      // for code a Function made), and the next frame that names one is
      // the host's, which must not stand for the module.
      const at = stackFrames(error.stack)[1];
      if (at) {
        this.moduleDomains.set(at, new WeakRef(domain));
        this.moduleDomainGone.register(domain, at);
      }
    }

    this.unlocated.length = 0;
  }
}
