/**
 * Compiles ABC (and later AVM1) bytecode to ES modules.
 *
 * The same code runs as the browser JIT (lazily, per method, in a worker pool)
 * and as the ahead-of-time compiler. For the output to be identical in both
 * modes, compilation must be a pure function of its input: no DOM or node
 * APIs, no clock, no randomness, and one method's output never depends on
 * which other methods were compiled before it. See docs/architecture.md.
 */

/** Bumped whenever generated code or the runtime ABI it calls changes. */
export const COMPILER_VERSION = "0.0.0";

/**
 * Cache key for compiled output. Browser caches, the AOT server and the JIT
 * all use this key, so their results are interchangeable.
 */
export function cacheKey(abcHash: string): string {
  return "swf2es@" + COMPILER_VERSION + ":" + abcHash;
}
