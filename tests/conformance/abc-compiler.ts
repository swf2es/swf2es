// The compiler's domain as a test host keeps it: the ABCs it holds, in
// order, and each one's bytes by hash, so that an ABC Domain.loadBytes
// loads can be compiled after the ABCs its runtime domain names, which may
// be another domain's than those the compiler holds now: a sibling's.
import { createHash } from "node:crypto";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export function abcCompiler(testing: any) {
  const known = new Map<string, { bytes: Uint8Array; builtin: boolean }>();
  let held: string[] = [];
  let evaluated = 0;

  /** Add an ABC after those held: 0, or the VerifyError it was rejected with. */
  const add = (bytes: Uint8Array, builtin: boolean): number => {
    const error = testing.domainAdd(bytes, builtin);
    if (!error) {
      const hash = sha(bytes);
      known.set(hash, { bytes, builtin });
      held.push(hash);
    }

    return error;
  };

  return {
    add,
    /** The hashes of the ABCs held, as a module names those it is compiled after. */
    linked: (): string => held.join("\n"),
    reset(): void {
      testing.domainReset(50);
      held = [];
    },
    /** RuntimeOptions.compileAbc: `bytes` compiled after the ABCs `linked` names, evaluated at once. */
    compileAbc(bytes: Uint8Array, linked: string[]): ((rt: unknown) => unknown) | number {
      if (linked.length !== held.length || linked.some((h, i) => h !== held[i])) {
        this.reset();
        for (const hash of linked) {
          const abc = known.get(hash);
          if (!abc) {
            throw new Error(`no ABC of hash ${hash} to compile after`);
          }

          add(abc.bytes, abc.builtin);
        }
      }

      const error = add(bytes, false);
      if (error) {
        return error;
      }

      // A script of its own, by which Runtime.codeDomain finds its frames.
      const js: string = testing.domainModule(held.join("\n"));
      const script = `${js.replace(/^export default /, "return ")}//# sourceURL=loaded-${evaluated++}.js\n`;
      return new Function(script)();
    },
  };
}
