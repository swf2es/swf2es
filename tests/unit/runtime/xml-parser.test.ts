import assert from "node:assert/strict";
import { test } from "node:test";
import { OK, XMLParser, XMLTag } from "../../../packages/runtime/dist/avm2/natives/xml/parser.js";

test("a document of many values without an & tokenizes in time linear in its length", () => {
  // Each value's search for an & or a ; once ran on through the rest of the text: here, a scan
  // of most of the document for every one of its 400,000 values, minutes rather than milliseconds.
  const parts: string[] = ["<r>"];
  for (let i = 0; i < 200_000; i++) {
    parts.push(`<i n="v${i}">text ${i}</i>`);
  }
  parts.push("<last>a&amp;b</last></r>");
  const text = parts.join("");

  const parser = new XMLParser(text);
  parser.parse(false);
  const tag = new XMLTag();
  const started = performance.now();
  let tags = 0;
  let previous = "";
  let last = "";
  while (parser.getNext(tag) === OK) {
    tags++;
    if (previous === "last") {
      last = tag.text;
    }

    previous = tag.text;
  }
  const took = performance.now() - started;

  // <r>, three tags an item, then <last>, its text, </last> and </r>.
  assert.equal(tags, 1 + 3 * 200_000 + 4);
  assert.equal(last, "a&b");
  assert.ok(took < 2000, `tokenizing took ${Math.round(took)} ms`);
});
