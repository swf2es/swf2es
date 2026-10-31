import { decodeBase64 } from "../base64.js";
import { binary } from "./binary.js";

let module: WebAssembly.Module | null = null;

/**
 * The render module (root.zig), compiled once and shared: the bitmap
 * kernels, DXT encoder, tessellator and lines each make an instance of their
 * own, so that each has its memory and lifecycle apart. It needs wasm
 * SIMD throughout; this throws where the host refuses to compile it, as
 * without SIMD or Wasm or under a CSP without 'wasm-unsafe-eval'.
 */
export function renderModule(): WebAssembly.Module {
  module ??= new WebAssembly.Module(decodeBase64(binary));
  return module;
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
