// The parity harness's suites (run.ts): a suite's cases run on each build,
// and the results a case leaves, compared across the builds.
import { createHash } from "node:crypto";
import type { CodegenExports } from "../../packages/codegen/dist/zig.js";

/**
 * A suite's results: a line a case, large results by their digests. The
 * bytes of a large result are kept only for the cases named in `capture`,
 * which a second run asks for where the digests differ, so that a suite
 * of a corpus does not hold every module of three compilers.
 */
export class Results {
  readonly lines: string[] = [];
  /** Each line's case name, which a large result's bytes are kept by. */
  readonly names: string[] = [];
  readonly blobs = new Map<string, Uint8Array>();
  /** The cases that threw, and what each threw. */
  readonly throws: [name: string, thrown: string][] = [];
  /** What the suite ran on, said on its line: its seeds and where they came from. */
  readonly inputs: string[] = [];
  /** Why the suite ran on fewer inputs than it can here, where it did: a cache or corpus missing. */
  readonly partial: string[] = [];
  /** Why the suite fails whatever the builds give, where it does: inputs too few to test anything. */
  readonly problems: string[] = [];

  readonly capture: ReadonlySet<string>;
  /** Which build's: reference, candidate or poison. */
  readonly compiler: string;

  constructor(compiler: string, capture: ReadonlySet<string> = new Set()) {
    this.compiler = compiler;
    this.capture = capture;
  }

  /** Case `name`'s result, or what it threw. */
  case(name: string, run: () => string | number | boolean): void {
    this.names.push(name);
    try {
      this.lines.push(`${name}: ${run()}`);
    } catch (error) {
      this.lines.push(`${name}: ${this.thrown(name, error)}`);
    }
  }

  /** What case `name` threw, as its result reads, counted as a throw. */
  thrown(name: string, error: unknown): string {
    const e = error as Error;
    const text = `threw ${e?.name}: ${e?.message}`;
    this.throws.push([name, text]);
    return text;
  }

  /** The suite's inputs, said on its line; `missing`, where some could not be had here, marks it partial. */
  input(text: string, missing?: string): void {
    this.inputs.push(text);
    if (missing) {
      this.partial.push(missing);
    }
  }

  /** A large result, as its length and digest; its bytes too where they are asked for. */
  blob(name: string, bytes: Uint8Array): string {
    if (this.capture.has(name)) {
      this.blobs.set(name, bytes.slice());
    }

    return `${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`;
  }
}

/**
 * Whether a throw is the compiler running out of memory, which a hostile
 * input may make it do and the builds then agree on; any other throw from
 * the candidate or its poison build is a trap or the harness's own mistake,
 * and fails the run even where every build threw the same.
 */
export const outOfMemory = (thrown: string) => /ran out of memory/.test(thrown);

/** Either build, bound; the test builds' exports beyond are reached by name. */
// biome-ignore lint/suspicious/noExplicitAny: the test builds' exports are typed by their signatures alone
export type Compiler = CodegenExports & Record<string, any>;

export interface Suite {
  name: string;
  /** Why the suite cannot run here, if it cannot: one of what only some hosts have, which the ratchet leaves out. */
  unavailable?: () => string | null;
  /** The release builds, or the test builds with their dumps. */
  build: "release" | "testing";
  /** The exports it calls. */
  needs: string[];
  /** Its cases on `compiler`; `fresh` makes another instance of the same compiler, for a case that may kill one. */
  run(compiler: Compiler, results: Results, fresh: () => Promise<Compiler>): void | Promise<void>;
}
