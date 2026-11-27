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
      const e = error as Error;
      this.lines.push(`${name}: threw ${e?.name}: ${e?.message}`);
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
