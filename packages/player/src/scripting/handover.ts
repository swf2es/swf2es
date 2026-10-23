// The primordial's compiled modules handed to its background workers
// (docs/workers.md, slice 5), so that a worker running the same ABCs does
// not compile them again: each Crossbridge thread is a worker, and a large
// Crossbridge SWF takes minutes to compile.
//
// The compiler is deterministic: the same calls on a fresh one give the
// same modules. So the primordial keeps a journal of every call that
// changes what its compiler compiles to, with the module and log each
// compile gave, until its main SWF has linked; a worker journals its own
// calls the same way, and takes the primordial's module for a compile
// only while its journal is the primordial's so far and its ABCs are the
// same bytes. No key is taken: a key names the log, which a worker would
// have to replay every module's for, and replaying verifies each method
// again, half a compile. The logs are replayed only if the worker's
// compiler is used again (a lazy method, a SWF it loads), before that use.
import type { Codegen } from "@swf2es/codegen";

/** A module the primordial compiled, read, or imported, and what compiling it fixed in the compiler's domain. */
export interface HandedModule {
  /** Its source, as a Blob where the host has them, which crosses to a thread without a copy. */
  module?: Blob | string;
  /** Where it was imported from, as a module compiled ahead of time is under a policy without 'unsafe-eval'. */
  url?: string;
  log: string;
}

/** What a worker is handed: the primordial's journal, its ABCs' hashes, and its modules, by the place of their compile in the journal. */
export interface HandedModules {
  ops: string[];
  hashes: string[];
  modules: [number, HandedModule][];
}

/** The primordial's journal, kept while it may hand its modules to workers. */
export class ModuleRecorder {
  private readonly ops: string[] = [];
  private readonly modules = new Map<number, HandedModule>();
  private epoch: number | null = null;
  private frozen: HandedModules | null = null;
  /** Whether calls are still journaled. */
  open = true;

  /** A call on the compiler of `epoch`; another epoch's, as by another player given it, ends the journal. */
  op(text: string, epoch: number): void {
    if (!this.open) {
      return;
    }

    this.epoch ??= epoch;
    if (epoch !== this.epoch) {
      this.open = false;
      return;
    }

    this.ops.push(text);
  }

  /** ABC `index` compiled, read or imported: `module`, with its `log`, null where it has none to replay. */
  compiled(
    index: number,
    epoch: number,
    module: { text?: string; url?: string },
    log: string | null,
  ): void {
    this.op(`compile ${index}`, epoch);
    if (!this.open || log === null) {
      return;
    }

    const text =
      module.text === undefined || typeof Blob !== "function"
        ? module.text
        : new Blob([module.text], { type: "text/javascript" });
    this.modules.set(this.ops.length - 1, {
      ...(text === undefined ? {} : { module: text }),
      ...(module.url === undefined ? {} : { url: module.url }),
      log,
    });
  }

  /** Stop journaling, keeping what was: the ABCs added so far are `hashes`. */
  freeze(hashes: string[]): void {
    if (this.frozen) {
      return;
    }

    this.open = false;
    this.frozen = { ops: this.ops, hashes: hashes.slice(), modules: [...this.modules] };
  }

  /** Stop journaling and let the modules go: no worker will be handed them. */
  drop(): void {
    this.open = false;
    this.ops.length = 0;
    this.modules.clear();
    this.frozen = { ops: [], hashes: [], modules: [] };
  }

  /** What a worker is handed: null if nothing. */
  handed(hashes: string[]): HandedModules | null {
    const handed = this.frozen ?? { ops: this.ops.slice(), hashes, modules: [...this.modules] };
    return handed.modules.length ? handed : null;
  }
}

/** A worker's side: its journal checked against the primordial's, and the logs of the modules it took, until replayed. */
export class ModuleHandover {
  private readonly modules: Map<number, HandedModule>;
  private at = 0;
  private matching = true;
  /** How many of the worker's ABCs are known to be the primordial's. */
  private same = 0;
  private readonly pending: { index: number; log: string }[] = [];

  constructor(private readonly handed: HandedModules) {
    this.modules = new Map(handed.modules);
  }

  /** A call on the worker's compiler, as the primordial journals one. */
  op(text: string): void {
    if (this.matching) {
      this.matching = this.handed.ops[this.at] === text;
      this.at++;
    }
  }

  /** A call the journal does not follow: nothing more is taken. */
  stop(): void {
    this.matching = false;
  }

  /**
   * The primordial's module for ABC `index`, to load in place of compiling
   * it, if its compile comes next in the primordial's journal and every
   * ABC so far, `hashes`, is the primordial's; the compile is journaled
   * then, and its log kept for replay. Null if not: the caller compiles.
   */
  take(index: number, hashes: string[]): HandedModule | null {
    const module = this.matching ? this.modules.get(this.at) : undefined;
    if (
      module === undefined ||
      this.handed.ops[this.at] !== `compile ${index}` ||
      !this.sameAbcs(hashes)
    ) {
      return null;
    }

    this.modules.delete(this.at);
    this.at++;
    this.pending.push({ index, log: module.log });
    return module;
  }

  private sameAbcs(hashes: string[]): boolean {
    if (hashes.length > this.handed.hashes.length) {
      return false;
    }

    while (this.same < hashes.length && hashes[this.same] === this.handed.hashes[this.same]) {
      this.same++;
    }

    return this.same === hashes.length;
  }

  /**
   * `codegen`, which before any call replays the logs of the modules taken
   * so far, so that the domain is then as their compiles would have left it.
   */
  guard(codegen: Codegen): Codegen {
    const wrapped = new Map<PropertyKey, unknown>();
    return new Proxy(codegen, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }

        let f = wrapped.get(key);
        if (f === undefined) {
          f = (...args: unknown[]) => {
            this.flush(target);
            return value.apply(target, args);
          };
          wrapped.set(key, f);
        }

        return f;
      },
    });
  }

  /** Replay the logs of the modules taken, in order. */
  private flush(codegen: Codegen): void {
    for (const { index, log } of this.pending.splice(0)) {
      if (!codegen.replay(log, index)) {
        throw new Error("swf2es: a module the primordial handed to a worker did not replay");
      }
    }
  }
}

/** The bytes of "WorkerDomain", the class an ABC names to make a worker. */
const WORKER_DOMAIN = Array.from("WorkerDomain", (c) => c.charCodeAt(0));

/** Whether any of `abcs` names WorkerDomain in its strings: only then may its SWF make a worker. */
export function namesWorkerDomain(abcs: Uint8Array[]): boolean {
  const first = WORKER_DOMAIN[0];
  for (const abc of abcs) {
    const end = abc.length - WORKER_DOMAIN.length;
    for (let at = abc.indexOf(first); at !== -1 && at <= end; at = abc.indexOf(first, at + 1)) {
      let k = 1;
      while (k < WORKER_DOMAIN.length && abc[at + k] === WORKER_DOMAIN[k]) {
        k++;
      }

      if (k === WORKER_DOMAIN.length) {
        return true;
      }
    }
  }

  return false;
}
