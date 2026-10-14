import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isAs3, readActions, readSwf, readTags, type Tag } from "@swf2es/format";
import { testing } from "./testing-module.ts";

// The AVM1 decoder over the frame and init actions of Ruffle's corpus's
// avm1/ SWFs, where it is fetched (tests/player/corpus/fetch-ruffle.ts): it
// never traps, and the actions it meets are ones Flash knows. Clip and
// button actions wait for format's listing of a SWF's blocks. Every AVM1
// SWF's module, all its blocks' as readActions lists them, parses.
const corpus = new URL("../../player/corpus/ruffle/tests/tests/swfs/avm1/", import.meta.url);

const DO_ACTION = 12;
const DEFINE_SPRITE = 39;
const DO_INIT_ACTION = 59;

/** The DoAction and DoInitAction bodies among `tags`, sprites' included. */
function blocks(bytes: Uint8Array, tags: Tag[], out: Uint8Array[]): void {
  for (const tag of tags) {
    switch (tag.code) {
      case DO_ACTION:
        out.push(bytes.subarray(tag.offset, tag.offset + tag.length));
        break;
      case DO_INIT_ACTION:
        out.push(bytes.subarray(tag.offset + 2, tag.offset + tag.length));
        break;
      case DEFINE_SPRITE:
        blocks(bytes, readTags(bytes, tag.offset + 4, tag.offset + tag.length).tags, out);
        break;
      default:
        break;
    }
  }
}

test("decodes the frame actions of Ruffle's AVM1 corpus", { skip: !existsSync(corpus) }, (t) => {
  const counts = new Map<string, number>();
  let swfs = 0;
  let count = 0;
  let truncated = 0;
  for (const name of readdirSync(corpus, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".swf")) {
      continue;
    }

    let swf: ReturnType<typeof readSwf>;
    try {
      swf = readSwf(new Uint8Array(readFileSync(new URL(name, corpus))));
    } catch {
      continue;
    }

    swfs++;
    const found: Uint8Array[] = [];
    blocks(swf.bytes, swf.tags, found);
    for (const block of found) {
      count++;
      const lines = (testing.avm1Dump(block) as string).split("\n");
      assert.notDeepEqual(lines, ["too large"], name);
      for (const line of lines) {
        const match = /^\d+ (\S+)( truncated)?/.exec(line);
        if (match) {
          counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
          if (match[2]) {
            truncated++;
          }
        }
      }
    }
  }

  const unknown = [...counts.keys()].filter((op) => op.startsWith("0x"));
  const seen = [...counts].sort((a, b) => b[1] - a[1]).map(([op, n]) => `${op} ${n}`);
  t.diagnostic(`${count} blocks in ${swfs} SWFs, ${truncated} truncated actions`);
  t.diagnostic(`actions: ${seen.join(", ")}`);
  t.diagnostic(`unknown: ${unknown.join(", ") || "none"}`);
  assert.ok(count > 0);
});

test("every AVM1 SWF of the corpus compiles to a module that parses", {
  skip: !existsSync(corpus),
}, async (t) => {
  let modules = 0;
  let bytes = 0;
  for (const name of readdirSync(corpus, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".swf")) {
      continue;
    }

    let swf: ReturnType<typeof readSwf>;
    try {
      swf = readSwf(new Uint8Array(readFileSync(new URL(name, corpus))));
    } catch {
      continue;
    }

    if (isAs3(swf)) {
      continue;
    }

    const { version, blocks } = readActions(swf);
    const module = testing.actionsModuleBytes(
      swf.bytes,
      Int32Array.from(blocks, (b) => b.offset),
      Int32Array.from(blocks, (b) => b.length),
      version,
    ) as Uint8Array;
    // Imported as the player imports it: an ES module, strict.
    const url = `data:text/javascript;base64,${Buffer.from(module).toString("base64")}`;
    const { default: factory } = await import(url);
    assert.equal(typeof factory, "function", name);
    modules++;
    bytes += module.length;
  }

  t.diagnostic(`${modules} modules, ${bytes} bytes`);
  assert.ok(modules > 0);
});
