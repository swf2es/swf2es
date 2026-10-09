// Our playerglobal.abc, from the AS3 under packages/player/src/playerglobal/:
// compiled as avmplus compiles its own libraries, with ASC 1 (the Flex
// SDK's, in the oracle's image) as a builtin library over builtin.abc, with
// API versioning. Its `native` methods are the player's TypeScript natives.
//
//   node tools/playerglobal.ts [--check]
//
// writes tests/player/out/playerglobal/playerglobal.abc; --check then holds
// each class it defines to the same class in Flash Player's playerglobal.abc
// (tests/player/out/libraries/, from the oracle's image), as SWFs see it.
// While only some packages are ours, Flash Player's is imported for the
// types the rest name.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { container, containerEngine } from "../oracle/oracle.ts";
import { SOURCES as AIR_SOURCES } from "../tests/player/air-library.ts";
import { type Class, readSurface, type Trait } from "./abc-surface/read.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const SOURCES = "packages/player/src/playerglobal";
const OUT = "tests/player/out/playerglobal";
const FLASH = "tests/player/out/libraries/playerglobal.abc";
const BUILTIN = "oracle/avmplus/generated/builtin.abc";

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) {
      return sources(path);
    }

    return name.endsWith(".as") ? [path] : [];
  });
}

/**
 * ASC marks a name with no [API] with 0xE000, version 0, where avmplus' own
 * versions start at 0xE294, Flash Player 9's API 660, which is what such a
 * name is in Flash Player's playerglobal: mark it so. Both are three bytes
 * of UTF-8, and only a namespace URI ends with either.
 */
function versionMarks(abc: Uint8Array): Uint8Array {
  const out = abc.slice();
  for (let i = 0; i + 2 < out.length; i++) {
    if (out[i] === 0xee && out[i + 1] === 0x80 && out[i + 2] === 0x80) {
      out[i + 1] = 0x8a;
      out[i + 2] = 0x94;
    }
  }

  return out;
}

export function build(): Uint8Array {
  // AIR's classes are a library of their own (tests/player/air-library.ts).
  const air = new Set(AIR_SOURCES.map((s) => join(SOURCES, s)));
  const files = sources(SOURCES)
    .filter((f) => !air.has(f))
    .sort();
  rmSync(join(root, OUT), { recursive: true, force: true });
  mkdirSync(join(root, OUT), { recursive: true });
  const asc = [
    "java -ea -DAS3 -DAVMPLUS -classpath /opt/flex/lib/asc.jar macromedia.asc.embedding.ScriptCompiler",
    `-import ${BUILTIN} -import ${FLASH} -builtin -apiversioning -strict`,
    `-outdir ${OUT} -out playerglobal`,
    ...files,
  ].join(" ");
  const r = container(containerEngine(), ["-c", asc]);
  const abcFile = join(root, OUT, "playerglobal.abc");
  let abc: Uint8Array;
  try {
    abc = new Uint8Array(readFileSync(abcFile));
  } catch {
    throw new Error(`ASC wrote no playerglobal.abc:\n${r.stdout}${r.stderr}`);
  }

  const marked = versionMarks(abc);
  writeFileSync(abcFile, marked);
  // ASC also writes C++ glue for avmplus' natives, which ours are not.
  rmSync(join(root, OUT, "playerglobal.cpp"), { force: true });
  rmSync(join(root, OUT, "playerglobal.h"), { force: true });
  return marked;
}

// What a SWF sees of a class: its names, their namespaces and API versions,
// types, defaults (numbers by value: an int 1 and a double 1 are one Number
// to a parameter of that type), flags, and [API] metadata.

type Shape = Map<string, string>;

const number = (v: unknown) =>
  Array.isArray(v) && (v[0] === "int" || v[0] === "uint" || v[0] === "double")
    ? ["number", Number(v[1])]
    : (v ?? null);

function shapes(abc: Uint8Array): Map<string, Shape> {
  const out = new Map<string, Shape>();
  const visible = (name: string) =>
    !name.startsWith("{") || /^\{(package|protected|staticprotected|namespace)/.test(name);
  for (const script of readSurface(abc).scripts) {
    for (const t of script.traits) {
      if (t.kind !== "class") {
        continue;
      }

      const c: Class = t.class;
      const shape: Shape = new Map();
      shape.set(
        "(class)",
        JSON.stringify({
          name: t.name,
          super: c.super,
          flags: c.flags,
          interfaces: c.interfaces.map((i) => i.replace(/^\{.*\}::/, "")),
          constructor: c.init.params.map((p) => [p.type, number(p.default)]),
        }),
      );
      for (const [side, list] of [
        ["static", c.static],
        ["instance", c.instance],
      ] as const) {
        for (const m of list as Trait[]) {
          if (!visible(m.name)) {
            continue;
          }

          const body =
            "method" in m
              ? {
                  params: m.method.params.map((p) => [p.type, number(p.default)]),
                  returns: m.method.returns,
                  rest: m.method.flags.includes("rest"),
                  flags: "flags" in m ? m.flags : [],
                }
              : "type" in m
                ? { type: m.type, value: number(m.value) }
                : {};
          shape.set(`${side} ${m.kind} ${m.name}`, JSON.stringify(body));
        }
      }

      out.set(t.name.replace(/^\{[^}]*\}::|^.*::/, ""), shape);
    }
  }

  return out;
}

/** Each difference between our classes and Flash Player's same ones, as a line. */
export function check(ours: Uint8Array, flash: Uint8Array): string[] {
  const theirs = shapes(flash);
  const out: string[] = [];
  for (const [name, mine] of shapes(ours)) {
    const ref = theirs.get(name);
    if (!ref) {
      out.push(`${name}: not Flash Player's`);
      continue;
    }

    for (const [key, v] of ref) {
      if (mine.get(key) !== v) {
        out.push(`${name} ${key}\n    Flash ${v}\n    ours  ${mine.get(key) ?? "(missing)"}`);
      }
    }

    for (const key of mine.keys()) {
      if (!ref.has(key)) {
        out.push(`${name} ${key}: only ours`);
      }
    }
  }

  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abc = build();
  console.log(
    `${relative(process.cwd(), join(root, OUT, "playerglobal.abc"))}: ${abc.length} bytes`,
  );
  if (process.argv.includes("--check")) {
    const differences = check(abc, new Uint8Array(readFileSync(join(root, FLASH))));
    for (const d of differences) {
      console.log(d);
    }

    console.log(
      `${shapes(abc).size} classes, ${differences.length} differences from Flash Player's`,
    );
    process.exitCode = differences.length ? 1 : 0;
  }
}
