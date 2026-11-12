// --log-network's lines (apps/desktop/src/main/netlog.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failureLine,
  requestLine,
  socketDataLine,
  socketLine,
} from "../../apps/desktop/src/main/netlog.ts";

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

test("a socket's message is shown as text where it is text, else in hex, and cut at 512 bytes", () => {
  const text = new TextEncoder().encode("<msg t='sys'><body action='hi'/></msg>\0");
  assert.equal(
    socketDataLine(2, true, text),
    "swf2es: socket #2 > 39 B  <msg t='sys'><body action='hi'/></msg>.",
  );
  assert.equal(
    socketDataLine(2, false, new Uint8Array([0, 255, 16, 128, 1])),
    "swf2es: socket #2 < 5 B  00 ff 10 80 01",
  );
  const long = socketDataLine(1, false, new Uint8Array(2000).fill(65));
  assert.ok(long.endsWith(`${"A".repeat(512)}…`));
  assert.ok(long.startsWith("swf2es: socket #1 < 2000 B  "));
  // An escape sequence in a message does not reach the terminal.
  assert.ok(
    !socketDataLine(1, false, new TextEncoder().encode("ok\u001b[2Jmore text here")).includes(
      "\u001b",
    ),
  );
});
