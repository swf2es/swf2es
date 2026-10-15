import assert from "node:assert/strict";
import { test } from "node:test";
import { reportUrl } from "../../../apps/site/src/report.ts";

const facts = {
  build: "0123456789ab",
  userAgent: "a browser",
  renderer: "WebGL 2",
  quality: "high",
  scale: "showAll",
  swf: null,
};

const body = (errors: string[]) =>
  new URL(reportUrl({ ...facts, errors })).searchParams.get("body") ?? "";

test("the report's errors are fenced by more backticks than any run in them", () => {
  assert.match(body(["plain"]), /\n```\nplain\n```$/);

  const text = body(["a ``` b", "c `````` d"]);
  assert.match(text, /\n```````\na ``` b\nc `````` d\n```````$/);
});

test("the report's SWF origin loses its query and fragment", () => {
  const url = reportUrl({
    ...facts,
    errors: [],
    swf: {
      origin: "https://example.com/a/movie.swf?token=secret#x",
      version: 10,
      compression: "zlib",
      avm: "AVM2",
      bytes: 1,
      width: 1,
      height: 1,
      frameRate: 30,
      frameCount: 1,
    },
  });
  const text = new URL(url).searchParams.get("body") ?? "";
  assert.match(text, /From: https:\/\/example\.com\/a\/movie\.swf\n/);
  assert.doesNotMatch(text, /secret/);
});
