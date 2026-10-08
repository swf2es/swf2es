// How a module's source becomes its factory, under a script name of its
// own that its code's stack frames give, by which Runtime.codeDomain and
// Code.codeOrigin tell whose code runs.
import { avm2 } from "@swf2es/runtime";

type Value = avm2.Value;

/** A module's factory, as it exports it: given the runtime, it loads the module into it. */
export type Factory = (rt: avm2.Runtime) => Value;

/** A module's factory and the script its code's frames name. */
export interface Evaluated {
  factory: Factory;
  script: string;
}

const EXPORT = "export default ";

/**
 * A module's factory, its source evaluated by a strict Function under the
 * sourceURL `script`. Not imported: a document keeps every module it
 * imports for as long as it lives, so the code of a SWF long let go would
 * never be collected; a Function's goes once nothing refers to its
 * functions. A module is one exported function and nothing else, so it
 * runs the same returned from a strict Function, the names its code uses
 * its own function's variables (see Lazy compilation in
 * docs/architecture.md); its lines in a stack are its file's two further
 * on, after Function's header.
 */
export function evaluateFunction(module: string, script: string): Factory {
  return new Function(`"use strict"; return ${body(module)}//# sourceURL=${script}\n`)();
}

/**
 * A module's factory and the script its frames name: evaluated by a
 * Function under the sourceURL `script` where the engine's frames name a
 * Function's code by it, as V8's and SpiderMonkey's do; else, in a
 * document, as a classic script from a Blob URL of its own, which the
 * frames name. JavaScriptCore's frames name no script for a Function's
 * code, whatever its sourceURL, so that without a script, as in a Worker,
 * which has no document, or once one is refused, every SWF's code is
 * taken for the host's: its domain the main SWF's, for currentDomain, a
 * load's default domain and the rest. A classic script's code, unlike an
 * imported module's, goes with the SWF, as a Function's does. Only a
 * script waits, for its load.
 */
export function evaluate(module: string, script: string): Evaluated | Promise<Evaluated> {
  if (framesNameFunctions() || scripts === "refused" || typeof document === "undefined") {
    return { factory: evaluateFunction(module, script), script };
  }

  // Until one has run, one script at a time: a policy that refuses them
  // then reports one refusal, not one for each module of the first SWF.
  if (trial) {
    return trial.then(() => evaluate(module, script));
  }

  const evaluated = viaScript(module, script);
  if (scripts === "untried") {
    trial = evaluated.then(
      () => {
        trial = null;
      },
      () => {
        trial = null;
      },
    );
  }

  return evaluated;
}

/**
 * The module as a script, or, if the script did not run, by a Function:
 * its error, if it has one, is the source's, which a script would give
 * only to the page's onerror, and the scripts are left to be tried again;
 * if the Function evaluates, scripts are what failed (refused by a
 * Content-Security-Policy without blob: in script-src or by Trusted Types,
 * never loaded, or loaded but not run, as by a DOM that runs none), and
 * every module after is evaluated by a Function.
 */
async function viaScript(module: string, script: string): Promise<Evaluated> {
  const ran = await evaluateScript(module);
  if (ran) {
    scripts = "allowed";
    return ran;
  }

  const factory = evaluateFunction(module, script);
  scripts = "refused";
  return { factory, script };
}

function body(module: string): string {
  if (!module.startsWith(EXPORT)) {
    throw new Error("swf2es: a module that is not one exported function");
  }

  return module.slice(EXPORT.length);
}

const PROBE = "swf2es-probe.js";
let functionsNamed: boolean | undefined;

/**
 * Whether the engine's frames name a Function's code by its sourceURL,
 * asked of a Function once. One that cannot be made (a policy without
 * 'unsafe-eval') leaves the modules to be evaluated by Function, refused
 * as before, only imported ones loading.
 */
function framesNameFunctions(): boolean {
  if (functionsNamed === undefined) {
    try {
      const stack = new Function(
        `"use strict"; return new Error().stack\n//# sourceURL=${PROBE}\n`,
      )();
      functionsNamed = avm2.frameScripts(stack).includes(PROBE);
    } catch {
      functionsNamed = true;
    }
  }

  return functionsNamed;
}

/** Whether modules' scripts have run, or failed to where a Function did not. */
let scripts: "untried" | "allowed" | "refused" = "untried";
/** The first script while it settles, which the others wait for. */
let trial: Promise<void> | null = null;

/** The property of its script element a module's script leaves its factory on. */
const FACTORY = "swf2esFactory";

/** How long a module's script may take to load and run, from a Blob URL. */
const SCRIPT_TIMEOUT = 5000;

/**
 * A module's factory, its source evaluated as a classic script from a Blob
 * URL, and that URL; null if the script did not run: refused, as setting
 * its src may be (Trusted Types), failed, or not loaded in time, or loaded
 * without a factory, as a source that does not parse is. The element and
 * the URL are let go at once: the frames still name the URL, and nothing
 * else keeps the code but its functions.
 */
async function evaluateScript(module: string): Promise<Evaluated | null> {
  const source = `"use strict";document.currentScript.${FACTORY}=${body(module)}\n`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const script = document.createElement("script") as HTMLScriptElement & {
    [FACTORY]?: unknown;
  };
  let loaded: boolean;
  try {
    loaded = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), SCRIPT_TIMEOUT);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        done(ok);
      };
      script.onload = () => settle(true);
      script.onerror = () => settle(false);
      try {
        script.src = url;
        (document.head ?? document.documentElement).append(script);
      } catch {
        settle(false);
      }
    });
  } finally {
    script.remove();
    URL.revokeObjectURL(url);
  }

  const factory = script[FACTORY];
  return loaded && typeof factory === "function"
    ? { factory: factory as Factory, script: url }
    : null;
}
