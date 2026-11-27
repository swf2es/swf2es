// Traits' names, from a review of the idiomatic pass (which found #1227's
// crash): two classes and a script whose slots, constants, methods,
// getters and setters often share a name, in their own namespaces or
// overriding; each linked case resolved, verified, compiled and dumped,
// with its traits.
import {
  abc,
  type Body,
  type Method,
  type Pool,
  type Trait,
  tables,
} from "../../unit/codegen/abc-builder.ts";
import type { Results } from "../suite.ts";
import { builtin, count, type FuzzOptions, generator, type Live, sha } from "./common.ts";

// Multinames: 1 Object, 2 A, 3 B, 4 m, 5 n, 6 p, 7 int, 8 String.
const pool: Pool = {
  ints: [7],
  strings: ["", "Object", "A", "B", "m", "n", "p", "int", "String"],
  namespaces: [[0x16, 1]],
  multinames: [
    [7, 1, 2],
    [7, 1, 3],
    [7, 1, 4],
    [7, 1, 5],
    [7, 1, 6],
    [7, 1, 7],
    [7, 1, 8],
    [7, 1, 9],
  ],
};

// Slot, const, method, getter, setter.
const KINDS = [0, 6, 1, 2, 3];

export async function names(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { below } = generator(o.seed);
  const traitsOf = (methods: Method[], bodies: Body[], n: number): Trait[] => {
    const out: Trait[] = [];
    for (let i = 0; i < n; i++) {
      const name = 4 + below(2);
      const kind = KINDS[below(KINDS.length)];
      if (kind === 0 || kind === 6) {
        out.push({
          name,
          kind,
          id: below(3) === 0 ? 1 + below(4) : 0,
          index: [0, 7, 8, 1][below(4)],
          ...(below(3) === 0 ? { value: 1, valueKind: 0x03 } : {}),
        });
      } else {
        const m = methods.length;
        methods.push(kind === 3 ? { params: [0] } : {});
        bodies.push({
          method: m,
          code: kind === 3 ? [0x47] : [0x24, 42, 0x48],
          maxStack: 1,
          localCount: kind === 3 ? 2 : 1,
        });
        out.push({
          name,
          kind,
          index: m,
          id: below(4) === 0 ? below(3) : 0,
          attr: below(4) === 0 ? 0x20 : below(8) === 0 ? 0x10 : 0,
        });
      }
    }

    return out;
  };
  const build = (): Uint8Array => {
    const init = [0xd0, 0x30, 0x47];
    // The script's initializer, A's and B's instance and class initializers.
    const methods: Method[] = [{}, {}, {}, {}, {}];
    const bodies: Body[] = [0, 1, 2, 3, 4].map((m) => ({
      method: m,
      code: init,
      maxStack: 1,
      localCount: 1,
      maxScopeDepth: 1,
    }));
    const a = {
      instance: { name: 2, base: 1, init: 1, traits: traitsOf(methods, bodies, below(5)) },
      init: 2,
      traits: traitsOf(methods, bodies, below(4)),
    };
    const b = {
      instance: { name: 3, base: 2, init: 3, traits: traitsOf(methods, bodies, below(5)) },
      init: 4,
      traits: traitsOf(methods, bodies, below(3)),
    };
    const script = [
      ...traitsOf(methods, bodies, below(4)),
      { name: 2, kind: 4, index: 0 },
      { name: 3, kind: 4, index: 1 },
    ];
    return abc(
      pool,
      tables({ methods, classes: [a, b], scripts: [{ init: 0, traits: script }], bodies }),
    );
  };
  const total = count(o, 3000, 3000);
  for (let c = 0; c < total; c++) {
    const bytes = build();
    await live.case(r, `names ${c}`, (t) => {
      t.domainReset(50);
      t.domainAdd(builtin, true);
      const added = t.domainAdd(bytes, false);
      let text = `add ${added}\n${t.domainSummary()}`;
      if (added === 0) {
        text += `\nresolve ${t.domainResolve(0)}\n${t.domainVerifyAll()}\n${t.domainModule([sha(builtin), sha(bytes)].join("\n"))}\n${t.domainIrAll()}\n${t.domainTraits(0)}`;
      }

      return text;
    });
  }
}
