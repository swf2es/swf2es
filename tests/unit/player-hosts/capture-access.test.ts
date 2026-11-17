import assert from "node:assert/strict";
import { test } from "node:test";
import { denied, openMedia } from "../../../packages/player-hosts/dist/capture-access.js";

test("capture retries stale constraints without turning device failure into denied permission", async () => {
  for (const name of ["OverconstrainedError", "NotFoundError"]) {
    const requested: Parameters<typeof openMedia>[1][] = [];
    const stream = {} as Awaited<ReturnType<typeof openMedia>>;
    const media = {
      async getUserMedia(options: Parameters<typeof openMedia>[1]) {
        requested.push(options);
        if (requested.length === 1) {
          throw new DOMException("device changed", name);
        }
        return stream;
      },
    } as Parameters<typeof openMedia>[0];
    const exact = { video: { deviceId: { exact: "old" }, frameRate: { max: 15 } } };
    const relaxed = { video: { frameRate: { ideal: 15 } } };
    assert.equal(await openMedia(media, exact, relaxed, new AbortController().signal), stream);
    assert.deepEqual(requested, [exact, relaxed]);
  }
  for (const name of ["NotReadableError", "OverconstrainedError", "NotFoundError", "AbortError"]) {
    assert.equal(denied(new DOMException("unavailable", name)), false);
  }
  assert.equal(denied(new DOMException("refused", "NotAllowedError")), true);
  assert.equal(denied(new DOMException("refused", "SecurityError")), true);
});
