// The SWFs' code: each DoABC added to the compiler in the application
// domain its SWF loads into, compiled into a module once all of its SWF's
// are added, evaluated and linked into the runtime; and, by the module a
// stack frame is of, the domain, URL and SWF of the code that runs.
import { readDoAbc, type Swf, tags } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { decodeImages } from "../bitmap/images.js";
import type { Library } from "../display/timeline.js";
import type { Scripting } from "../scripting.js";
import { sha256 } from "./sha256.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

export class Code {
  private readonly hashes: string[] = [];
  /**
   * The compiler's application domain for each of the runtime's, by its
   * number; the compiler's index of each ABC added into one, in order; and
   * the findings each has been told (see add).
   */
  private readonly codegenDomains = new Map<number, number>([[0, 0]]);
  private readonly codegenAbcs = new Map<number, number[]>([[0, []]]);
  private readonly reported = new Map<number, Set<string>>();
  /** Modules loaded, each under a script name of its own for Runtime.codeDomain. */
  private modules = 0;
  /**
   * The SWF each module's code came from, its URL and library, for codeUrl
   * and codeLibrary: by its script name, the module's Abc, and that.
   * Weakly: a module's code keeps its Abc for as long as it can run, and
   * once the SWF is let go, the Abc goes, its origin and entry with it.
   */
  private readonly moduleAbcs = new Map<string, WeakRef<object>>();
  private readonly origins = new WeakMap<object, { url: string; library: Library }>();
  private readonly moduleGone = new FinalizationRegistry<string>((script) => {
    if (!this.moduleAbcs.get(script)?.deref()) {
      this.moduleAbcs.delete(script);
    }
  });

  constructor(private readonly s: Scripting) {}

  /** Load the libraries the SWF's code links against (builtin, playerglobal), whose scripts run on first use. */
  async loadLibraries(abcs: Uint8Array[]): Promise<void> {
    for (const abc of abcs) {
      this.compileAt(await this.add(abc, true, this.s.rt.root), this.s.rt.root, true);
    }
  }

  /** Load the SWF's DoABCs in tag order, each run unless its lazy flag defers it to first use, then its SymbolClass. */
  async loadSwf(swf: Swf, library: Library): Promise<void> {
    this.s.library = library;
    this.s.symbols.addFontLibrary(library);

    library.domain = this.s.mainDomain;
    this.s.rt.swfVersion = swf.header.version;
    const decoded = decodeImages(library, this.s.decodeImage);
    const run = await this.link(swf, this.s.mainDomain, this.s.url, library);
    await decoded;
    run();
    this.s.bind(swf, library);
  }

  /**
   * The SWF's DoABCs compiled and linked, in tag order: what runs them,
   * each unless its lazy flag defers it to first use. Linking is
   * asynchronous, running is not, so a load can run its code in a frame.
   */
  async link(swf: Swf, domain: avm2.Domain, url: string, library: Library): Promise<() => void> {
    // Every DoABC added before any compiles: avmplus has a frame's ABCs all
    // loaded before it verifies a method, so a class in the first tag may
    // extend or name one in the last (the corpus's property_priority).
    const added: { index: number; lazy: boolean }[] = [];
    for (const t of swf.tags) {
      if (t.code === tags.DoABC || t.code === tags.DoABC2) {
        const { lazy, abc } = readDoAbc(swf.bytes, t);
        added.push({ index: await this.add(abc, false, domain), lazy });
      }
    }

    const runs: (() => void)[] = [];
    for (const { index, lazy } of added) {
      const linked = this.compileAt(index, domain, false, { url, library });
      if (!lazy) {
        runs.push(() => this.s.rt.run(linked));
      }
    }

    return () => {
      for (const run of runs) {
        run();
      }
    };
  }

  /**
   * An ABC added to the compiler's domain, into the application domain of
   * the runtime's `domain`, linked against what that domain sees of those
   * before it, with what it has found: its index among all added.
   */
  private async add(abc: Uint8Array, builtin: boolean, domain: avm2.Domain): Promise<number> {
    const target = this.codegenDomainOf(domain);
    if (domain !== this.s.rt.root) {
      const told = this.reported.get(domain.id) ?? new Set<string>();
      this.reported.set(domain.id, told);
      for (const f of this.s.rt.compileUnit(domain).found) {
        const key = JSON.stringify([f.asType, f.nsKind, f.uri, f.name, f.domain, f.index]);
        const at = this.codegenAbcs.get(f.domain)?.[f.index];
        if (at !== undefined && !told.has(key)) {
          told.add(key);
          this.s.codegen.found({ ...f, domain: target, abc: at });
        }
      }
    }

    const error = this.s.codegen.add(abc, builtin, target);
    if (error) {
      throw new Error(`an ABC was rejected: VerifyError #${error}`);
    }

    this.codegenAbcs.get(domain.id)?.push(this.hashes.length);
    this.hashes.push(await sha256(abc));
    return this.hashes.length - 1;
  }

  /** The compiler's application domain for the runtime's `domain`, made with its ancestors' as needed. */
  private codegenDomainOf(domain: avm2.Domain): number {
    let target = this.codegenDomains.get(domain.id);
    if (target === undefined) {
      target = this.s.codegen.childDomain(this.codegenDomainOf(domain.parent ?? this.s.rt.root));
      this.codegenDomains.set(domain.id, target);
      this.codegenAbcs.set(domain.id, []);
    }

    return target;
  }

  /**
   * ABC `index`'s module, compiled against every ABC added so far that its
   * domain sees, loaded into the runtime's `domain`; `builtin` for the
   * player's own libraries, a SWF's with its `origin`. Each is evaluated
   * under a script name of its own, by which Runtime.codeDomain finds the
   * domain of the code running.
   */
  private compileAt(
    index: number,
    domain: avm2.Domain,
    builtin = false,
    origin?: { url: string; library: Library },
  ): Value {
    const module = this.s.codegen.compileModule(this.hashes, index);
    const script = `swf2es-${++this.modules}.js`;
    const factory = evaluateModule(module, script);
    const linked = this.s.rt.loadInto(domain, () => factory(this.s.rt), builtin);
    if (origin) {
      const abc = linked as object;
      this.moduleAbcs.set(script, new WeakRef(abc));
      this.origins.set(abc, origin);
      this.moduleGone.register(abc, script);
    }

    return linked;
  }

  /** An ApplicationDomain object for the runtime's `domain`: a new one at each ask, as Flash's, without running its constructor. */
  applicationDomainOf(domain: avm2.Domain): AsObject {
    const object = this.s.rt.classNamed("flash.system::ApplicationDomain").$it.instance();
    object.$domain = domain;
    return object;
  }

  /**
   * The domain of the code that asks (Runtime.codeDomain): the main SWF's
   * when no SWF's code is on the stack, only the player's.
   */
  codeDomain(): avm2.Domain {
    const domain = this.s.rt.codeDomain();
    return domain === this.s.rt.root ? this.s.mainDomain : domain;
  }

  /**
   * The URL of the SWF whose code asks, the innermost on the stack, as
   * Flash's code context has it; the main SWF's when only the player's is.
   */
  codeUrl(): string {
    return this.codeOrigin(new Error().stack)?.url ?? this.s.url;
  }

  /** The SWF whose code called a playerglobal native. */
  codeLibrary(): Library | null {
    return this.codeOrigin(new Error().stack)?.library ?? this.s.library;
  }

  /**
   * Where the innermost SWF's code on `stack` came from, if any SWF's is.
   * The stack is the caller's: a frame more of the player's would push the
   * SWF's out of the engine's stackTraceLimit frames sooner.
   */
  private codeOrigin(stack: string | undefined): { url: string; library: Library } | undefined {
    for (const at of avm2.frameScripts(stack)) {
      const abc = this.moduleAbcs.get(at)?.deref();
      const origin = abc && this.origins.get(abc);
      if (origin) {
        return origin;
      }
    }

    return undefined;
  }
}

const EXPORT = "export default ";

/**
 * A module's factory, its source evaluated as a script named `script`.
 * Not imported: a document keeps every module it imports for as long as
 * it lives, so the code of a SWF long let go would never be collected; a
 * script's goes once nothing refers to its functions. A module is one
 * exported function and nothing else, so it runs the same returned from a
 * strict Function, the names its code uses its own function's variables
 * (see Lazy compilation in docs/architecture.md); its lines in a stack
 * are its file's two further on, after Function's header.
 */
function evaluateModule(module: string, script: string): (rt: avm2.Runtime) => Value {
  if (!module.startsWith(EXPORT)) {
    throw new Error("swf2es: a module that is not one exported function");
  }

  const body = `"use strict"; return ${module.slice(EXPORT.length)}//# sourceURL=${script}\n`;
  return new Function(body)();
}
