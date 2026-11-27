// Compactions that happen: a domain whose children each take the builtin
// library, compiled and then dropped or evicted until enough dead weight
// builds up for the rebuild policy (pinned where the reference can pin
// it, run.ts) to answer yes, as the host asks it (Codegen.compact in
// packages/codegen/src/index.ts): a move to a fresh instance where one is
// due, else a compaction in place, a part at a time. After each, every
// live ABC's module and context, the usage and the summary; evicted
// domains revived, with their ABCs restored where a rebuild let them go.
// Other suites compact rarely or never: their domains never hold enough
// dead weight for the policy to say yes.
import { builtinLibrary } from "../../../packages/player/dist/playerglobal/libraries.js";
import { structuredAbcs } from "../../fuzz/bodies.ts";
import type { Compiler, Results } from "../suite.ts";
import { count, type FuzzOptions, generator, type Live, sha } from "./common.ts";

/** What wantsRebuild is asked (lifetime.zig's Want, index.ts's WANT_*). */
const WANT_InPlace = 0;
const WANT_InPlaceBesideSpare = 1;
const WANT_Move = 2;

/** The bytes call `address` handed out, copied. */
const handed = (c: Compiler, address: number) =>
  new Uint8Array(c.memory.buffer, address >>> 0, c.outputLength()).slice();

/** A rebuild the domain started, stepped to its end: its last answer and how many steps. */
function stepped(c: Compiler): string {
  let steps = 0;
  let step = 0;
  do {
    step = c.domainRebuildStep();
    steps++;
  } while (step === 0 && steps < 100_000);

  return `${step} after ${steps}`;
}

/** An ABC added, by index, and its application domain. */
interface Added {
  bytes: Uint8Array;
  domain: number;
}

/** What a compaction must leave as it was: every live ABC's module and context, the usage and the summary. */
function state(c: Compiler, added: Added[]): string {
  const lines = [`usage ${c.domainUsage().split(" ").slice(0, 2).join(" ")}`, c.domainSummary()];
  for (const [i, abc] of added.entries()) {
    if (c.domainState(abc.domain) === 0) {
      lines.push(
        `abc ${i}: module ${sha(new TextEncoder().encode(c.domainModule("", i, false)))} context ${sha(new TextEncoder().encode(c.domainContext(i, 0, -1)))}`,
      );
    }
  }

  return lines.join("\n");
}

export async function compactions(live: Live, r: Results, o: FuzzOptions): Promise<void> {
  const { below } = generator(o.seed);
  // ABCs that link after the builtin library alone, and that a revival can restore.
  const seeds = structuredAbcs(60, o.seed);
  const totals = { inPlace: 0, moves: 0, revivals: 0, restored: 0 };
  // --cases sets the steps of a sequence, not how many sequences there are.
  const sequences = o.deep ? 8 : 4;
  for (let s = 0; s < sequences; s++) {
    const added: Added[] = [];
    const add = (name: string, bytes: Uint8Array, builtin: boolean, domain: number) => {
      r.case(name, () => {
        const error = live.c.domainAdd(bytes, builtin, domain);
        if (error === 0) {
          added.push({ bytes, domain });
        }

        return error;
      });
    };
    r.case(`sequence ${s}: reset`, () => {
      live.c.domainReset(50);
      return "done";
    });
    add(`sequence ${s}: builtin`, builtinLibrary, true, 0);
    const main = live.c.domainChild(0);
    for (let k = 0; k < 4; k++) {
      add(`sequence ${s}: seed ${k} into the main domain`, seeds[below(seeds.length)], false, main);
    }

    // Evicted domains, and the step each was evicted at; the step of the last compaction.
    const evicted: [number, number][] = [];
    let compacted = -1;
    // Steps between the host's compactions: dead weight builds up over more.
    const gap = 1 + below(5);
    const steps = count(o, 60, 80);
    for (let step = 0; step < steps; step++) {
      const name = `sequence ${s} step ${step}`;
      const c = live.c;
      const child = c.domainChild(below(4) === 0 ? 0 : main);
      // A domain to evict takes ABCs a revival can give back; the others
      // the builtin library too, the dead weight that makes a compaction due.
      const fate = below(4);
      if (fate !== 2) {
        add(`${name}: builtin into ${child}`, builtinLibrary, true, child);
      }

      for (let k = fate === 2 ? 3 : 1; k > 0; k--) {
        add(`${name}: a seed into ${child}`, seeds[below(seeds.length)], false, child);
      }

      await live.case(r, `${name}: module`, (t) =>
        sha(new TextEncoder().encode(t.domainModule("", -1, false))),
      );
      switch (fate) {
        case 0:
        case 1:
          r.case(`${name}: drop ${child}`, () => {
            live.c.domainDrop(child);
            return "done";
          });
          break;
        case 2:
          r.case(`${name}: evict ${child}`, () => {
            live.c.domainEvict(child);
            return "done";
          });
          evicted.push([child, step]);
          break;
        default:
          break;
      }

      // An evicted domain revived as the host revives one: its ABCs given
      // back where a rebuild let them go, and the rebuild that links them.
      // Mostly one evicted before the last compaction, which let its ABCs go.
      const before = evicted.filter(([, at]) => at < compacted);
      const pool = before.length > 0 && below(4) !== 0 ? before : evicted;
      if (pool.length > 0 && below(3) === 0) {
        const pick = pool[below(pool.length)];
        evicted.splice(evicted.indexOf(pick), 1);
        const d = pick[0];
        await live.case(r, `${name}: revive ${d}`, (t) => {
          let revived = t.domainRevive(d, true);
          let restores = 0;
          if (revived < 0) {
            for (const [i, abc] of added.entries()) {
              if (abc.domain === d && t.domainRestore(i, abc.bytes) === 0) {
                restores++;
              }
            }

            totals.restored += restores;
            revived = t.domainRevive(d, true);
          }

          const rebuilt = revived > 0 ? stepped(t) : "none";
          if (revived > 0) {
            totals.revivals++;
          }

          return `revived ${revived} restores ${restores} rebuild ${rebuilt}\n${state(t, added)}`;
        });
      }

      if (step % gap !== 0) {
        continue;
      }

      // The host's compaction: a move where one is due, else in place; beside
      // a spare in every other sequence, where a move that would take less
      // memory waits for one rather than compacting in place.
      const move = live.c.domainWantsCompact(WANT_Move);
      const inPlace =
        !move && live.c.domainWantsCompact(s % 2 === 1 ? WANT_InPlaceBesideSpare : WANT_InPlace);
      r.case(`${name}: wants`, () => `move ${move} in place ${inPlace}`);
      if (move) {
        const from = live.c;
        const into = await live.fresh();
        await live.case(r, `${name}: move`, () => {
          const words = handed(from, from.domainSaveBytes());
          let text = `load ${into.domainLoad(words)}`;
          for (let i = 0; i < added.length; i++) {
            const at = from.domainSavedAbcBytes(i);
            if (at !== 0) {
              text += ` ${i}:${into.domainLoadAbc(i, handed(from, at))}`;
            }
          }

          text += ` rebuild ${into.domainLoadRebuild()} ${stepped(into)}`;
          return `${text}\n${state(into, added)}`;
        });
        live.c = into;
        totals.moves++;
        compacted = step;
      } else if (inPlace) {
        let done = false;
        await live.case(r, `${name}: compact in place`, (t) => {
          const started = t.domainCompact(true);
          const rebuilt = started ? stepped(t) : "none";
          done = rebuilt.startsWith("1 ");
          return `compact ${started} ${rebuilt}\n${state(t, added)}`;
        });
        if (done) {
          totals.inPlace++;
          compacted = step;
        }
      }
    }
  }

  r.input(
    `${totals.inPlace} compactions in place, ${totals.moves} moves, ${totals.revivals} revivals with a rebuild, ${totals.restored} ABCs restored`,
  );
  if (totals.inPlace === 0 || totals.moves === 0) {
    r.problems.push(
      `${totals.inPlace} compactions in place and ${totals.moves} moves: the suite needs both to hold the rebuild to its reference`,
    );
  }
}
