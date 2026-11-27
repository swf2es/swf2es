// The oracle's compiled tests, from a review of the idiomatic pass: each ABC
// in its cache linked after the libraries (float's with every third, API
// version 12 for every fifth), verified, compiled, and every body's whole
// IR dumped.
import type { Results } from "../suite.ts";
import {
  builtin,
  count,
  type FuzzOptions,
  float,
  hashes,
  type Live,
  oracleAll,
  shell,
} from "./common.ts";

export async function oracleIr(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const abcs = oracleAll(120000, count(o, 3000, 3000));
  r.input(`${abcs.length} of the oracle's ABCs`);
  for (const [i, [name, bytes]] of abcs.entries()) {
    const n = i + 1;
    const libraries = n % 3 === 0 ? [builtin, shell, float] : [builtin, shell];
    await live.case(r, `oracle ${name}`, (t) => {
      t.domainReset(n % 5 === 0 ? 12 : 50);
      for (const library of libraries) {
        t.domainAdd(library, true);
      }

      const added = t.domainAdd(bytes, false);
      let text = `add ${added}`;
      if (added === 0) {
        text += `\n${t.domainVerifyAll()}\n${t.domainModule(hashes(libraries, bytes))}\n${t.domainIrAll()}`;
      }

      return text;
    });
  }
}
