import assert from "node:assert/strict";
import { test } from "node:test";
import { jobKey } from "../../../oracle/flash.ts";

test("a Flash job run alone is cached apart from the same job run with others", () => {
  const job = { swf: new Uint8Array([0x46, 0x57, 0x53, 10]), frames: 1, capture: [1] };
  // A result drawn among other jobs is not one drawn alone, nor the reverse.
  assert.notEqual(jobKey({ ...job, alone: true }), jobKey(job));
  // Not alone is the job as it was keyed before alone existed.
  assert.equal(jobKey({ ...job, alone: false }), jobKey(job));
  assert.equal(jobKey({ ...job, alone: true }), jobKey({ ...job, alone: true }));
});
