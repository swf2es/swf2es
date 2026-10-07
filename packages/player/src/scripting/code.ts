// The SWFs' code: each DoABC added to the compiler in the application
// domain its SWF loads into, compiled into a module once all of its SWF's
// are added, evaluated and linked into the runtime; and, by the module a
// stack frame is of, the domain, URL and SWF of the code that runs.
import { readDoAbc, type Swf, tags } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { decodeImages } from "../bitmap/images.js";
import type { Library } from "../display/timeline.js";
import type { ModuleCache } from "../hosts.js";
import type { Scripting } from "../scripting.js";
import { sha256 } from "./sha256.js";

type AsObject = avm2.AsObject;
type Value = avm2.Value;

/** The API version of the SWFs' ABCs, Flash Player's, that the compiler's domain starts with. */
export const API_VERSION = 50;

export class Code {
  /** Each ABC's hash, by its index in the compiler; "" once its domain is dropped. */
  private readonly hashes: string[] = [];
  /** Whether each ABC was added as one of the player's own libraries, by its index. */
  private readonly builtins: boolean[] = [];
  /**
   * The compiler's application domain for each of the runtime's, by its
   * number; the compiler's index of each ABC added into one, in order; and
   * the findings each has been told (see add).
   */
  private readonly codegenDomains = new Map<number, number>([[0, 0]]);
  private readonly codegenAbcs = new Map<number, number[]>([[0, []]]);
  private readonly reported = new Map<number, Set<string>>();
  /**
   * A runtime domain let go of, by its number: no code of its SWFs is left
   * to run, nor of its descendants', which keep it while they live. The
   * compiler drops its domain, the ABCs in it and what they took, and so
   * does Code. Their hashes are no module's linked ABCs, since no live
   * domain saw them. Not if the compiler was reset since, as by another
   * player given it: its numbers are another domain's then.
   */
  private readonly domainGone = new FinalizationRegistry<{ id: number; epoch: number }>(
    ({ id, epoch }) => {
      this.forget(id, epoch);
    },
  );

  /** Let go of runtime domain `id`, which the compiler of `epoch` knew. */
  private forget(id: number, epoch: number): void {
    const target = this.codegenDomains.get(id);
    if (target === undefined) {
      return;
    }

    this.s.codegen.dropDomain(target, epoch);
    this.compactSoon();
    for (const index of this.codegenAbcs.get(id) ?? []) {
      this.hashes[index] = "";
    }

    this.codegenDomains.delete(id);
    this.codegenAbcs.delete(id);
    this.reported.delete(id);
    this.evictable.delete(id);
    this.revived.delete(id);
  }

  /** Whether a compaction is asked for and has not run yet. */
  private compacting = false;

  /**
   * Have the compiler reuse what dropped and evicted domains took, if that
   * is worth a rebuild, when the page is next idle (or soon, without
   * requestIdleCallback): a rebuild links every live ABC again, too long to
   * do in a load's frame.
   */
  private compactSoon(): void {
    if (this.compacting) {
      return;
    }

    this.compacting = true;
    const compact = () => {
      this.compacting = false;
      this.s.codegen.compact();
    };
    const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: object) => void })
      .requestIdleCallback;
    if (idle) {
      idle(compact, { timeout: 1000 });
    } else {
      setTimeout(compact, 0);
    }
  }
  /**
   * The ABCs of each domain but the root and the main SWF's, by their
   * indices in the compiler, to revive it with once its SWF has linked and
   * it was evicted (see link); and the domains revived so, which stay live,
   * as something adds to them, or under them, again.
   */
  private readonly evictable = new Map<number, Map<number, Uint8Array>>();
  private readonly revived = new Set<number>();
  /** How many links are in progress in each domain or under it, which keep it live. */
  private readonly linking = new Map<number, number>();
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
      await this.compileAt(await this.add(abc, true, this.s.rt.root), this.s.rt.root, true);
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
    const runs: (() => void)[] = [];
    this.pin(domain, 1);
    try {
      for (const t of swf.tags) {
        if (t.code === tags.DoABC || t.code === tags.DoABC2) {
          const { lazy, abc } = readDoAbc(swf.bytes, t);
          added.push({ index: await this.add(abc, false, domain), lazy });
        }
      }

      for (const { index, lazy } of added) {
        const linked = await this.compileAt(index, domain, false, { url, library });
        if (!lazy) {
          runs.push(() => this.s.rt.run(linked));
        }
      }
    } finally {
      this.pin(domain, -1);
      this.evict(domain);
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
    this.evictable.get(domain.id)?.set(this.hashes.length, abc.slice());
    this.builtins.push(builtin);
    this.hashes.push(await sha256(abc));
    return this.hashes.length - 1;
  }

  /**
   * The compiler's application domain for the runtime's `domain`, live:
   * made with its ancestors' as needed, or revived with them if evicted.
   */
  private codegenDomainOf(domain: avm2.Domain): number {
    let target = this.codegenDomains.get(domain.id);
    if (target === undefined) {
      target = this.s.codegen.childDomain(this.codegenDomainOf(domain.parent ?? this.s.rt.root));
      this.codegenDomains.set(domain.id, target);
      this.codegenAbcs.set(domain.id, []);
      if (domain !== this.s.mainDomain) {
        this.evictable.set(domain.id, new Map());
      }

      this.domainGone.register(domain, { id: domain.id, epoch: this.s.codegen.epoch });
    } else if (!this.s.codegen.isLive(target)) {
      // With its evicted ancestors, all at once: one rebuild at most.
      const abcs = new Map<number, Uint8Array>();
      for (let d: avm2.Domain | null = domain; d; d = d.parent) {
        const at = this.codegenDomains.get(d.id);
        if (at === undefined || this.s.codegen.isLive(at)) {
          break;
        }

        for (const [index, bytes] of this.evictable.get(d.id) ?? []) {
          abcs.set(index, bytes);
        }

        this.revived.add(d.id);
      }

      this.s.codegen.reviveDomain(target, abcs);
    }

    return target;
  }

  /** Count a link in progress in `domain` (`by` 1) or one done (-1), for it and its ancestors. */
  private pin(domain: avm2.Domain, by: number): void {
    for (let d: avm2.Domain | null = domain; d; d = d.parent) {
      const count = (this.linking.get(d.id) ?? 0) + by;
      if (count > 0) {
        this.linking.set(d.id, count);
      } else {
        this.linking.delete(d.id);
      }
    }
  }

  /**
   * Evict the compiler's domain for `domain` once its SWF has linked, its
   * ABCs compiled: what they took is reused at once, not when the runtime
   * lets the domain go, which a garbage collection may put off for hundreds
   * of loads. Not the root's or the main SWF's, nor one with a link in
   * progress in it or under it, nor one revived before: an evicted domain
   * is revived, which may link every live ABC again, when a SWF loads into
   * it or under it, so a domain loaded into again stays.
   */
  private evict(domain: avm2.Domain): void {
    const target = this.codegenDomains.get(domain.id);
    if (
      target !== undefined &&
      this.evictable.has(domain.id) &&
      !this.revived.has(domain.id) &&
      !this.linking.has(domain.id)
    ) {
      this.s.codegen.evictDomain(target);
      this.compactSoon();
    }
  }

  /**
   * ABC `index`'s module, compiled against every ABC added so far that its
   * domain sees, or as the host's module cache kept it, loaded into the
   * runtime's `domain`; `builtin` for the player's own libraries, a SWF's
   * with its `origin`. Each is evaluated under a script name of its own, by
   * which Runtime.codeDomain finds the domain of the code running.
   */
  private async compileAt(
    index: number,
    domain: avm2.Domain,
    builtin = false,
    origin?: { url: string; library: Library },
  ): Promise<Value> {
    const script = `swf2es-${++this.modules}.js`;
    const factory = await this.moduleOf(index, domain, script);
    const linked = this.s.rt.loadInto(domain, () => factory(this.s.rt), builtin);
    if (origin) {
      const abc = linked as object;
      this.moduleAbcs.set(script, new WeakRef(abc));
      this.origins.set(abc, origin);
      this.moduleGone.register(abc, script);
    }

    return linked;
  }

  /**
   * ABC `index`'s module evaluated as `script`: the cache's, if the host
   * has one that holds it and it evaluates, else compiled, and given to
   * the cache. Any error of the cache's is a miss.
   */
  private async moduleOf(
    index: number,
    domain: avm2.Domain,
    script: string,
  ): Promise<(rt: avm2.Runtime) => Value> {
    const cache = this.s.moduleCache;
    if (!cache) {
      return evaluateModule(this.s.codegen.compileModule(this.hashes, index), script);
    }

    try {
      const cached = await cache.get(await sha256Text(this.moduleKey(index, domain, cache)));
      if (typeof cached === "string") {
        return evaluateModule(cached, script);
      }
    } catch {
      // Unreadable, or not a module: compiled and stored again below.
    }

    // The key again, next to the compile: the awaits above let other loads
    // add ABCs that this one's domain sees.
    const key = this.moduleKey(index, domain, cache);
    const module = this.s.codegen.compileModule(this.hashes, index);
    sha256Text(key)
      .then((k) => cache.put(k, module))
      .catch(() => {});
    return evaluateModule(module, script);
  }

  /**
   * What ABC `index`'s module depends on, as the cache keys it: the
   * compiler, the API version, every ABC its domain sees when it compiles,
   * in load order, those added after it included (a SWF's are all added
   * before any compiles), with its own place among them, and what its
   * domain and their ancestors have found (Codegen.found), each by the
   * hash of the ABC that defines it. A superset of what codegen's cacheKey
   * names, which leaves out those added after it.
   */
  private moduleKey(index: number, domain: avm2.Domain, cache: ModuleCache): string {
    const seen: number[] = [];
    const found: string[] = [];
    for (let d: avm2.Domain | null = domain; d; d = d.parent) {
      seen.push(...(this.codegenAbcs.get(d.id) ?? []));
      for (const told of this.reported.get(d.id) ?? []) {
        const [asType, nsKind, uri, name, at, i] = JSON.parse(told);
        const by = this.codegenAbcs.get(at)?.[i];
        found.push(
          JSON.stringify([asType, nsKind, uri, name, by === undefined ? "" : this.hashes[by]]),
        );
      }
    }

    seen.sort((a, b) => a - b);
    return JSON.stringify({
      compiler: cache.compiler,
      api: API_VERSION,
      abcs: seen.map((i) => `${this.builtins[i] ? "builtin " : ""}${this.hashes[i]}`),
      own: seen.indexOf(index),
      found: found.sort(),
    });
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

/** The SHA-256 of `text`'s UTF-8, a cache key of fixed length however many ABCs it names. */
function sha256Text(text: string): Promise<string> {
  return sha256(new TextEncoder().encode(text));
}

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
