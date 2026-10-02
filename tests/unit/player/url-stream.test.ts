import assert from "node:assert/strict";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";
import { urlStreamNatives } from "../../../packages/player/dist/playerglobal/flash/net/URLStream.js";
import type { Scripting } from "../../../packages/player/dist/scripting.js";

test("URLStream delivers fetched bytes on a frame and discards a closed request", () => {
  const events: string[] = [];
  const errors: string[] = [];
  const requests: {
    url: string;
    signal: AbortSignal;
    deliver: (bytes: Uint8Array | null) => void;
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
    requestBytes: (url: string, signal: AbortSignal, deliver: (bytes: Uint8Array | null) => void) =>
      requests.push({ url, signal, deliver }),
    streamError: (url: string) => `Error #2032: Stream Error. URL: http://example.test/${url}`,
  } as unknown as Scripting;
  const natives = urlStreamNatives(scripting);
  const key = (name: string) => natives[`flash.net::URLStream#${name}`](scripting.rt);
  const stream: Record<string, unknown> = {
    $listeners: new Map(
      ["open", "progress", "complete", "ioError"].map((type) => [
        type,
        [
          {
            fn: (event: { $text?: string }) => {
              events.push(type);
              if (type === "ioError" && event.$text) {
                errors.push(event.$text);
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
  requests[0].deliver(new Uint8Array([1, 2, 3]));
  assert.deepEqual(events, ["open", "progress", "complete"]);
  assert.equal(key("get:bytesAvailable").call(stream), 3);
  assert.deepEqual(
    [...avm2.bytesOf(scripting.rt, stream.$buffer as avm2.AsObject).buffer.subarray(0, 3)],
    [1, 2, 3],
  );

  key("load").call(stream, { url: "cancel.bin" });
  key("close").call(stream);
  assert.throws(() => key("close").call(stream), /2029/);
  assert.equal(requests[1].signal.aborted, true);
  requests[1].deliver(new Uint8Array([4]));
  assert.deepEqual(events, ["open", "progress", "complete"]);
  assert.equal(key("get:bytesAvailable").call(stream), 0);

  key("load").call(stream, { url: "missing.bin" });
  requests[2].deliver(null);
  assert.deepEqual(events, ["open", "progress", "complete", "ioError"]);
  assert.deepEqual(errors, ["Error #2032: Stream Error. URL: http://example.test/missing.bin"]);
  assert.equal(key("get:connected").call(stream), false);
});
