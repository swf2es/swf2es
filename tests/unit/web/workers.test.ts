import assert from "node:assert/strict";
import { test } from "node:test";
import { readSwf } from "../../../packages/format/dist/index.js";
import { namesWorkers } from "../../../packages/web/dist/workers.js";
import * as w from "../../swf-writer.ts";

test("a SWF names workers where its ABCs say WorkerDomain, and only there", () => {
  const ascii = (text: string) => new TextEncoder().encode(text);
  const movie = (...tags: Uint8Array[]) =>
    readSwf(
      w.swf({ width: 10, height: 10, frameCount: 1, tags: [...tags, w.showFrame(), w.end()] }),
    );
  assert.equal(namesWorkers(movie(w.doAbc(ascii("..flash.system\0WorkerDomain\0..")))), true);
  assert.equal(
    namesWorkers(movie(w.doAbc(ascii("Worker WorkerDomai")), w.doAbc(ascii("n")))),
    false,
  );
  // Its name in a frame label is not ActionScript's.
  assert.equal(namesWorkers(movie(w.frameLabel("WorkerDomain"), w.doAbc(ascii("Sprite")))), false);
});
