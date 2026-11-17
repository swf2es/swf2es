import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWhile, linkedSignal } from "../../../packages/player/dist/signals.js";

/** A long-lived signal that counts the abort listeners on it. */
function counted(): { controller: AbortController; listeners: () => number } {
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners++;
    add(...args);
  };
  signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners--;
    remove(...args);
  };
  return { controller, listeners: () => listeners };
}

test("a linked signal aborts with either source, with its reason, until released", () => {
  const lifetime = new AbortController();
  const request = new AbortController();
  const first = linkedSignal(lifetime.signal, request.signal);
  request.abort("cancelled");
  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, "cancelled");

  const second = linkedSignal(lifetime.signal);
  const third = linkedSignal(lifetime.signal);
  third.release();
  lifetime.abort("stopped");
  assert.equal(second.signal.reason, "stopped");
  assert.equal(third.signal.aborted, false);

  const late = linkedSignal(lifetime.signal);
  assert.equal(late.signal.aborted, true);
  assert.equal(late.signal.reason, "stopped");

  const own = linkedSignal(new AbortController().signal);
  own.abort();
  assert.equal(own.signal.aborted, true);
});

test("a fetch's signal is the player's to abort only until the fetch settles", async () => {
  const lifetime = counted();
  const given: AbortSignal[] = [];
  let finish: (() => void) | null = null;
  const pending = fetchWhile(
    (_request: string, signal) => {
      given.push(signal);
      return new Promise<string>((done) => {
        finish = () => done("ok");
      });
    },
    "a",
    lifetime.controller.signal,
  );
  assert.equal(lifetime.listeners(), 1);
  (finish as unknown as () => void)();
  assert.equal(await pending, "ok");
  assert.equal(lifetime.listeners(), 0);

  await assert.rejects(
    fetchWhile(
      (_request: string, signal) => {
        given.push(signal);
        return Promise.reject(new Error("refused"));
      },
      "b",
      lifetime.controller.signal,
      new AbortController().signal,
    ),
    /refused/,
  );
  assert.throws(() =>
    fetchWhile(
      () => {
        throw new Error("thrown");
      },
      "c",
      lifetime.controller.signal,
    ),
  );
  assert.equal(lifetime.listeners(), 0);

  // As AbortSignal.any's would be, had the source kept them: not aborted with it.
  lifetime.controller.abort();
  assert.deepEqual(
    given.map((s) => s.aborted),
    [false, false],
  );
});

test("a request's own signal keeps no listener once the fetch settles, nor one aborted at the start", async () => {
  const lifetime = counted();
  const request = counted();
  await fetchWhile(
    async (_request: string, _signal) => "ok",
    "a",
    lifetime.controller.signal,
    request.controller.signal,
  );
  assert.equal(request.listeners(), 0);
  assert.equal(lifetime.listeners(), 0);

  request.controller.abort("cancelled");
  const early = linkedSignal(lifetime.controller.signal, request.controller.signal);
  assert.equal(early.signal.aborted, true);
  assert.equal(early.signal.reason, "cancelled");
  assert.equal(request.listeners(), 0);
  assert.equal(lifetime.listeners(), 0);
});
