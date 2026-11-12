// What the element prints for a SWF's uncaught errors: the message in
// full, where it was thrown, and a repeated one only now and then.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UncaughtReports } from "../../../packages/web/dist/uncaught.js";

test("an uncaught error is told with its words and where it was thrown", () => {
  const reports = new UncaughtReports();
  const stack = ["    at $f1 (a.js:1:1)", "    at $f2 (a.js:2:1)", "x", "y", "z"].join("\n");
  assert.equal(
    reports.line("TypeError: Error #1006", "Error #1006: value is not a function.", stack),
    "swf2es: TypeError: Error #1006: value is not a function.\n    at $f1 (a.js:1:1)\n    at $f2 (a.js:2:1)\nx\ny",
  );
  // An error a SWF made itself has no detail, and one that is no AS3 error no stack.
  assert.equal(reports.line("Error: mine", null, null), "swf2es: Error: mine");
  // A message that is not the number alone is left as it is.
  assert.equal(
    reports.line("Error: Error #1006 and more", "Error #1006: value is not a function.", null),
    "swf2es: Error: Error #1006 and more",
  );
});

test("the same error thrown again is told at its 10th, 100th and 1000th time only", () => {
  const reports = new UncaughtReports();
  const told: string[] = [];
  for (let i = 0; i < 1500; i++) {
    const line = reports.line(
      "TypeError: Error #1006",
      "Error #1006: f is not a function.",
      "at $a",
    );
    if (line !== null) {
      told.push(line.split("\n")[0]);
    }
  }

  const full = "swf2es: TypeError: Error #1006: f is not a function.";
  assert.deepEqual(told, [
    full,
    `${full} (10 times)`,
    `${full} (100 times)`,
    `${full} (1000 times)`,
  ]);
  // Thrown elsewhere, it is another error.
  assert.ok(reports.line("TypeError: Error #1006", null, "at $b")?.includes("at $b"));
});
