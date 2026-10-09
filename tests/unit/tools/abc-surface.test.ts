import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scripts } from "../../../packages/runtime/dist/avm2/builtin/scripts.js";
import {
  fromDeclarations,
  normalize,
  toDeclarations,
} from "../../../tools/abc-surface/declarations.ts";
import { type Class, readSurface, type Trait } from "../../../tools/abc-surface/read.ts";
import { generate, THUNKS } from "../../../tools/thunks.ts";

const builtin = readFileSync(
  new URL("../../../oracle/avmplus/generated/builtin.abc", import.meta.url),
);

function findClass(traits: Trait[], name: string): Class | undefined {
  for (const t of traits) {
    if (t.kind === "class" && t.name === name) {
      return t.class;
    }
  }

  return undefined;
}

test("builtin.abc's surface: every class, and Array's traits as avmplus declares them", () => {
  const surface = readSurface(builtin);
  assert.equal(surface.version, "46.16");

  const classes = surface.scripts.flatMap((s) => s.traits).filter((t) => t.kind === "class");
  assert.equal(classes.length, 57);

  const array = surface.scripts
    .map((s) => findClass(s.traits, "{package:@v0}::Array"))
    .find(Boolean);
  assert.ok(array);
  assert.equal(array.super, "Object");
  assert.deepEqual(array.static[0], {
    kind: "const",
    name: "{package:@v0}::CASEINSENSITIVE",
    slot: 1,
    type: "uint",
    value: ["int", 1],
  });

  const join = array.instance.find((t) => t.name.endsWith("2006/builtin}::join"));
  assert.ok(join && join.kind === "method");
  assert.deepEqual(join.method.params, [{ type: "*", default: ["undefined", null] }]);
  assert.equal(join.method.returns, "String");
  assert.ok(join.method.code && join.method.code > 0, "join is written in AS3");

  const length = array.instance.find((t) => t.name === "{package:@v0}::length");
  assert.ok(length && length.kind === "getter");
  assert.deepEqual(length.method.flags, ["native"]);
});

test("declarations made from builtin.abc's surface give that surface back", () => {
  const surface = readSurface(builtin);
  assert.deepEqual(fromDeclarations(toDeclarations(surface)), normalize(surface));
});

test("the runtime's builtin declarations declare builtin.abc's surface", () => {
  assert.deepEqual(fromDeclarations(scripts), normalize(readSurface(builtin)));
});

test("thunks.ts is what tools/thunks.ts generates from the declarations", async () => {
  const { nativeMembers } = await import("../../../packages/runtime/dist/avm2/builtin/bind.js");
  const generated = execFileSync(
    fileURLToPath(new URL("../../../node_modules/.bin/biome", import.meta.url)),
    ["format", `--stdin-file-path=${THUNKS}`],
    { input: generate(scripts, nativeMembers), encoding: "utf8" },
  );
  assert.equal(
    generated,
    readFileSync(THUNKS, "utf8"),
    "run node tools/thunks.ts after pnpm build",
  );
});
