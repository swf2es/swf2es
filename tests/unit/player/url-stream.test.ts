import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";
import { urlStreamNatives } from "../../../packages/player/dist/playerglobal/flash/net/URLStream.js";
import type { FetchResult, Scripting } from "../../../packages/player/dist/scripting.js";

test("URLStream delivers fetched bytes on a frame and discards a closed request", () => {
  const events: string[] = [];
  const errors: string[] = [];
  const requests: {
    url: string;
    signal: AbortSignal;
    deliver: (result: FetchResult) => void;
  }[] = [];
  const rt = {
    defaultObjectEncoding: 3,
    classNamed: (name: string) => name,
    construct: (
      name: string,
      type?: string,
      _bubbles?: boolean,
      _cancelable?: boolean,
      text?: string,
    ) => ({ $type: type ?? name, $text: text, $stopped: 0 }),
    publicName: (name: string) => name,
    getProperty: (object: Record<string, unknown>, name: string) => object[name],
    toString: String,
    error: (_name: string, id: number) => new Error(`Error #${id}`),
    call: (fn: (event: { $type: string }) => void, _receiver: unknown, event: { $type: string }) =>
      fn(event),
  };
  const scripting = {
    rt,
    event: (type: string) => ({ $type: type, $stopped: 0 }),
    httpStatus: (status: number) => ({ $type: "httpStatus", $status: status, $stopped: 0 }),
    requestBytes: (
      request: { url: string },
      signal: AbortSignal,
      deliver: (result: FetchResult, url: string) => void,
    ) =>
      requests.push({
        url: request.url,
        signal,
        deliver: (result) => deliver(result, new URL(request.url, "http://example.test/").href),
      }),
    streamError: (url: string, local = false) =>
      local ? "Error #2032: Stream Error" : `Error #2032: Stream Error. URL: ${url}`,
  } as unknown as Scripting;
  const natives = urlStreamNatives(scripting);
  const key = (name: string) => natives[`flash.net::URLStream#${name}`](scripting.rt);
  const stream: Record<string, unknown> = {
    $listeners: new Map(
      ["open", "progress", "httpStatus", "complete", "ioError"].map((type) => [
        type,
        [
          {
            fn: (event: { $text?: string; $status?: number }) => {
              events.push(type);
              if (type === "ioError" && event.$text) {
                errors.push(event.$text);
              }
              if (type === "httpStatus") {
                errors.push(`status=${event.$status}`);
              }
            },
            capture: false,
            priority: 0,
          },
        ],
      ]),
    ),
  };

  assert.throws(() => key("close").call(stream), /2029/);
  // The private stop native may be called for cleanup without an open request.
  assert.doesNotThrow(() => key("stop").call(stream));
  key("load").call(stream, { url: "data.bin" });
  assert.equal(requests[0].url, "data.bin");
  assert.equal(key("get:bytesAvailable").call(stream), 0);
  requests[0].deliver({ bytes: new Uint8Array([1, 2, 3]), status: 200, headers: [] });
  assert.deepEqual(events, ["open", "progress", "httpStatus", "complete"]);
  assert.equal(key("get:bytesAvailable").call(stream), 3);
  assert.deepEqual(
    [...avm2.bytesOf(scripting.rt, stream.$buffer as avm2.AsObject).buffer.subarray(0, 3)],
    [1, 2, 3],
  );

  key("load").call(stream, { url: "cancel.bin" });
  key("close").call(stream);
  assert.throws(() => key("close").call(stream), /2029/);
  assert.equal(requests[1].signal.aborted, true);
  requests[1].deliver({ bytes: new Uint8Array([4]), status: 200, headers: [] });
  assert.deepEqual(events, ["open", "progress", "httpStatus", "complete"]);
  assert.equal(key("get:bytesAvailable").call(stream), 0);

  key("load").call(stream, { url: "missing.bin?new=2" });
  requests[2].deliver({ bytes: null, status: 404, headers: [] });
  assert.deepEqual(events, ["open", "progress", "httpStatus", "complete", "httpStatus", "ioError"]);
  assert.deepEqual(errors, [
    "status=200",
    "status=404",
    "Error #2032: Stream Error. URL: http://example.test/missing.bin?new=2",
  ]);
  assert.equal(key("get:connected").call(stream), false);

  key("load").call(stream, { url: "local.bin" });
  requests[3].deliver({ bytes: null, status: 0, headers: [], local: true });
  assert.deepEqual(events.slice(-2), ["httpStatus", "ioError"]);
  assert.deepEqual(errors.slice(-2), ["status=0", "Error #2032: Stream Error"]);
});
