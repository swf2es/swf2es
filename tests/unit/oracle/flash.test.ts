import assert from "node:assert/strict";
import { test } from "node:test";
import { jobKey, plainFileName } from "../../../oracle/flash.ts";

test("a Flash job run alone is cached apart from the same job run with others", () => {
  const job = { swf: new Uint8Array([0x46, 0x57, 0x53, 10]), frames: 1, capture: [1] };
  // A result drawn among other jobs is not one drawn alone, nor the reverse.
  assert.notEqual(jobKey({ ...job, alone: true }), jobKey(job));
  // Not alone is the job as it was keyed before alone existed.
  assert.equal(jobKey({ ...job, alone: false }), jobKey(job));
  assert.equal(jobKey({ ...job, alone: true }), jobKey({ ...job, alone: true }));
});

test("a Flash job's files are keyed by name and bytes, in any order", () => {
  const job = { swf: new Uint8Array([0x46, 0x57, 0x53, 10]), frames: 1, capture: [1] };
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3]);
  // No files is the job as it was keyed before files existed.
  assert.equal(jobKey({ ...job, files: {} }), jobKey(job));
  assert.notEqual(jobKey({ ...job, files: { "a.swf": a } }), jobKey(job));
  assert.equal(
    jobKey({ ...job, files: { "a.swf": a, "b.swf": b } }),
    jobKey({ ...job, files: { "b.swf": b, "a.swf": a } }),
  );
  assert.notEqual(
    jobKey({ ...job, files: { "a.swf": b } }),
    jobKey({ ...job, files: { "a.swf": a } }),
  );
  assert.notEqual(
    jobKey({ ...job, files: { "b.swf": a } }),
    jobKey({ ...job, files: { "a.swf": a } }),
  );
});

test("a job's file is named by a plain file name", () => {
  assert.equal(plainFileName("child-6.swf"), "child-6.swf");
  for (const name of ["", ".", "..", "../x.swf", "a/b.swf", ".hidden", "a\\b", "a b"]) {
    assert.throws(() => plainFileName(name), /plain file name/);
  }
});
