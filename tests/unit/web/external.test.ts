import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argumentsToXml,
  ExternalInterfaceError,
  externalInterfaceHost,
  fromXml,
  invocation,
  readInvocation,
  toXml,
} from "../../../packages/web/dist/external.js";

test("page values go as Flash's __flash__toXML wrote them", () => {
  assert.equal(toXml("a<b & 'c'"), "<string>a&lt;b &amp; &apos;c&apos;</string>");
  assert.equal(toXml(1.5), "<number>1.5</number>");
  assert.equal(toXml(true), "<true/>");
  assert.equal(toXml(undefined), "<undefined/>");
  assert.equal(toXml(null), "<null/>");
  assert.equal(
    toXml(() => 1),
    "<null/>",
  );
  assert.equal(toXml(new Date(5)), "<date>5</date>");
  assert.equal(
    toXml([1, { k: "v" }]),
    '<array><property id="0"><number>1</number></property>' +
      '<property id="1"><object><property id="k"><string>v</string></property></object></property></array>',
  );
  assert.equal(
    argumentsToXml([1, "x"]),
    "<arguments><number>1</number><string>x</string></arguments>",
  );
});

test("a value met again inside itself is null, but one met twice beside itself is not", () => {
  const loop: Record<string, unknown> = { a: 1 };
  loop.self = loop;
  assert.deepEqual(fromXml(toXml(loop)), { a: 1, self: null });
  const shared = [1];
  assert.deepEqual(fromXml(toXml([shared, shared])), [[1], [1]]);
});

test("XML back to page values: plain arrays and objects, whatever their ids", () => {
  const value = fromXml(
    "<object>" +
      '<property id="list"><array><property id="0"><string>a&amp;b&#x41;&#66;</string></property>' +
      '<property id="1"><number>NaN</number></property></array></property>' +
      '<property id="__proto__"><true/></property>' +
      '<property id="when"><date>1000</date></property>' +
      '<property id="none"><undefined /></property>' +
      "</object>",
  ) as Record<string, unknown>;
  assert.deepEqual(value.list, ["a&bAB", Number.NaN]);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(value, "__proto__")?.value, true);
  assert.deepEqual(value.when, new Date(1000));
  assert.ok("none" in value && value.none === undefined);
  assert.throws(() => fromXml("<exception>bad</exception>"), ExternalInterfaceError);
  assert.throws(() => fromXml("<string>open"));
});

test("an invocation reads back its name and arguments", () => {
  const request = invocation('say "hi"', ["x", [2]]);
  assert.equal(
    request,
    '<invoke name="say &quot;hi&quot;" returntype="xml"><arguments><string>x</string>' +
      '<array><property id="0"><number>2</number></property></array></arguments></invoke>',
  );
  assert.deepEqual(readInvocation(request), { name: 'say "hi"', args: ["x", [2]] });
});

/** What playerglobal's call sends to evalJS for `name(args)`. */
const source = (call: string) => `try { __flash__toXML(${call}) ; } catch (e) { "<undefined/>"; }`;

test("a SWF's call runs in the page: named functions, inline ones, and what throws", () => {
  const page = globalThis as Record<string, unknown>;
  page.swf2esAdd = (a: number, b: number) => a + b;
  page.swf2esSpace = {
    k: 2,
    fn(this: { k: number }, a: string) {
      return [this.k, a];
    },
  };
  page.swf2esThrows = () => {
    throw new Error("no");
  };
  try {
    const host = externalInterfaceHost({ objectID: "movie", callback() {} }, () => {});
    assert.equal(host.objectID, "movie");
    // A path is declined, for playerglobal to send it as XML; inline source is evaluated.
    assert.equal(host.evalJS(source("swf2esAdd(1,2)")), null);
    assert.equal(host.callOut(invocation("swf2esAdd", [1, 2])), "<number>3</number>");
    assert.equal(
      host.evalJS(source('function (a) { return a + "!"; }("x")')),
      "<string>x!</string>",
    );
    assert.equal(host.evalJS(source("(function () { throw 1; })()")), "<undefined/>");
    assert.equal(host.evalJS(source("not a name(")), "<undefined/>");

    // The XML path, where eval is refused: a path's function, with what holds it as `this`.
    assert.equal(
      host.callOut(invocation("swf2esSpace.fn", ["a"])),
      '<array><property id="0"><number>2</number></property><property id="1"><string>a</string></property></array>',
    );
    assert.equal(host.callOut(invocation("swf2esThrows", [])), "<undefined/>");
    assert.equal(host.callOut(invocation("function () {}", [])), "<undefined/>");
    assert.equal(host.callOut(invocation("swf2esMissing.fn", [])), "<undefined/>");
  } finally {
    delete page.swf2esAdd;
    delete page.swf2esSpace;
    delete page.swf2esThrows;
  }
});

test("an object's keys reach a named function as data, never as code", () => {
  const page = globalThis as Record<string, unknown>;
  const got: unknown[] = [];
  page.swf2esCapture = (value: unknown) => got.push(value);
  try {
    const host = externalInterfaceHost({ objectID: null, callback() {} }, () => {});
    // What playerglobal's _objectToJS writes for {"a:(globalThis.swf2esPwned=1),b": 1}.
    const injected = source("swf2esCapture(({a:(globalThis.swf2esPwned=1),b:1}))");
    assert.equal(host.evalJS(injected), null);
    assert.equal(page.swf2esPwned, undefined);
    host.callOut(
      '<invoke name="swf2esCapture" returntype="xml"><arguments><object>' +
        '<property id="a:(globalThis.swf2esPwned=1),b"><number>1</number></property>' +
        "</object></arguments></invoke>",
    );
    assert.equal(page.swf2esPwned, undefined);
    assert.deepEqual(got, [{ "a:(globalThis.swf2esPwned=1),b": 1 }]);
  } finally {
    delete page.swf2esCapture;
    delete page.swf2esPwned;
  }
});

test("a SWF's callback is the page's to call, its arguments and answer as XML", () => {
  const callbacks = new Map<string, ((...args: unknown[]) => unknown) | null>();
  const reported: unknown[] = [];
  const host = externalInterfaceHost(
    { objectID: null, callback: (name, call) => callbacks.set(name, call) },
    (error) => reported.push(error),
  );
  const requests: string[] = [];
  host.addCallback("sum", (request, args) => {
    assert.equal(args, null);
    requests.push(request);
    const { args: values } = readInvocation(request);
    return toXml({ sum: (values[0] as number) + (values[1] as number), echo: values[2] });
  });
  assert.deepEqual(callbacks.get("sum")?.(1, 2, { deep: [true] }), {
    sum: 3,
    echo: { deep: [true] },
  });
  assert.equal(requests.length, 1);

  host.addCallback("fails", () => {
    throw { as3: "error" };
  });
  assert.throws(() => callbacks.get("fails")?.(), ExternalInterfaceError);
  assert.deepEqual(reported, [{ as3: "error" }]);
  host.addCallback("marshalled", () => "<exception>Error: inside</exception>");
  assert.throws(() => callbacks.get("marshalled")?.(), /Error: inside/);

  host.addCallback("sum", null);
  assert.equal(callbacks.get("sum"), null);
});
