// A host's pieces as the loads hear them (packages/player/src/pieces.ts): cut
// into reads of 8 KB at most, as Flash told its progress, each told as it
// comes, of a total that never stays below what came, with a last word where
// what was told did not end with all of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { piecesOf } from "../../../packages/player/dist/pieces.js";

function heard(total: number, chunks: number[], whole = true): string[] {
  const told: string[] = [];
  const { progress, end } = piecesOf({
    open: (_head, t) => told.push(`open ${t}`),
    data: (chunk, loaded, t, last) =>
      told.push(`${chunk.length} ${loaded} ${t}${last ? " last" : ""}`),
  });
  progress.open({ status: 200, headers: [] }, total);
  for (const length of chunks) {
    progress.data(new Uint8Array(length));
  }

  end(whole);
  return told;
}

test("a piece larger than a read is told a read at a time, each as it comes", () => {
  assert.deepEqual(heard(20000, [20000]), [
    "open 20000",
    "8192 8192 20000",
    "8192 16384 20000",
    "3616 20000 20000",
  ]);
});

test("without a length the total is unknown until a last word, which tells all that came", () => {
  assert.deepEqual(heard(0, [10, 10]), ["open 0", "10 10 0", "10 20 0", "0 20 20 last"]);
});

test("more than the length told makes the total unknown, and stays so until the last word", () => {
  assert.deepEqual(heard(15, [10, 10, 10]), [
    "open 15",
    "10 10 15",
    "10 20 0",
    "10 30 0",
    "0 30 30 last",
  ]);
});

test("a response that fails or stays open has what came told at once, and no last word", () => {
  assert.deepEqual(heard(30, [10, 10], false), ["open 30", "10 10 30", "10 20 30"]);
});

test("nothing after a length told ends with a last word of none of none", () => {
  assert.deepEqual(heard(30, []), ["open 30", "0 0 0 last"]);
});
