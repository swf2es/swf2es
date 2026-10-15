// The site's demo SWFs, each built here from the repository's own sources,
// so each is as redistributable as the rest of it: an ActionScript 3 SWF
// from demos/Bounce.as, compiled by ASC in the oracle's image as the
// player's tests compile theirs; an ActionScript 1 SWF whose actions the
// tests' AVM1 compiler writes; and a busy timeline with no scripts, the
// one the player's benchmark plays.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flashAssembler, script } from "../../tests/avm1-script.ts";
import { compileScripts } from "../../tests/player/scripts.ts";
import * as w from "../../tests/swf-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

export interface Demo {
  /** Its file under demos/, and what ?swf= names. */
  file: string;
  title: string;
  description: string;
  /** The file it is made from, by its path in the repository. */
  source: string;
  bytes: Uint8Array;
}

function bounce(out: string): Demo {
  const abc = compileScripts(
    [{ name: "Bounce", source: readFileSync(`${here}demos/Bounce.as`, "utf8") }],
    out,
  ).get("Bounce") as Uint8Array;
  const bytes = w.swf({
    width: 480,
    height: 320,
    frameRate: 30,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0x0c1321),
      w.doAbc(abc, "Bounce"),
      w.symbolClass([[0, "Bounce"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  return {
    file: "bounce.swf",
    title: "Bounce (ActionScript 3)",
    description:
      "Gradients, glow filters and additive blending; click to add balls, space pauses, E throws an error.",
    source: "apps/site/demos/Bounce.as",
    bytes,
  };
}

/** A square of `size` twips about its centre, in `color`. */
function square(id: number, color: number, size: number): Uint8Array {
  const h = size / 2;
  return w.shape({
    id,
    bounds: [-h, h, -h, h],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [-h, -h] },
          { line: [h, -h] },
          { line: [h, h] },
          { line: [-h, h] },
          { line: [-h, -h] },
        ],
      },
    ],
  });
}

// Frame 1's actions run again each time the timeline loops back to it: once is enough.
const AVM1_FIRST_FRAME = `
if (!started) {
  started = true;
  trace("Hello from ActionScript 1 and 2 (AVM1), compiled to JavaScript by swf2es.");
  function Vec(x, y) { this.x = x; this.y = y; }
  Vec.prototype.size = function () { return Math.sqrt(this.x * this.x + this.y * this.y); };
  Vec.prototype.toString = function () { return "(" + this.x + ", " + this.y + ")"; };
  var v = new Vec(3, 4);
  trace("v = " + v + ", its length " + v.size());
  var primes = [];
  for (var n = 2; primes.length < 12; n++) {
    var prime = true;
    for (var d = 2; d * d <= n; d++) {
      if (n % d == 0) { prime = false; break; }
    }
    if (prime) { primes.push(n); }
  }
  trace("Primes: " + primes.join(" "));
  var words = "the quick brown fox jumps over the lazy dog".split(" ");
  words.sort();
  trace("Sorted: " + words.join(", "));
  trace("0.1 + 0.2 = " + (0.1 + 0.2) + ", 1 / 3 = " + 1 / 3 + ", 2^0.5 = " + Math.pow(2, 0.5));
  var day = new Date(2000, 0, 1);
  trace("1 January 2000 was day " + day.getDay() + " of the week");
  loops = 0;
}
`;

const AVM1_LAST_FRAME = `
loops += 1;
if (loops <= 3) { trace("The timeline looped " + loops + (loops == 1 ? " time" : " times")); }
if (loops == 3) { trace("(it loops on, quietly)"); }
`;

/** Squares turning about the stage's centre on the timeline, its first and last frames' actions in AS1. */
function orbit(): Demo {
  const version = 8;
  const actions = (source: string) =>
    w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);
  const frames = 72;
  const colors = [0xff5a5f, 0xffb400, 0x2ec4b6, 0x3a86ff, 0xc77dff, 0x8ac926];
  const [cx, cy] = [240 * 20, 160 * 20];
  const placed = (frame: number, i: number, move: boolean) => {
    const angle = (2 * Math.PI * (frame / frames + i / colors.length)) % (2 * Math.PI);
    const radius = (90 + 30 * Math.sin((4 * Math.PI * frame) / frames)) * 20;
    const turn = 2 * angle;
    return w.place({
      depth: i + 1,
      ...(move ? { move: true } : { character: i + 1 }),
      matrix: {
        a: Math.cos(turn),
        b: Math.sin(turn),
        c: -Math.sin(turn),
        d: Math.cos(turn),
        tx: Math.round(cx + radius * Math.cos(angle)),
        ty: Math.round(cy + radius * Math.sin(angle)),
      },
    });
  };
  const tags: Uint8Array[] = [
    w.backgroundColor(0xf4f1ea),
    ...colors.map((color, i) => square(i + 1, color, 40 * 20)),
    ...colors.map((_, i) => placed(0, i, false)),
    actions(AVM1_FIRST_FRAME),
    w.showFrame(),
  ];
  for (let frame = 1; frame < frames; frame++) {
    tags.push(...colors.map((_, i) => placed(frame, i, true)));
    if (frame === frames - 1) {
      tags.push(actions(AVM1_LAST_FRAME));
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return {
    file: "orbit.swf",
    title: "Orbit (ActionScript 1 and 2)",
    description:
      "A SWF 8 timeline whose frame actions trace objects, prototypes, arrays, strings, Math and Date.",
    source: "apps/site/demos.ts",
    bytes: w.swf({ version, width: 480, height: 320, frameRate: 30, frameCount: frames, tags }),
  };
}

/** The player benchmark's crowd: animated characters of outlined parts, placed and moved by the timeline. */
function crowd(out: string): Demo {
  const file = `${out}crowd.swf`;
  execFileSync(
    process.execPath,
    [`${root}tests/player/bench.ts`, "--rig", "24", "--write-swf", file],
    { stdio: "inherit" },
  );
  return {
    file: "crowd.swf",
    title: "Crowd (timeline only)",
    description:
      "The player benchmark's crowd: 24 characters of 12 outlined parts each, no ActionScript.",
    source: "tests/player/bench.ts",
    bytes: new Uint8Array(readFileSync(file)),
  };
}

/** Every demo, built under `out`, a scratch directory. */
export function buildDemos(out: string): Demo[] {
  mkdirSync(out, { recursive: true });
  return [bounce(out), orbit(), crowd(out)];
}
