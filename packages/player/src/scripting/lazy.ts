// Deferred entries keep their module's bindings and code context.
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../scripting.js";

export type MethodFactory = (...args: unknown[]) => avm2.Method;
export type LazyCompiler = (body: number, bindings: unknown[]) => MethodFactory;

// Entries that never read A still need their originating ABC for caller URL checks.
const methodAbcs = new WeakMap<avm2.Method, unknown>();

/** The entry builder given to one lazy module, bound to its compiler epoch and domain. */
export function methodCompiler(
  s: Scripting,
  index: number,
  domain: avm2.Domain,
  script: string,
  epoch: number | undefined,
): LazyCompiler {
  return (body, bindings) => {
    if (s.codegen.epoch !== epoch) {
      throw new Error("the compiler was reset before a deferred method was compiled");
    }

    const source = s.codegen.compileMethods([body], index).get(body);
    if (source === undefined) {
      throw new Error(`a deferred method has no compiled entry: ${body}`);
    }

    const build = new Function(
      "rt",
      "nn",
      "ac",
      "ns",
      "cls",
      "N",
      "S",
      "M",
      "V",
      "F",
      "A",
      `"use strict"; return ${source}\n//# sourceURL=${script}/$f${body}.js\n`,
    );
    const factory = s.rt.loadInto(domain, () => build(...bindings) as MethodFactory);
    return (...args) => {
      const method = factory(...args);
      methodAbcs.set(method, bindings[10]);
      return method;
    };
  };
}

/** Deferred entries need both Function construction and identifiable stack frames. */
export function supportsLazyCompilation(): boolean {
  if (lazySupported === undefined) {
    try {
      const script = "swf2es-lazy-probe.js";
      const stack = new Function(`return new Error().stack\n//# sourceURL=${script}\n`)();
      lazySupported = avm2.frameScripts(stack).includes(script);
    } catch {
      lazySupported = false;
    }
  }

  return lazySupported;
}

let lazySupported: boolean | undefined;
