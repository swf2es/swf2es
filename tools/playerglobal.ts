// Our playerglobal.abc, from the AS3 under as3/playerglobal/src/:
// compiled as avmplus compiles its own libraries, with ASC 1 (the Flex
// SDK's, in the oracle's image) as a builtin library over builtin.abc, with
// API versioning, and the AS3 namespace open as Ruffle's sources expect.
// Its `native` methods are the player's TypeScript natives.
//
//   node tools/playerglobal.ts [--check] [--update]
//
// writes tests/player/out/playerglobal/playerglobal.abc; --check then holds
// its classes to Flash Player's playerglobal.abc (tests/player/out/libraries/,
// from the oracle's image), as SWFs see them, and --update writes the ABC
// into playerglobal-library.ts, which the player ships.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { container, containerEngine, libraries } from "../oracle/oracle.ts";
import { type Class, readSurface, type Trait } from "./abc-surface/read.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const SOURCES = "as3/playerglobal/src";
const OUT = "tests/player/out/playerglobal";
const FLASH = "tests/player/out/libraries/playerglobal.abc";
const BUILTIN = "oracle/avmplus/generated/builtin.abc";
export const GENERATED = join(root, "packages/player/src/playerglobal/playerglobal-library.ts");

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

/** When our playerglobal's sources last changed. */
export function sourcesChanged(): number {
  return Math.max(...sources(SOURCES).map((f) => statSync(join(root, f)).mtimeMs));
}

/** Compile our playerglobal into `outDir`, in the repository, which the container sees. */
export function build(outDir = join(root, OUT)): Uint8Array {
  const files = sources(SOURCES).sort();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const asc = [
    "java -ea -DAS3 -DAVMPLUS -classpath /opt/flex/lib/asc.jar macromedia.asc.embedding.ScriptCompiler",
    `-import ${BUILTIN} -builtin -apiversioning -strict -AS3`,
    `-outdir ${relative(root, outDir)} -out playerglobal`,
    ...files,
  ].join(" ");
  const r = container(containerEngine(), ["-c", asc]);
  const abcFile = join(outDir, "playerglobal.abc");
  let abc: Uint8Array;
  try {
    abc = new Uint8Array(readFileSync(abcFile));
  } catch {
    throw new Error(`ASC wrote no playerglobal.abc:\n${r.stdout}${r.stderr}`);
  }

  const marked = versionMarks(abc);
  writeFileSync(abcFile, marked);
  // ASC also writes C++ glue for avmplus' natives, which ours are not.
  rmSync(join(outDir, "playerglobal.cpp"), { force: true });
  rmSync(join(outDir, "playerglobal.h"), { force: true });
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

/** A name with its namespace set in one order: the set is what a SWF sees, not its order. */
function sorted(name: string): string {
  const m = name.match(/^\{(.*)\}::(.*)$/);
  return m ? `{${m[1].split(",").sort().join(",")}}::${m[2]}` : name;
}

function shapes(abc: Uint8Array): Map<string, Shape> {
  const out = new Map<string, Shape>();
  const visible = (name: string) =>
    !name.startsWith("{") || /^\{(package|protected|staticprotected|namespace)/.test(name);
  for (const script of readSurface(abc).scripts) {
    for (const t of script.traits) {
      // A definition in an internal namespace is the library's own.
      if (!t.name.startsWith("{package:")) {
        continue;
      }

      const qualified = t.name.replace(/^\{[^:}]*:([^@,}]*)[^}]*\}::/, "$1::");
      if (t.kind !== "class") {
        const definition =
          "method" in t
            ? {
                params: t.method.params.map((p) => [p.type, number(p.default)]),
                returns: t.method.returns,
              }
            : "type" in t
              ? { type: t.type, value: number(t.value) }
              : {};
        out.set(
          qualified,
          new Map([
            ["(definition)", JSON.stringify({ name: sorted(t.name), kind: t.kind, ...definition })],
          ]),
        );
        continue;
      }

      const c: Class = t.class;
      const shape: Shape = new Map();
      shape.set(
        "(class)",
        JSON.stringify({
          name: sorted(t.name),
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
          shape.set(`${side} ${m.kind} ${sorted(m.name)}`, JSON.stringify(body));
        }
      }

      out.set(qualified, shape);
    }
  }

  return out;
}

// What Flash Player 32's playerglobal has (fpdownload.macromedia.com's
// playerglobal32_0.swc) and the oracle's, older, lacks: ours has it too.
// Unversioned only: a builtin's highest mark, from 42 up, is the VM's
// internal one, and a newer one would make 42 public.
const NEWER = new Set([
  "flash.ui::ContextMenuBuiltInItems instance method clone",
  "flash.net.drm::DRMDeviceGroup instance getter serverURL",
]);

/** Each difference between our classes and Flash Player's same ones, as a line. */
export function check(ours: Uint8Array, flash: Uint8Array): string[] {
  const theirs = shapes(flash);
  const out: string[] = [];
  const mine = shapes(ours);
  for (const [name, shape] of mine) {
    const ref = theirs.get(name);
    if (!ref) {
      out.push(`${name}: not Flash Player's`);
      continue;
    }

    for (const [key, v] of ref) {
      if (shape.get(key) !== v) {
        out.push(`${name} ${key}\n    Flash ${v}\n    ours  ${shape.get(key) ?? "(missing)"}`);
      }
    }

    for (const key of shape.keys()) {
      if (!ref.has(key) && !NEWER.has(`${name} ${key.replace(/\{[^}]*\}::/, "")}`)) {
        out.push(`${name} ${key}: only ours`);
      }
    }
  }

  for (const name of theirs.keys()) {
    if (!mine.has(name)) {
      out.push(`${name}: missing`);
    }
  }

  return out;
}

/** playerglobal-library.ts as it should be for `abc`. */
export function generated(abc: Uint8Array): string {
  return `// swf2es's playerglobal: the ABC compiled from as3/playerglobal, Flash
// Player's API with Ruffle's AS3 and the player's own over its natives.
// Generated by tools/playerglobal.ts --update; not to be edited.
//
// It holds code from Ruffle (https://github.com/ruffle-rs/ruffle), under the
// MIT license or the Apache License 2.0: Copyright (c) 2018-2022 Ruffle LLC
// and Ruffle contributors. Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated documentation files
// (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following
// conditions: The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software. THE SOFTWARE
// IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
// WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** The playerglobal ABC to load after builtin's (Scripting.loadLibraries). */
export const playerglobalLibrary: Uint8Array = Uint8Array.from(
  atob(
    "${Buffer.from(abc).toString("base64")}",
  ),
  (c) => c.charCodeAt(0),
);
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const abc = build();
  console.log(
    `${relative(process.cwd(), join(root, OUT, "playerglobal.abc"))}: ${abc.length} bytes`,
  );
  if (process.argv.includes("--update")) {
    writeFileSync(GENERATED, generated(abc));
  }

  if (process.argv.includes("--check")) {
    if (!existsSync(join(root, FLASH))) {
      libraries(["playerglobal"], join(root, "tests/player/out/libraries/"));
    }

    const differences = check(abc, new Uint8Array(readFileSync(join(root, FLASH))));
    for (const d of differences) {
      console.log(d);
    }

    console.log(
      `${shapes(abc).size} definitions, ${differences.length} differences from Flash Player's`,
    );
    process.exitCode = differences.length ? 1 : 0;
  }
}
