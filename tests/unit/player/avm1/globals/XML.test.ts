// XML and XMLNode in node: parseXML's statuses and trees, and toString's
// text, as adl gave them for the same scripts (written to a SharedObject,
// adl tracing nothing of AVM1); and a load through the host's fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { play, take } from "../network.ts";

test("parseXML's status, tree and text are Flash's for malformed and odd documents", async () => {
  const cases: [string, string][] = [
    ["<a><b></a>", "-9#1#<a><b /></a>"],
    ["<a>", "-9#1#<a />"],
    ["<!-- x", "-5#0#"],
    ["<![CDATA[x", "-2#0#"],
    ["<!DOCTYPE x", "-4#0#"],
    ["<?xml version='1.0'", "-3#0#"],
    ["<?pi x?><a/>", "-6#0#"],
    ["<a b=c>", "-6#0#"],
    ["<a b>", "-6#0#"],
    ["</a>", "-10#0#"],
    ["<a></b>", "-10#1#<a />"],
    ["<a b='1", "-8#0#"],
    ["<a", "-6#0#"],
    ["< a/>", "-6#0#"],
    ["<a b='1' b='2'/>", '0#1#<a b="1" />'],
    ["<a b='1'c='2'/>", '0#1#<a b="1" c="2" />'],
    ["<a></a >", "0#1#<a />"],
    ["<!x><a/>", "-9#1#<!x><a /></!x>"],
    ["<a>&&amp; &#x41; &#65; &#X41; &#0;</a>", "0#1#<a>&amp;&amp; A A &amp;#X41; </a>"],
    ["text<a/>tail", "0#3#text<a />tail"],
    ["<?XML version='1.0'?><a/>", "0#1#<?XML version='1.0'?><a />"],
    ["<!doctype a><a/>", "0#1#<!doctype a><a />"],
  ];
  const source = `
function st(s) { var x = new XML(s); trace(x.status + "#" + x.childNodes.length + "#" + x.toString()); }
${cases.map(([xml]) => `st(${JSON.stringify(xml)});`).join("\n")}`;
  const played = await play(source);

  assert.deepEqual(
    take(played),
    cases.map(([, expected]) => expected),
  );
});

test("XML's documents, nodes and their properties are Flash's", async () => {
  const played = await play(`
var u = new XML(undefined);
trace(u.childNodes.length + "[" + u + "]");
var d = new XML("<?xml version='1.0'?><!DOCTYPE a><a/>");
trace(d.xmlDecl + " " + d.docTypeDecl + " " + d);
var at = new XML("<a x='1' y='2' z='3'/>");
var ks = []; for (var k in at.firstChild.attributes) { ks.push(k); } trace(ks.join(","));
at.firstChild.attributes.w = 4;
trace(at + " " + at.firstChild.cloneNode(true));
var r = new XML("<p><x/><y/><z/></p><q/>");
var p = r.firstChild; var y = p.childNodes[1]; var kids = p.childNodes;
r.lastChild.appendChild(y);
trace(p.firstChild.nextSibling.nodeName + " " + kids.length + " " + y.previousSibling + " " + r);
var s = new XML("<a/>"); s.firstChild.appendChild(s.firstChild); s.firstChild.appendChild(s); trace(s);
var e = new XML("<a>x</a>");
e.firstChild.firstChild.nodeValue = "<&>'"; e.firstChild.attributes.k = '"';
trace(e);
var n = new XMLNode(1, "n");
trace(n + " " + n.nodeType + " " + new XMLNode(3).nodeValue + " " + new XMLNode().nodeType + " " + new XMLNode(8, "c"));
var w = new XML(" <a> <b/> </a> "); w.ignoreWhite = true; w.parseXML(" <a> <b/> </a> ");
trace(w + " " + w.firstChild.firstChild.parentNode.nodeName);
var ids = new XML("<a id='one'><b id='two'/></a>"); trace(ids.idMap.two.nodeName);
var ns = new XML("<r xmlns:f='urn:f'><f:a/></r>").firstChild.firstChild;
trace(ns.prefix + " " + ns.localName + " " + ns.namespaceURI + " " + ns.getPrefixForNamespace("urn:f"));
var keys = []; for (var k2 in new XMLSocket()) { keys.push(k2); } trace(keys.length);
`);

  assert.deepEqual(take(played), [
    "0[]",
    "<?xml version='1.0'?> <!DOCTYPE a> <?xml version='1.0'?><!DOCTYPE a><a />",
    "x,y,z",
    '<a w="4" x="1" y="2" z="3" /> <a w="4" x="1" y="2" z="3" />',
    "z 2 null <p><x /><z /></p><q><y /></q>",
    "<a />",
    '<a k="&quot;">&lt;&amp;&gt;&apos;</a>',
    "<n /> 1 undefined undefined c",
    "<a><b /></a> a",
    "b",
    "f a urn:f f",
    "0",
  ]);
});

test("load fetches the URL against the SWF's, then onData parses it and onLoad says so", async () => {
  const asked: string[] = [];
  const played = await play(
    `var x = new XML(); x.ignoreWhite = true;
x.onLoad = function (ok) { trace("load " + ok + " " + this.loaded + " " + this.firstChild.nodeName + " " + this.getBytesLoaded()); };
x.onHTTPStatus = function (s) { trace("status " + s); };
trace(x.load("data/a.xml") + " " + x.getBytesLoaded() + " " + x.getBytesTotal());
var post = new XML("<q/>"); var answer = new XML();
answer.onLoad = function (ok) { trace("answer " + ok); };
post.sendAndLoad("send.php", answer);
trace(x.load(null));`,
    {
      url: "http://example.test/games/test.swf",
      fetch: async (request) => {
        asked.push(
          `${request.method} ${request.url} ${request.body ? new TextDecoder().decode(request.body) : ""}`,
        );
        return request.method === "GET"
          ? { bytes: new TextEncoder().encode("<doc> <x/> </doc>"), status: 200, headers: [] }
          : { bytes: null, status: 404, headers: [] };
      },
    },
  );

  assert.deepEqual(take(played), ["true 0 undefined", "false"]);
  await played.deliver();
  assert.deepEqual(take(played), ["status 200", "load true true doc 17", "answer false"]);
  assert.deepEqual(asked, [
    "GET http://example.test/games/data/a.xml ",
    "POST http://example.test/games/send.php <q />",
  ]);
});

test("send goes as sendToURL does, and allowNetworking internal refuses it", async () => {
  const sent: string[] = [];
  const source = `trace(new XML("<a/>").send("log.php") + " " + new XML().send());`;
  const fetch = async (request: { method: string; url: string }) => {
    sent.push(`${request.method} ${request.url}`);
    return { bytes: null, status: 200, headers: [] };
  };

  const open = await play(source, { fetch });
  assert.deepEqual(take(open), ["true false"]);
  assert.deepEqual(sent.splice(0), ["POST file:///t/log.php"]);

  const internal = await play(source, { fetch, sendToUrl: false });
  assert.deepEqual(take(internal), ["false false"]);
  assert.deepEqual(sent, []);
});

test("a deep or a wide document parses, prints, clones and sends in linear time, without the stack", async () => {
  const n = 100_000;
  const deep = `${"<a>".repeat(n)}x${"</a>".repeat(n)}`;
  const wide = `<r>${"<b/>".repeat(n)}</r>`;
  const documents = [deep, wide];
  const sent: number[] = [];
  const played = await play(
    `var d = new XML(); var w = new XML();
d.onLoad = function (ok) {
  var c = this.cloneNode(true);
  trace(ok + " " + this.status + " " + this.toString().length + " " + c.toString().length);
  this.send("echo.php");
};
w.onLoad = function (ok) {
  var kids = this.firstChild.childNodes;
  trace(ok + " " + this.status + " " + kids.length + " " + this.toString().length);
  this.parseXML("<z/>");
  trace(kids.length + " " + this.firstChild.nodeName);
};
d.load("deep.xml"); w.load("wide.xml");`,
    {
      fetch: async (request) => {
        if (request.body) {
          sent.push(request.body.length);
          return { bytes: null, status: 200, headers: [] };
        }

        return { bytes: new TextEncoder().encode(documents.shift()), status: 0, headers: [] };
      },
    },
  );

  const started = performance.now();
  await played.deliver();
  const elapsed = performance.now() - started;

  const wideText = `<r>${"<b />".repeat(n)}</r>`.length;
  assert.deepEqual(take(played), [
    `true 0 ${deep.length} ${deep.length}`,
    `true 0 ${n} ${wideText}`,
    `${n} z`,
  ]);
  assert.deepEqual(sent, [deep.length]);
  assert.ok(elapsed < 5000, `${Math.round(elapsed)} ms`);
});
