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

/** What playerglobal's call sends: the name as it is, unescaped, and its _argumentsToXML. */
const request = (name: string, args = "") =>
  `<invoke name="${name}" returntype="xml"><arguments>${args}</arguments></invoke>`;

/** An object whose key is code, as playerglobal writes it into XML: ids unescaped. */
const injected =
  '<object><property id="a:(globalThis.swf2esP1=1),b"><number>1</number></property></object>';

test("an invocation's name is read as playerglobal writes it, quotes and all", () => {
  assert.deepEqual(readInvocation(request('function(){return "x";}', "<string>a</string>")), {
    name: 'function(){return "x";}',
    args: ["a"],
  });
  // Data cannot move where the name ends.
  assert.deepEqual(
    readInvocation(request("f", "<string>&quot; returntype=&quot;xml&quot;&gt;</string>")).name,
    "f",
  );
  assert.throws(() => readInvocation("<invoke/>"));
  // The page's own invocations, for E4X's XML(), escape the name.
  assert.equal(
    invocation('say "hi"', ["x"]),
    '<invoke name="say &quot;hi&quot;" returntype="xml"><arguments><string>x</string></arguments></invoke>',
  );
});

test("every SWF call goes as XML: evalJS is always declined", () => {
  const host = externalInterfaceHost(
    { objectID: null, callback() {}, alive: () => true },
    () => {},
  );
  for (const source of [
    'try { __flash__toXML(hello("x")) ; } catch (e) { "<undefined/>"; }',
    'try { __flash__toXML(function(){ return 1; }()) ; } catch (e) { "<undefined/>"; }',
  ]) {
    assert.equal(host.evalJS(source), null);
  }
});

test("a SWF's call runs in the page, whatever form its name takes, its data never run", () => {
  const page = globalThis as Record<string, unknown>;
  const got: unknown[] = [];
  page.hello = (...args: unknown[]) => {
    got.push(args);
    return "hi";
  };
  page.swf2esSpace = {
    k: 2,
    fn(this: { k: number }, a: unknown) {
      return [this.k, a];
    },
  };
  page.swf2esLocation = { href: "http://page.test/" };
  page.swf2esTable = { fn: page.hello };
  page.swf2esThrows = () => {
    throw new Error("no");
  };
  try {
    const host = externalInterfaceHost(
      { objectID: null, callback() {}, alive: () => true },
      () => {},
    );
    const call = (name: string, args = "") => host.callOut(request(name, args));
    // Each form the reviewer found, with a key that is code: called, the key never run.
    for (const name of [
      "function (o){ return hello(o); }",
      "(function(o){ return hello(o); })",
      // Called without its object for `this`: only a path keeps it.
      "swf2esTable['fn']",
      " hello",
      "hello\n",
      "swf2esSpace.fn ",
      "hello//",
    ]) {
      got.length = 0;
      const answer = call(name, injected);
      assert.equal(page.swf2esP1, undefined, name);
      assert.notEqual(answer, "<undefined/>", name);
    }

    // Inline functions as SWFs write them, with no space before "(".
    assert.equal(
      call("function(){return swf2esLocation.href;}"),
      "<string>http://page.test/</string>",
    );
    assert.equal(
      call("function(a,b){return a+b;}", "<number>2</number><number>3</number>"),
      "<number>5</number>",
    );
    // A path, called on what holds it.
    assert.equal(
      call("swf2esSpace.fn", "<string>a</string>"),
      '<array><property id="0"><number>2</number></property><property id="1"><string>a</string></property></array>',
    );
    assert.equal(call("swf2esThrows"), "<undefined/>");
    assert.equal(call("not a name("), "<undefined/>");
    assert.equal(call("swf2esMissing.fn"), "<undefined/>");
    assert.equal(call("hello", "<string>unclosed"), "<undefined/>");
  } finally {
    for (const name of [
      "hello",
      "swf2esSpace",
      "swf2esLocation",
      "swf2esTable",
      "swf2esThrows",
      "swf2esP1",
    ]) {
      delete page[name];
    }
  }
});

test("a SWF's callback is the page's to call, its arguments and answer as XML", () => {
  const callbacks = new Map<string, ((...args: unknown[]) => unknown) | null>();
  let alive = true;
  const reported: unknown[] = [];
  const host = externalInterfaceHost(
    { objectID: null, callback: (name, call) => callbacks.set(name, call), alive: () => alive },
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

  // Kept by the page past its SWF: it does nothing, and reaches no SWF code.
  const kept = callbacks.get("sum");
  alive = false;
  requests.length = 0;
  assert.equal(kept?.(1, 2, null), undefined);
  assert.deepEqual(requests, []);

  host.addCallback("sum", null);
  assert.equal(callbacks.get("sum"), null);
});
