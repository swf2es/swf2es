// The ABCs of the SWFs a player loads compiled on a background thread, off
// the page's, in eager compilation only (docs/architecture/compiler.md,
// "The background compiler").
//
// The compiler is deterministic and stateful: what an ABC compiles to
// follows from every call made on the compiler before. So the thread runs
// a codegen of its own, made the page's twin by every call that changes
// what the page's compiles to, in the order the page makes them, and a
// compile asked of it gives the module the page's would have at that place
// in the order. A compile the page does itself is compiled again there,
// not replayed, so that the thread's is the page's by the same calls
// alone. The page's compiler then replays the thread's compile from its
// log, as it does a module from the module cache, and is as if it had
// compiled it.
//
// The thread starts with the first load, which compiles on the page's
// thread meanwhile: a SWF that loads no code starts none. Until then the
// calls wait in a journal, which the thread is posted first. A player let
// go of without being destroyed stops its thread as it is collected.
//
// While a compile is out, the page's compiler waits for it: a call that can
// wait (a domain dropped or evicted, a compaction, a finding) is done once
// the compiles asked before it are, and one that cannot is preceded by
// those compiles, done here, their answers ignored. Loads link one at a
// time, so that is a safeguard. Where the thread cannot help, as when it
// does not start, fails, or its compiler gives what the page's did not,
// the page compiles, as without one, and keeps doing so.
import type { Codegen, LoggedModule } from "@swf2es/codegen";
import type { CompilerHost, CompilerThread } from "../hosts.js";
import type { CompilerOp, FromCompiler } from "../workers/compiler.js";

/** The calls that change nothing an ABC compiles to, made on the page's compiler alone. */
const READS = new Set<PropertyKey>([
  "identity",
  "abcVersion",
  "apiVersion",
  "epoch",
  "usage",
  "isLive",
  "context",
  "revision",
  // AVM1's, which no application domain holds.
  "compileActions",
  "compileActionsModule",
  "compileActionBlocks",
  "compileActionUnit",
  "releaseActions",
  "heldActions",
]);

/** A compile asked of the thread: what it was asked with, and its answer once it came. */
interface Asked {
  id: number;
  hashes: string[];
  index: number;
  answer?: LoggedModule;
  resolve(compiled: LoggedModule): void;
  reject(error: unknown): void;
}

/** What the page's compiler does once the compiles asked before it are: a compile, or a call that waited. */
type Pending = { asked: Asked } | { later: () => void };

/** The threads of compilers let go of without being stopped, stopped as they are collected. */
const threadsLeft = new FinalizationRegistry<CompilerThread>((thread) => thread.terminate());

export class BackgroundCompiler {
  /** The page's compiler as the player calls it: each call that changes it made on the thread's too. */
  readonly codegen: Codegen;
  private thread: CompilerThread | null = null;
  /** Idle until the first load, running once its thread is, and stopped for good once it is let go of or fails. */
  private state: "idle" | "running" | "stopped" = "idle";
  /** Whether the thread has said its codegen is made. */
  private started = false;
  private readonly pending: Pending[] = [];
  private outbox: CompilerOp[] = [];
  private transfers: Transferable[] = [];
  private flushQueued = false;
  /** The ABCs' hashes as the thread has them. */
  private readonly sent: string[] = [];
  private ids = 0;
  /** The page's compiler's epoch after the reset the thread was told of. */
  private epoch: number | null = null;
  private readonly usages = new Map<
    number,
    (usage: { live: number; dead: number; memory: number } | null) => void
  >();
  /** Whether each module the thread compiles is compiled here too, and compared (tests). */
  private readonly verify: boolean;

  constructor(
    private readonly target: Codegen,
    private readonly host: CompilerHost,
  ) {
    this.verify = host.verify ?? false;
    const wrapped = new Map<PropertyKey, unknown>();
    this.codegen = new Proxy(target, {
      get: (t, key) => {
        const value = Reflect.get(t, key);
        if (typeof value !== "function") {
          return value;
        }

        let f = wrapped.get(key);
        if (f === undefined) {
          f = (...args: unknown[]) => this.call(key, value, args);
          wrapped.set(key, f);
        }

        return f;
      },
    });
  }

  /** Whether compiles go to the thread, or will once it has started. */
  get available(): boolean {
    return this.state !== "stopped";
  }

  /**
   * ABC `index`'s module and log, compiled on the thread, `hashes` the
   * ABCs' hashes: what the page's compiler would compile now. Once it
   * resolves, the page's compiler is as that compile would have left it.
   * Compiled here while the thread starts, as the first is, and where it
   * is gone.
   */
  compile(hashes: string[], index: number): Promise<LoggedModule> {
    if (this.state === "idle") {
      this.begin();
    }

    if (this.thread === null || !this.started) {
      try {
        return Promise.resolve(this.codegen.compileModuleLogged(hashes, index));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise((resolve, reject) => {
      const id = ++this.ids;
      const asked: Asked = { id, hashes: hashes.slice(), index, resolve, reject };
      this.send({ op: "compile", hashes: this.changed(hashes), index, id });
      this.pending.push({ asked });
      this.flush();
    });
  }

  /** What the thread's compiler holds of its memory (Codegen.usage); null without a thread. */
  usage(): Promise<{ live: number; dead: number; memory: number } | null> {
    if (this.thread === null) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const id = ++this.ids;
      this.usages.set(id, resolve);
      this.send({ op: "usage", id });
      this.flush();
    });
  }

  /** Stop the thread for good, as the player goes: compiles still out fail, and the page's compiler is left as it is. */
  stop(): void {
    if (this.state === "stopped") {
      return;
    }

    this.state = "stopped";
    this.release();
    for (const entry of this.pending.splice(0)) {
      if ("asked" in entry) {
        entry.asked.reject(new Error("swf2es: the player was destroyed"));
      }
    }

    this.answerUsages();
  }

  private call(key: PropertyKey, f: (...args: unknown[]) => unknown, args: unknown[]): unknown {
    const t = this.target;
    if (this.state === "stopped" || READS.has(key)) {
      return f.apply(t, args);
    }

    // Reset by another player given the same codegen: its domains are no longer this one's.
    if (key !== "reset" && this.epoch !== t.epoch) {
      this.fail(new Error("its codegen was reset by another"));
      return f.apply(t, args);
    }

    switch (key) {
      case "dropDomain": {
        const [domain, of] = args as [number, number | undefined];
        // As the page's would, nothing for a domain of another epoch.
        if (of === undefined || of === t.epoch) {
          this.later(() => t.dropDomain(domain), { op: "drop", domain });
        }

        return undefined;
      }

      case "evictDomain": {
        const [domain] = args as [number];
        this.later(() => t.evictDomain(domain), { op: "evict", domain });
        return undefined;
      }

      case "compact": {
        let compacted = false;
        this.later(
          () => {
            compacted = t.compact();
          },
          { op: "compact" },
        );
        return compacted;
      }

      case "found": {
        const [definition] = args as Parameters<Codegen["found"]>;
        this.later(() => t.found(definition), { op: "found", definition });
        return undefined;
      }

      default:
        break;
    }

    // The rest gives what it gives at once: the compiles asked first are done here first.
    this.drain();
    try {
      return this.mirror(key, f, args);
    } catch (error) {
      // What the call did before it threw is not known: the thread's cannot follow.
      this.fail(error);
      throw error;
    }
  }

  /** A call that cannot wait, made on the page's compiler, then sent to the thread's. */
  private mirror(key: PropertyKey, f: (...args: unknown[]) => unknown, args: unknown[]): unknown {
    const t = this.target;
    switch (key) {
      case "reset": {
        f.apply(t, args);
        this.epoch = t.epoch;
        this.send({ op: "reset", api: t.apiVersion });
        return undefined;
      }

      case "add": {
        const [abc, builtin = false, domain = 0] = args as [Uint8Array, boolean?, number?];
        const gave = t.add(abc, builtin, domain);
        // Its own buffer: a view of a SWF's would carry the whole SWF across.
        const copy = abc.slice();
        this.send({ op: "add", abc: copy, builtin, domain, gave }, [copy.buffer]);
        return gave;
      }

      case "childDomain": {
        const [parent] = args as [number];
        const gave = t.childDomain(parent);
        this.send({ op: "child", parent, gave });
        return gave;
      }

      case "reviveDomain": {
        const [domain, abcs] = args as Parameters<Codegen["reviveDomain"]>;
        t.reviveDomain(domain, abcs);
        this.send({ op: "revive", domain, abcs });
        return undefined;
      }

      case "replay": {
        const [log, index = -1] = args as [string, number?];
        const gave = t.replay(log, index);
        this.send({ op: "replay", log, index, gave });
        return gave;
      }

      case "compile":
      case "compileModule":
      case "compileModuleLogged": {
        const [hashes = [], index = -1] = args as [string[]?, number?];
        const compiled = f.apply(t, args);
        this.send({ op: "compile", hashes: this.changed(hashes), index, id: null });
        return compiled;
      }

      default:
        // A lazy compile, or a call this does not know: the thread's cannot follow.
        this.fail(new Error(`${String(key)} is not mirrored`));
        return f.apply(t, args);
    }
  }

  /** A call that can wait for the compiles asked before it, made now if none is out, and sent to the thread's. */
  private later(run: () => void, op: CompilerOp): void {
    this.send(op);
    if (this.pending.length === 0) {
      run();
    } else {
      this.pending.push({ later: run });
    }
  }

  /** The hashes that changed since the thread was last sent them, by their indices. */
  private changed(hashes: string[]): [number, string][] {
    const changed: [number, string][] = [];
    for (let i = 0; i < hashes.length; i++) {
      if (this.sent[i] !== hashes[i]) {
        changed.push([i, hashes[i]]);
        this.sent[i] = hashes[i];
      }
    }

    return changed;
  }

  /** Queue `op` for the thread, posted with the others of this turn; kept till it starts, before. */
  private send(op: CompilerOp, transfer: Transferable[] = []): void {
    this.outbox.push(op);
    this.transfers.push(...transfer);
    if (this.thread !== null && !this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.thread === null || this.outbox.length === 0) {
      return;
    }

    const batch = this.outbox;
    const transfers = this.transfers;
    this.outbox = [];
    this.transfers = [];
    try {
      this.thread?.post(batch, transfers);
    } catch (error) {
      this.fail(error);
    }
  }

  private receive(message: FromCompiler): void {
    if (this.thread === null) {
      return;
    }

    switch (message.type) {
      case "ready":
        this.started = true;
        break;
      case "compiled": {
        const entry = this.pending.find((p) => "asked" in p && p.asked.id === message.id);
        // One done here meanwhile has no entry left.
        if (entry && "asked" in entry) {
          entry.asked.answer = { module: message.module, log: message.log };
          this.pump();
        }

        break;
      }

      case "failed":
        this.fail(new Error(message.error));
        break;
      case "usage":
        this.usages.get(message.id)?.(message.usage);
        this.usages.delete(message.id);
        break;
    }
  }

  /** Do what waits at the head, in order: the compiles answered, replayed, and the calls behind them. */
  private pump(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if ("asked" in head && head.asked.answer === undefined) {
        return;
      }

      this.pending.shift();
      this.settle(head);
    }
  }

  /** Everything pending done now, in order: a compile not yet answered compiled here. */
  private drain(): void {
    for (const entry of this.pending.splice(0)) {
      this.settle(entry);
    }
  }

  private settle(entry: Pending): void {
    if ("later" in entry) {
      entry.later();
      return;
    }

    const { asked } = entry;
    const t = this.target;
    try {
      const answer = asked.answer;
      if (answer === undefined || answer.log === null || this.verify) {
        const own = t.compileModuleLogged(asked.hashes, asked.index);
        if (answer && this.verify && (own.module !== answer.module || own.log !== answer.log)) {
          this.fail(new Error(`its module for ABC ${asked.index} is not the page's`));
          throw new Error(
            `swf2es: the background compiler's module for ABC ${asked.index} is not the page's`,
          );
        }

        asked.resolve(own);
        return;
      }

      if (t.replay(answer.log, asked.index)) {
        asked.resolve(answer);
        return;
      }

      // The log did not replay, so the domain is as no compile left it: the
      // module is compiled here, as one from the cache would be, before
      // what waits behind it, and the thread's compiler is no longer the page's.
      let own: LoggedModule;
      try {
        own = t.compileModuleLogged(asked.hashes, asked.index);
      } finally {
        this.fail(new Error(`its log for ABC ${asked.index} did not replay`));
      }

      asked.resolve(own);
    } catch (error) {
      asked.reject(error);
    }
  }

  /**
   * Start the thread, posting it the calls made so far, its answers to
   * this compiler held weakly, so that a player let go of without being
   * destroyed is collected, its thread stopped then.
   */
  private begin(): void {
    const self = new WeakRef(this);
    try {
      const thread = this.host.start(
        (message) => self.deref()?.receive(message),
        (error) => self.deref()?.fail(error),
      );
      if (this.state === "stopped") {
        thread.terminate();
        return;
      }

      this.thread = thread;
      this.state = "running";
      threadsLeft.register(this, thread, this);
      this.flush();
    } catch (error) {
      this.fail(error);
    }
  }

  /** The thread cannot help any more: it goes, and what is pending is done here, in order. */
  private fail(error: unknown): void {
    if (this.state === "stopped") {
      return;
    }

    this.state = "stopped";
    console.warn(`swf2es: loaded SWFs compile on the page's thread, as the compiler's: ${error}`);
    this.release();
    this.drain();
    this.answerUsages();
  }

  /** Let go of the thread and of what was to be posted to it. */
  private release(): void {
    this.thread?.terminate();
    this.thread = null;
    threadsLeft.unregister(this);
    this.outbox = [];
    this.transfers = [];
  }

  private answerUsages(): void {
    for (const answer of this.usages.values()) {
      answer(null);
    }

    this.usages.clear();
  }
}
