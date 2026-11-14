// The background compiler's thread (scripting/compiler.ts): a codegen of
// its own, kept as the page's by the same calls in the same order, which
// compiles the ABCs of the SWFs a player loads off the page's thread. It
// imports codegen alone, so that a Web Worker running it loads little. A
// host runs this in a Web Worker; nothing here knows which.
import { type Codegen, createCodegen, type FoundDefinition } from "@swf2es/codegen";

/** What a compiler's thread is posted first: codegen's compiled module. */
export interface CompilerStart {
  codegen: WebAssembly.Module;
}

/**
 * A call on the page's compiler, done again on the thread's in its place
 * in the order: each with what it gave there, where it gives something,
 * which the thread's must give too. A compile with an `id` is the page's
 * request, answered with its module and log; without one, a compile the
 * page did itself, which the thread's does too and keeps to itself.
 * `hashes` are the ABCs' hashes that changed since the last compile's,
 * by their indices.
 */
export type CompilerOp =
  | { op: "reset"; api: number }
  | { op: "add"; abc: Uint8Array; builtin: boolean; domain: number; gave: number }
  | { op: "child"; parent: number; gave: number }
  | { op: "drop"; domain: number }
  | { op: "evict"; domain: number }
  | { op: "revive"; domain: number; abcs: Map<number, Uint8Array> }
  | { op: "compact" }
  | { op: "found"; definition: FoundDefinition }
  | { op: "replay"; log: string; index: number; gave: boolean }
  | { op: "compile"; hashes: [number, string][]; index: number; id: number | null }
  | { op: "usage"; id: number };

/**
 * What the thread answers: that its codegen is made; a requested compile's
 * module and log, or its error; a call that did not give what the page's
 * did, after which it does nothing more (`id` null), as its compiler is no
 * longer the page's; and its codegen's usage, for a test that its memory
 * stays bounded.
 */
export type FromCompiler =
  | { type: "ready" }
  | { type: "compiled"; id: number; module: string; log: string | null }
  | { type: "failed"; id: number | null; error: string }
  | { type: "usage"; id: number; usage: { live: number; dead: number; memory: number } };

/** How a compiler's thread talks to the page: a Web Worker's global scope, or a test's port. */
export interface CompilerPort {
  post(message: FromCompiler): void;
  /** Takes each message from the page, in order: a CompilerStart first, then batches of calls. */
  listen(receive: (message: CompilerStart | CompilerOp[]) => void): void;
}

/** Run a compiler for the page, on this thread, until the page terminates it. */
export function runCompilerThread(port: CompilerPort): void {
  let codegen: Codegen | null = null;
  // Batches that came while codegen was being made, applied once it is.
  const early: CompilerOp[][] = [];
  const hashes: string[] = [];
  // Once a call gave what the page's did not, nothing more is done.
  let parted = false;

  const part = (error: string, id: number | null = null) => {
    parted = true;
    port.post({ type: "failed", id, error });
  };

  const apply = (c: Codegen, op: CompilerOp) => {
    switch (op.op) {
      case "reset":
        c.reset(op.api);
        break;
      case "add": {
        const gave = c.add(op.abc, op.builtin, op.domain);
        if (gave !== op.gave) {
          part(`an ABC added gave ${gave}, the page's ${op.gave}`);
        }

        break;
      }

      case "child": {
        const gave = c.childDomain(op.parent);
        if (gave !== op.gave) {
          part(`a domain made was ${gave}, the page's ${op.gave}`);
        }

        break;
      }

      case "drop":
        c.dropDomain(op.domain);
        break;
      case "evict":
        c.evictDomain(op.domain);
        break;
      case "revive":
        c.reviveDomain(op.domain, op.abcs);
        break;
      case "compact":
        c.compact();
        break;
      case "found":
        c.found(op.definition);
        break;
      case "replay": {
        const gave = c.replay(op.log, op.index);
        if (gave !== op.gave) {
          part(`a log replayed gave ${gave}, the page's ${op.gave}`);
        }

        break;
      }

      case "compile":
        for (const [index, hash] of op.hashes) {
          hashes[index] = hash;
        }

        if (op.id === null) {
          c.compileModule(hashes, op.index);
        } else {
          const { module, log } = c.compileModuleLogged(hashes, op.index);
          port.post({ type: "compiled", id: op.id, module, log });
        }

        break;
      case "usage":
        port.post({ type: "usage", id: op.id, usage: c.usage() });
        break;
    }
  };

  const run = (batch: CompilerOp[]) => {
    for (const op of batch) {
      if (parted) {
        // A request is still answered, so that the page does not wait on it.
        if (op.op === "compile" && op.id !== null) {
          port.post({ type: "failed", id: op.id, error: "the compiler parted from the page's" });
        }

        continue;
      }

      try {
        apply(codegen as Codegen, op);
      } catch (error) {
        // The page's call gave no error, or it would not have been sent:
        // a requested compile's the page makes again, and finds its own.
        part(String(error), op.op === "compile" ? op.id : null);
      }
    }
  };

  port.listen((message) => {
    if (!Array.isArray(message)) {
      createCodegen(message.codegen).then(
        (made) => {
          codegen = made;
          port.post({ type: "ready" });
          for (const batch of early.splice(0)) {
            run(batch);
          }
        },
        (error) => part(`codegen did not start: ${error}`),
      );
      return;
    }

    if (codegen === null) {
      early.push(message);
    } else {
      run(message);
    }
  });
}
