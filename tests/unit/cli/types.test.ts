// swf2es types: a SWF's own classes declared over the player's libraries'
// declarations, a class of an unknown package as Value.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as w from "../../swf-writer.ts";
import { abc, tables, u30 } from "../codegen/abc-builder.ts";

const out = fileURLToPath(new URL("../out/cli/types/", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));

const swf2es = (...args: string[]) =>
  spawnSync(process.execPath, [cli, "types", ...args], { encoding: "utf8" });

const qname = (ns: number, name: number) => [0x07, ...u30(ns), ...u30(name)];

/**
 * game.Hero extends flash.display.Sprite: `var hp:int`, `get level():uint`,
 * `attack(target:Hero, power:Number = 1):Boolean`, `equip(w:lib.Weapon)`,
 * and `static const NAME:String`.
 */
function heroAbc(): Uint8Array {
  const strings = [
    ...["game", "Hero", "flash.display", "Sprite", "hp", "", "level", "attack", "int", "uint"],
    ...["Number", "Boolean", "NAME", "String", "Weapon", "lib", "equip"],
  ];
  const s = (text: string) => strings.indexOf(text) + 1;
  const namespaces = ["game", "flash.display", "", "lib"].map((p) => [0x16, ...u30(s(p))]);
  const names: [number, string][] = [
    [1, "Hero"],
    [2, "Sprite"],
    [3, "hp"],
    [3, "level"],
    [3, "attack"],
    [3, "int"],
    [3, "uint"],
    [3, "Number"],
    [3, "Boolean"],
    [3, "NAME"],
    [3, "String"],
    [4, "Weapon"],
    [3, "equip"],
  ];
  const n = (ns: number, name: string) => names.findIndex(([a, b]) => a === ns && b === name) + 1;
  return abc(
    {
      doubles: [1],
      strings,
      namespaces,
      multinames: names.map(([ns, name]) => qname(ns, s(name))),
    },
    tables({
      methods: [
        {},
        {},
        {},
        { ret: n(3, "uint") },
        {
          params: [n(1, "Hero"), n(3, "Number")],
          ret: n(3, "Boolean"),
          optional: [[1, 0x06]],
        },
        { params: [n(4, "Weapon")] },
      ],
      classes: [
        {
          instance: {
            name: n(1, "Hero"),
            base: n(2, "Sprite"),
            flags: 0x01,
            init: 0,
            traits: [
              { name: n(3, "hp"), kind: 0, index: n(3, "int") },
              { name: n(3, "level"), kind: 2, index: 3 },
              { name: n(3, "attack"), kind: 1, index: 4 },
              { name: n(3, "equip"), kind: 1, index: 5 },
            ],
          },
          init: 1,
          traits: [{ name: n(3, "NAME"), kind: 6, index: n(3, "String") }],
        },
      ],
      scripts: [{ init: 2, traits: [{ name: n(1, "Hero"), kind: 4, index: 0 }] }],
    }),
  );
}

test("a SWF's classes extend the player's declarations", () => {
  mkdirSync(out, { recursive: true });
  const file = `${out}hero.swf`;
  writeFileSync(
    file,
    w.swf({
      width: 10,
      height: 10,
      frameCount: 1,
      tags: [w.fileAttributes(true), w.doAbc(heroAbc(), "Hero"), w.showFrame(), w.end()],
    }),
  );

  const r = swf2es(file, "-o", `${out}hero.ts`, "--name", "Game");
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(`${out}hero.ts`, "utf8");
  for (const line of [
    'import type { As3Classes } from "@swf2es/player/as3-types";',
    'type As3_flash_display_Sprite = As3Classes["flash.display::Sprite"];',
    '  "game::Hero": As3_game_Hero;',
    '  "game::Hero": As3_game_Hero$;',
    "export interface As3_game_Hero extends As3_flash_display_Sprite {",
    "  attack(arg0: avm2.Ref<As3_game_Hero> | null, arg1?: number): boolean;",
    "  equip(arg0: avm2.Value): avm2.Value;",
    "  hp: number;",
    "  readonly level: number;",
    "  readonly NAME: string | null;",
  ]) {
    assert.ok(text.split("\n").includes(line), `${line}\nnot in\n${text}`);
  }

  // The same on standard output.
  const stdout = swf2es(file, "--name", "Game");
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.equal(stdout.stdout, text);
});

test("an AVM1 SWF, or a file of neither kind, is refused", () => {
  mkdirSync(out, { recursive: true });
  const avm1 = `${out}avm1.swf`;
  writeFileSync(
    avm1,
    w.swf({ width: 10, height: 10, frameCount: 1, tags: [w.showFrame(), w.end()] }),
  );
  const r = swf2es(avm1);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /an AVM1 SWF, which defines no classes/);

  const bad = swf2es(`${out}nothing-here.swf`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot read input/);

  const usage = swf2es(avm1, "--name", "not one");
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /is not an identifier/);
});
