// --log-network's lines (apps/desktop/src/main/netlog.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { failureLine, requestLine, socketLine } from "../../apps/desktop/src/main/netlog.ts";

test("a request's line has its method, URL, status, size and time", () => {
  assert.equal(
    requestLine("GET", "https://example.test/a.swf", 200, 12595, 48.4),
    "swf2es: net GET https://example.test/a.swf 200 12.3 kB 48 ms",
  );
  assert.equal(
    requestLine("POST", "http://h/x", 404, 0, 3),
    "swf2es: net POST http://h/x 404 0 B 3 ms",
  );
  assert.equal(
    requestLine("GET", "http://h/x", 0, null, 3),
    "swf2es: net GET http://h/x 0 no body 3 ms",
  );
  assert.match(requestLine("GET", "http://h/big", 200, 5 * 1024 * 1024, 1), / 5\.0 MB /);
  assert.equal(
    failureLine("GET", "http://h/x", "aborted", 12.6),
    "swf2es: net GET http://h/x aborted 13 ms",
  );
});

test("a line carries no control characters, and no more than 2048 of a URL", () => {
  const line = requestLine("GET", `http://h/\u001b[31m\n${"a".repeat(5000)}`, 200, 1, 1);
  assert.ok([...line].every((c) => c.charCodeAt(0) >= 32));
  assert.ok(line.length < 2100);
  assert.equal(socketLine(3, "connecting to h:80\n"), "swf2es: socket #3 connecting to h:80?");
});
