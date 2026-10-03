// The compiler as a test host keeps it for one runtime: one domain of the
// compiler's for all the ABCs the runtime loads, each in the application
// domain the runtime loads it into, so that an ABC Domain.loadBytes loads
// compiles against what its domain sees, a sibling's ABCs left out.
import { createHash } from "node:crypto";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** RuntimeOptions.compileAbc's unit, as the runtime describes it. */
export interface CompileUnit {
  linked: string[];
  domains: number[];
  found: {
    nsKind: number;
    uri: string;
    name: string;
    domain: number;
    index: number;
    hash: string;
    asType: boolean;
  }[];
}

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export function abcCompiler(testing: any) {
  // The compiler's number for each of the runtime's domains, and the
  // compiler's index of each ABC loaded into one, in load order.
  let domains = new Map<number, number>([[0, 0]]);
  let abcs = new Map<number, number[]>([[0, []]]);
  let added = 0;
  // The findings each domain has been told, reported once.
  let reported = new Map<number, Set<string>>();
  // Every ABC's hash, in load order, as the compiler names a module's.
  let hashes: string[] = [];
  let evaluated = 0;

  /** Add an ABC to the runtime's domain `domain`: 0, or the VerifyError it was rejected with. */
  const add = (bytes: Uint8Array, builtin: boolean, domain = 0): number => {
    const error = testing.domainAdd(bytes, builtin, domains.get(domain));
    if (!error) {
      abcs.get(domain)?.push(added++);
      hashes.push(sha(bytes));
    }

    return error;
  };

  return {
    /** Add an ABC to the root domain, as a host loads its builtins and its main ABC. */
    add: (bytes: Uint8Array, builtin: boolean): number => add(bytes, builtin),
    /** The hashes of the ABCs added, as domainModule takes them. */
    linked: (): string => hashes.join("\n"),
    reset(): void {
      testing.domainReset(50);
      domains = new Map([[0, 0]]);
      abcs = new Map([[0, []]]);
      reported = new Map();
      added = 0;
      hashes = [];
    },
    /** RuntimeOptions.compileAbc: `bytes` compiled into the unit's domain, evaluated at once. */
    compileAbc(bytes: Uint8Array, unit: CompileUnit): ((rt: unknown) => unknown) | number {
      for (let i = unit.domains.length - 2; i >= 0; i--) {
        const id = unit.domains[i];
        if (!domains.has(id)) {
          domains.set(id, testing.domainChild(domains.get(unit.domains[i + 1])));
          abcs.set(id, []);
        }
      }

      const domain = unit.domains[0];
      const told = reported.get(domain) ?? new Set<string>();
      reported.set(domain, told);
      for (const f of unit.found) {
        const key = JSON.stringify([f.asType, f.nsKind, f.uri, f.name, f.domain, f.index]);
        const abc = abcs.get(f.domain)?.[f.index];
        if (abc !== undefined && !told.has(key)) {
          told.add(key);
          testing.domainFound(domains.get(domain), f.nsKind, f.uri, f.name, abc, f.asType);
        }
      }

      const error = add(bytes, false, domain);
      if (error) {
        return error;
      }

      // A script of its own, by which Runtime.codeDomain finds its frames.
      const js: string = testing.domainModule(hashes.join("\n"));
      const script = `${js.replace(/^export default /, "return ")}//# sourceURL=loaded-${evaluated++}.js\n`;
      return new Function(script)();
    },
  };
}
