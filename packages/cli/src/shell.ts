// avmshell's way of running ABCs, in node: the libraries it loads (builtin
// and shell_toplevel), their scripts run on first use, then each ABC given,
// added to the same domain and its entry point run, until one throws. One
// compiler domain serves the one runtime, each ABC compiled in the
// application domain the runtime loads it into, so that an ABC
// Domain.loadBytes loads compiles against what its domain sees, a
// sibling's ABCs left out.
import { createHash } from "node:crypto";
import { API_VERSION, type Codegen } from "@swf2es/codegen";
import type {
  Abc,
  CompileUnit,
  Runtime,
  RuntimeOptions,
  ShellFiles,
  ShellWorkerHost,
  ShellWorkerInit,
  Value,
} from "@swf2es/runtime/avm2";
import { floatLibrary, hasFloatLibrary } from "@swf2es/runtime/avm2";
import { RejectedError } from "./aot.js";

/** What the shell needs of a compiler: a Codegen, or a build of it for tests. */
export type ShellCompiler = Pick<
  Codegen,
  "reset" | "add" | "childDomain" | "found" | "compileModule"
>;

/** A module the compiler wrote, loaded: run with a runtime, it gives the ABC. */
export type ShellModule = (rt: Runtime) => Abc;

export interface ShellLibrary {
  name: string;
  abc: Uint8Array;
  /** Its module, compiled before for the same libraries before it: linked again but not compiled. */
  module?: ShellModule;
}

export interface ShellOptions {
  compiler: ShellCompiler;
  /** The runtime's createRuntime, or another build's. */
  createRuntime: (options: RuntimeOptions) => Runtime;
  /** Where trace and print write a line. */
  print: (line: string) => void;
  /** Where avmshell's File reads and writes; the runtime keeps them in memory by default. */
  files?: ShellFiles;
  /**
   * Load a module the compiler has just written, `name` naming its script
   * (which Runtime.codeDomain tells domains by); by default evaluated as a
   * script of its own.
   */
  load?: (js: string, name: string) => ShellModule | Promise<ShellModule>;
  /** What starts the background workers' threads (RuntimeOptions.workers), as nodeShellThreads does. */
  workers?: ShellWorkerHost;
  /** The background worker these ABCs run as, in the thread its host started (RuntimeOptions.worker). */
  worker?: ShellWorkerInit;
  /**
   * The ABCs' API version, as avmshell's -api gives it, whose series is
   * the run's: Flash Player's latest, 50, by default.
   */
  apiVersion?: number;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A module's source as a script of its own: its default export returned, `name` its sourceURL. */
export function evaluateModule(js: string, name: string): ShellModule {
  // Strict, as a module is: a sloppy function boxes a primitive `this`, such
  // as the string a String method is called on.
  const script = `"use strict";${js.replace(/^export default /, "return ")}//# sourceURL=${name}\n`;
  return new Function(script)();
}

/**
 * The compiler for one runtime: the libraries and ABCs added to the root
 * domain, and RuntimeOptions.compileAbc for those Domain.loadBytes loads.
 */
export function shellDomain(compiler: ShellCompiler, apiVersion = API_VERSION) {
  // The compiler's number for each of the runtime's domains, and the
  // compiler's index of each ABC loaded into one, in load order.
  const domains = new Map<number, number>([[0, 0]]);
  const abcs = new Map<number, number[]>([[0, []]]);
  // The findings each domain has been told, reported once.
  const reported = new Map<number, Set<string>>();
  // Every ABC's hash, in load order, as the compiler names a module's.
  const hashes: string[] = [];
  let added = 0;
  let evaluated = 0;

  compiler.reset(apiVersion);

  /** Add an ABC to the runtime's domain `domain`: 0, or the VerifyError it was rejected with. */
  const add = (bytes: Uint8Array, builtin: boolean, domain = 0): number => {
    const error = compiler.add(bytes, builtin, domains.get(domain));
    if (!error) {
      abcs.get(domain)?.push(added++);
      hashes.push(sha256(bytes));
    }

    return error;
  };

  return {
    /** Add an ABC to the root domain, as avmshell loads its libraries and the ABCs it runs. */
    add: (bytes: Uint8Array, builtin: boolean): number => add(bytes, builtin),
    /** The module of the ABC added last. */
    compile: (): string => compiler.compileModule(hashes),
    /** RuntimeOptions.compileAbc: `bytes` compiled into the unit's domain, evaluated at once. */
    compileAbc(bytes: Uint8Array, unit: CompileUnit): ShellModule | number {
      for (let i = unit.domains.length - 2; i >= 0; i--) {
        const id = unit.domains[i];
        if (!domains.has(id)) {
          domains.set(id, compiler.childDomain(domains.get(unit.domains[i + 1]) ?? 0));
          abcs.set(id, []);
        }
      }

      const domain = unit.domains[0];
      const at = domains.get(domain) ?? 0;
      const told = reported.get(domain) ?? new Set<string>();
      reported.set(domain, told);
      for (const f of unit.found) {
        const key = JSON.stringify([f.asType, f.nsKind, f.uri, f.name, f.domain, f.index]);
        const abc = abcs.get(f.domain)?.[f.index];
        if (abc !== undefined && !told.has(key)) {
          told.add(key);
          const { nsKind, uri, name, asType } = f;
          compiler.found({ domain: at, nsKind, uri, name, abc, asType });
        }
      }

      const error = add(bytes, false, domain);
      if (error) {
        return error;
      }

      // A script of its own, by which Runtime.codeDomain finds its frames.
      return evaluateModule(compiler.compileModule(hashes), `loaded-${evaluated++}.js`);
    },
  };
}

/**
 * Run `abcs` after `libraries` as avmshell runs them, printing what they
 * trace: avmshell's exit status, 0, or 1 once an ABC is rejected, with
 * its VerifyError, or throws an exception nothing catches, printed as its
 * string; the ABCs after it do not run. A library's rejection throws a
 * RejectedError, and an error of the host's, a JavaScript Error, is thrown.
 */
export async function runShell(
  libraries: ShellLibrary[],
  abcs: { name: string; abc: Uint8Array }[],
  options: ShellOptions,
): Promise<number> {
  if (
    abcs.some(
      ({ abc }) =>
        abc.length >= 4 && abc[2] === 47 && abc[3] === 0 && (abc[0] | (abc[1] << 8)) >= 16,
    ) &&
    !hasFloatLibrary(libraries.map((lib) => lib.abc))
  ) {
    libraries = [...libraries, { name: "float", abc: floatLibrary }];
  }

  const { print } = options;
  const load = options.load ?? evaluateModule;
  const apiVersion = options.apiVersion ?? API_VERSION;
  const domain = shellDomain(options.compiler, apiVersion);
  const rt = options.createRuntime({
    print,
    apiVersion,
    // Domain.loadBytes runs the ABC at once, so its module is evaluated, not imported.
    compileAbc: (bytes, unit) => domain.compileAbc(bytes, unit),
    ...(options.files ? { files: options.files } : {}),
    ...(options.workers ? { workers: options.workers } : {}),
    ...(options.worker ? { worker: options.worker } : {}),
  });

  for (const { name, abc, module } of libraries) {
    const error = domain.add(abc, true);
    if (error) {
      throw new RejectedError(`library ${name}`, error, true);
    }

    // The libraries' scripts run on first use, as avmshell's builtins do.
    (module ?? (await load(domain.compile(), `${name}.js`)))(rt);
  }

  for (const { name, abc } of abcs) {
    const error = domain.add(abc, false);
    if (error) {
      print(`VerifyError: Error #${error}`);
      return 1;
    }

    const loaded = (await load(domain.compile(), `${name}.js`))(rt);
    try {
      rt.run(loaded);
    } catch (e) {
      // An AS3 exception nothing caught: avmshell prints it, as its string, and exits with 1.
      if (e instanceof Error) {
        throw e;
      }

      print(rt.toString(e as Value));
      return 1;
    }
  }

  return 0;
}
