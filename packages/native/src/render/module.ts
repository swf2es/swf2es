import { binary } from "./binary.js";

let module: WebAssembly.Module | null = null;

/**
 * The render module (root.zig), compiled once and shared: the bitmap
 * kernel, the tessellator and the lines each make an instance of their
 * own, so that each has its memory and lifecycle apart. It needs wasm
 * SIMD throughout; this throws where the host refuses to compile it, as
 * without SIMD or Wasm or under a CSP, and each user then keeps to JS.
 */
export function renderModule(): WebAssembly.Module {
  module ??= new WebAssembly.Module(Uint8Array.from(atob(binary), (c) => c.charCodeAt(0)));
  return module;
}

/** Whether the module has compiled: a call that threw before it did means it never will. */
export function renderCompiled(): boolean {
  return module !== null;
}

/**
 * What an instance imports: libtess2's longjmp, which `failure` must
 * throw from, and the host's own sine and cosine, which the lines take so
 * that theirs are the player's JS's to the last bit.
 */
function renderImports(failure: () => never): object {
  return { env: { failure, sine: Math.sin, cosine: Math.cos } };
}

/** An instance of the module, its memory its own. */
export function renderInstance(failure: () => never): Record<string, unknown> {
  return new WebAssembly.Instance(renderModule(), renderImports(failure)).exports;
}
