// Compactions that happen: a domain whose children each take the builtin
// library, compiled and then dropped or evicted until enough dead weight
// builds up for a compaction, done as the host does it
// (packages/codegen/src/index.ts): a move to a fresh instance (saved,
// loaded, rebuilt a part at a time, and taken only if all of that
// succeeded, as moved() takes it), or a compaction in place a part at a
// time, the domain saved first as rebuild()'s checkpoint saves it. After
// each, every live ABC's module and context, the usage and the summary;
// evicted domains revived, mostly ones a compaction let go of, with their
// ABCs restored and the rebuild that links them. Other suites compact
// rarely or never: their domains never hold enough dead weight.
//
// Two halves. In the first, the rebuild policy decides, as the host asks
// it: a move where one is due, else in place, beside a spare in every
// other sequence; it is pinned (run.ts) where the reference can pin it, so
// that its answers follow the weights, not memory's layout, and is the
// real one against a reference that cannot. A change to the policy on
// purpose diverges here at the first `wants` line whose answer it changes,
// and from there on. In the second half a schedule decides, moves and
// compactions in place in turn whatever the policy answers, which is still
// recorded: a policy change diverges only on those lines, and the rebuild
// stays held to the reference past them.
import { builtinLibrary } from "../../../packages/player/dist/playerglobal/libraries.js";
import { structuredAbcs } from "../../fuzz/bodies.ts";
import type { Compiler, Results } from "../suite.ts";
import { count, type FuzzOptions, generator, type Live, sha } from "./common.ts";

/** What wantsRebuild is asked (lifetime.zig's Want, index.ts's WANT_*). */
const WANT_InPlace = 0;
const WANT_InPlaceBesideSpare = 1;
const WANT_Move = 2;
const WANT_Spare = 3;

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

/** The checkpoint the host saves before a rebuild's first step: the domain's save and its live ABCs' bytes, as digests. */
function checkpoint(c: Compiler, added: number): string {
  const save = sha(handed(c, c.domainSaveBytes()));
  const abcs: string[] = [];
  for (let i = 0; i < added; i++) {
    const at = c.domainSavedAbcBytes(i);
    if (at !== 0) {
      abcs.push(`${i}:${sha(handed(c, at)).slice(0, 16)}`);
    }
  }

  return `save ${save.slice(0, 16)} abcs ${abcs.join(",")}`;
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
  // By the policy's half and the schedule's.
  const totals = { inPlace: [0, 0], moves: [0, 0], failedMoves: 0, revivals: 0, restored: 0 };
  // --cases sets the steps of a sequence, not how many sequences there are.
  const sequences = o.deep ? 12 : 6;
  for (let s = 0; s < sequences; s++) {
    // The first two thirds of the sequences the policy's, the last third the schedule's.
    const scheduled = s >= (sequences * 2) / 3 ? 1 : 0;
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

          // The host saves its checkpoint before the rebuild's first step.
          const saved = revived > 0 ? checkpoint(t, added.length) : "";
          const rebuilt = revived > 0 ? stepped(t) : "none";
          if (rebuilt.startsWith("1 ")) {
            totals.revivals++;
          }

          return `revived ${revived} restores ${restores} ${saved} rebuild ${rebuilt}\n${state(t, added)}`;
        });
      }

      if (step % gap !== 0) {
        continue;
      }

      // The policy's answers, recorded in both halves. In the first, the
      // host's compaction: a move where one is due, else in place; beside a
      // spare in every other sequence, where a move that would take less
      // memory waits for one rather than compacting in place. In the
      // second, moves and compactions in place in turn.
      const asked = live.c;
      const wantsMove = asked.domainWantsCompact(WANT_Move);
      const wantsInPlace = asked.domainWantsCompact(
        s % 2 === 1 ? WANT_InPlaceBesideSpare : WANT_InPlace,
      );
      const wantsSpare = asked.domainWantsCompact(WANT_Spare);
      r.case(
        `${name}: wants`,
        () => `move ${wantsMove} in place ${wantsInPlace} spare ${wantsSpare}`,
      );
      const turn = Math.floor(step / gap) % 2 === 0;
      const move = scheduled ? turn : wantsMove;
      let inPlace = scheduled ? !turn : !wantsMove && wantsInPlace;
      if (move) {
        const from = live.c;
        const into = await live.fresh();
        let taken = false;
        await live.case(r, `${name}: move`, () => {
          const words = handed(from, from.domainSaveBytes());
          let loaded = into.domainLoad(words);
          let text = `save ${sha(words).slice(0, 16)} load ${loaded}`;
          for (let i = 0; i < added.length; i++) {
            const at = from.domainSavedAbcBytes(i);
            if (at !== 0) {
              const bytes = handed(from, at);
              const error = loaded ? into.domainLoadAbc(i, bytes) : -1;
              loaded = loaded && error === 0;
              text += ` ${i}:${sha(bytes).slice(0, 16)}:${error}`;
            }
          }

          const started = loaded && into.domainLoadRebuild();
          const rebuilt = started ? stepped(into) : "none";
          // Taken only if all of it succeeded, as moved() takes a move; else
          // the domain stays where it was, and compacts in place if it can.
          taken = rebuilt.startsWith("1 ");
          return `${text} rebuild ${started} ${rebuilt} taken ${taken}\n${state(taken ? into : from, added)}`;
        });
        if (taken) {
          live.c = into;
          totals.moves[scheduled]++;
          compacted = step;
        } else {
          totals.failedMoves++;
          inPlace = scheduled ? true : live.c.domainWantsCompact(WANT_InPlace);
        }
      }

      if (inPlace) {
        let done = false;
        await live.case(r, `${name}: compact in place`, (t) => {
          const started = scheduled ? t.domainRebuild(true) : t.domainCompact(true);
          // The host saves its checkpoint before the rebuild's first step.
          const saved = started ? checkpoint(t, added.length) : "";
          const rebuilt = started ? stepped(t) : "none";
          done = rebuilt.startsWith("1 ");
          return `compact ${started} ${saved} ${rebuilt}\n${state(t, added)}`;
        });
        if (done) {
          totals.inPlace[scheduled]++;
          compacted = step;
        }
      }
    }
  }

  r.input(
    `by the policy ${totals.inPlace[0]} compactions in place and ${totals.moves[0]} moves, by the schedule ${totals.inPlace[1]} and ${totals.moves[1]}, ${totals.failedMoves} moves not taken, ${totals.revivals} revivals with a rebuild, ${totals.restored} ABCs restored`,
  );
  if (totals.inPlace[0] === 0 || totals.moves[0] === 0) {
    r.problems.push(
      `the policy made ${totals.inPlace[0]} compactions in place and ${totals.moves[0]} moves: the suite needs both to hold its rebuilds to the reference`,
    );
  }
}
