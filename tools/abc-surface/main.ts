// Print an ABC's surface (see read.ts): by default how much of each class
// is native and how much AS3, or with --json the whole surface.
//
//   node tools/abc-surface/main.ts file.abc [--json] [--classes]

import { readFileSync } from "node:fs";
import { type Class, type Method, readSurface, type Surface, type Trait } from "./read.ts";

/** What a class's methods are: natives, AS3 bodies and their code bytes, declarations. */
interface Tally {
  native: number;
  as3: number;
  code: number;
  declared: number;
}

/** AS3 bodies by size: up to 8 code bytes (a field read or write), 32, 128, and more. */
const BOUNDS = [8, 32, 128];
const sizes = [0, 0, 0, 0];

function tally(t: Tally, m: Method): void {
  if (m.flags.includes("native")) {
    t.native++;
  } else if (m.code !== undefined) {
    t.as3++;
    t.code += m.code;
    const bucket = BOUNDS.findIndex((b) => m.code !== undefined && m.code <= b);
    sizes[bucket < 0 ? BOUNDS.length : bucket]++;
  } else {
    t.declared++;
  }
}

/** Each class, nested ones included, with the methods of its own traits. */
function classes(surface: Surface): [Class, Tally][] {
  const out: [Class, Tally][] = [];
  const visit = (c: Class) => {
    const t: Tally = { native: 0, as3: 0, code: 0, declared: 0 };
    out.push([c, t]);
    tally(t, c.init);
    tally(t, c.classInit);
    for (const trait of [...c.instance, ...c.static]) {
      member(trait, t);
    }
  };

  const member = (trait: Trait, t: Tally) => {
    switch (trait.kind) {
      case "class":
        visit(trait.class);
        break;
      case "function":
      case "method":
      case "getter":
      case "setter":
        tally(t, trait.method);
        break;
    }
  };

  for (const s of surface.scripts) {
    // A script's own functions and initializer count as a class of their own.
    const t: Tally = { native: 0, as3: 0, code: 0, declared: 0 };
    tally(t, s.init);
    const before = out.length;
    for (const trait of s.traits) {
      member(trait, t);
    }

    const named = s.traits.find((x) => x.kind === "class")?.name ?? s.traits[0]?.name ?? "?";
    out.splice(before, 0, [script(named), t]);
  }

  return out;
}

function script(name: string): Class {
  const none: Method = { params: [], returns: "*", flags: [] };
  return {
    name: `(script of ${name})`,
    super: null,
    flags: [],
    interfaces: [],
    init: none,
    instance: [],
    classInit: none,
    static: [],
  };
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node tools/abc-surface/main.ts file.abc [--json] [--classes]");
  process.exit(2);
}

const surface = readSurface(readFileSync(file));
if (args.includes("--json")) {
  console.log(JSON.stringify(surface, null, 1));
  process.exit(0);
}

const all = classes(surface);
const total: Tally = { native: 0, as3: 0, code: 0, declared: 0 };
const closures: Tally = { native: 0, as3: 0, code: 0, declared: 0 };
for (const m of surface.orphans) {
  tally(closures, m);
}

for (const [, t] of all) {
  total.native += t.native;
  total.as3 += t.as3;
  total.code += t.code;
  total.declared += t.declared;
}

const real = all.filter(([c]) => !c.name.startsWith("(script"));
console.log(`ABC ${surface.version}: ${surface.scripts.length} scripts, ${real.length} classes`);
console.log(
  `methods: ${total.native} native, ${total.as3} AS3 (${total.code} code bytes), ` +
    `${total.declared} declared only`,
);
console.log(`closures: ${closures.as3} (${closures.code} code bytes)`);
console.log(
  `AS3 bodies by code bytes: ${BOUNDS.map((b, i) => `≤${b}: ${sizes[i]}`).join(", ")}, ` +
    `more: ${sizes[BOUNDS.length]}`,
);

if (args.includes("--classes")) {
  console.log("");
  const rows = all.filter(([, t]) => t.as3 + t.native > 0).sort(([, a], [, b]) => b.code - a.code);
  for (const [c, t] of rows) {
    console.log(
      `${String(t.code).padStart(7)} B ${String(t.as3).padStart(4)} AS3 ` +
        `${String(t.native).padStart(4)} native  ${c.name}`,
    );
  }
}
