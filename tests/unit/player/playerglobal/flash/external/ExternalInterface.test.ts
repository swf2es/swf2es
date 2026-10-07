import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExternalInterfaceHost } from "../../../../../../packages/player/dist/hosts.js";
import { externalInterfaceNatives } from "../../../../../../packages/player/dist/playerglobal/flash/external/ExternalInterface.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const CLASS = "flash.external::ExternalInterface";
const PRIVATE = `${CLASS}.flash.external:ExternalInterface::`;

function scripting(host: ExternalInterfaceHost | null): Scripting {
  const rt = {
    toString: String,
    array: (values: unknown[]) => ({ $a: values }),
    callValue: (
      closure: { $f: (...args: unknown[]) => unknown },
      _receiver: unknown,
      args: unknown[],
    ) => closure.$f(...args),
    error: (_name: string, id: number) => new Error(`Error #${id}`),
    hasNext: (_object: unknown, index: number) => (index < 2 ? index + 1 : 0),
    nextName: (_object: unknown, index: number) => ["first", "second"][index - 1],
  };
  return { rt, externalInterface: host, hostCalls: 0 } as unknown as Scripting;
}

test("ExternalInterface reports an unavailable host and keeps callbacks per player", () => {
  const unavailable = scripting(null);
  const absent = externalInterfaceNatives(unavailable);
  assert.equal(absent[`${CLASS}.get:available`](unavailable.rt).call(null), false);
  assert.equal(absent[`${CLASS}.get:objectID`](unavailable.rt).call(null), null);
  assert.throws(
    () => absent[`${PRIVATE}_evalJS`](unavailable.rt).call(null, "source"),
    /Error #2067/,
  );

  const calls: string[] = [];
  const callbacks: { current: ((request: string, args: unknown[] | null) => unknown) | null } = {
    current: null,
  };
  const first = scripting({
    objectID: "first",
    evalJS(source) {
      calls.push(`eval ${source}`);
      return null;
    },
    callOut(request) {
      calls.push(`call ${request}`);
      return "<null/>";
    },
    addCallback(name, value) {
      calls.push(`callback ${name}`);
      callbacks.current = value;
    },
  });
  const second = scripting({
    objectID: "second",
    evalJS: () => "<undefined/>",
    callOut: () => null,
    addCallback: () => {},
  });
  const a = externalInterfaceNatives(first);
  const b = externalInterfaceNatives(second);

  assert.equal(a[`${CLASS}.get:available`](first.rt).call(null), true);
  assert.equal(a[`${CLASS}.get:objectID`](first.rt).call(null), "first");
  assert.equal(b[`${CLASS}.get:objectID`](second.rt).call(null), "second");
  assert.equal(
    a[`${CLASS}.get:flash.external:ExternalInterface::activeX`](first.rt).call(null),
    false,
  );
  assert.equal(a[`${PRIVATE}_initJS`](first.rt).call(null), undefined);
  assert.deepEqual(a[`${PRIVATE}_getPropNames`](first.rt).call(null, {}), {
    $a: ["first", "second"],
  });
  assert.equal(a[`${PRIVATE}_evalJS`](first.rt).call(null, "source"), null);
  assert.equal(a[`${PRIVATE}_callOut`](first.rt).call(null, "<invoke/>"), "<null/>");
  assert.deepEqual(calls, ["eval source", "call <invoke/>"]);

  const closure = {
    $f: (request: string, args: { $a: unknown[] } | null) => `${request}:${args?.$a ?? "none"}`,
  };
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, false);
  assert.equal(callbacks.current?.("message", [1, 2]), "message:1,2");
  // A call from the page runs outside a frame: a change a host draws for.
  assert.equal(first.hostCalls, 1);
  // An XML invocation alone: playerglobal's _callIn reads its arguments from it.
  assert.equal(callbacks.current?.("<invoke/>", null), "<invoke/>:none");
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, true);
  assert.equal(callbacks.current, null);
  assert.deepEqual(calls.slice(2), ["callback ready", "callback ready"]);
  assert.equal(first.hostCalls, 2);
});

test("ExternalInterface quotes JavaScript string and error arguments", () => {
  const s = scripting(null);
  const natives = externalInterfaceNatives(s);
  const quote = natives[`${PRIVATE}_quotedStringFromString`](s.rt);
  const quoteError = natives[`${PRIVATE}_quotedStringFromError`](s.rt);
  const value = 'quote " slash \\ newline \n tab \t null \0';

  assert.equal(JSON.parse(quote.call(null, value) as string), value);
  assert.equal(quote.call(null, value), JSON.stringify(value));
  assert.equal(
    JSON.parse(quoteError.call(null, new Error("bad input")) as string),
    "Error: bad input",
  );
});
