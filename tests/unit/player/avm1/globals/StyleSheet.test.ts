// TextField.StyleSheet in node: its styles, their TextFormats, and a
// field's HTML styled by it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchRequest } from "../../../../../packages/player/dist/hosts.js";
import { files, play, take } from "../network.ts";
import { traces } from "../text-fields.ts";

test("a StyleSheet keeps its styles and their TextFormats, and styles a field's HTML", async () => {
  assert.deepEqual(
    await traces([
      `var s = new TextField.StyleSheet();
trace(s.parseCSS(".red { color: #FF0000; font-size: 20px; }  p { text-align: center; }") + " " + s.getStyleNames());
trace(s.getStyle(".red").fontSize + " " + s._styles[".red"].size + " " + s._styles.p.align + " " + s.getStyle("none"));
var f = s.transform({fontWeight: "bold", marginLeft: "-4", kerning: "true"}); trace(f.bold + " " + f.leftMargin + " " + f.kerning + " " + s.transform());
t.styleSheet = s; t.htmlText = '<span class="red">a</span>';
trace(t.htmlText + " " + t.text + " " + t.getTextFormat(0).color + " " + t.getTextFormat(0).size);
t.styleSheet = _root; trace(t.styleSheet + " " + t.htmlText);`,
    ]),
    [
      "true p,.red",
      "20px 20 center null",
      "true 0 true null",
      '<span class="red">a</span> a 16711680 20',
      "undefined a",
    ],
  );
});

test("StyleSheet loads CSS between frames, preserves existing styles, and sends no HTTP status event", async () => {
  const asked: FetchRequest[] = [];
  const css = "\uFEFFp { color: #123456; font-size: 20px; }";
  const bytes = new TextEncoder().encode(css);
  const played = await play(
    `var s = new TextField.StyleSheet();
s.setStyle("old", {color: "#000001"});
s.onHTTPStatus = function (status) { trace("unexpected status " + status); };
s.onLoad = function (ok) {
  trace("load " + ok + " " + this.loaded + " " + this.getStyleNames());
  trace(this.getStyle("p").color + " " + this._styles.p.size + " " + this._bytesLoaded + "/" + this._bytesTotal);
};
trace(s.load() + " " + s.load("style.css") + " " + s.loaded + " " + s._bytesLoaded + "/" + s._bytesTotal);`,
    {
      url: "https://example.test/game/main.swf",
      fetch: files({ "style.css": bytes }, asked),
    },
  );

  assert.deepEqual(take(played), ["false true false 0/undefined"]);
  await played.deliver();
  assert.deepEqual(take(played), [
    "load true true p,old",
    `#123456 20 ${bytes.length}/${bytes.length}`,
  ]);
  assert.deepEqual(asked, [
    {
      url: "https://example.test/game/style.css",
      method: "GET",
      headers: [],
      body: null,
      purpose: "data",
    },
  ]);
});

test("StyleSheet reports empty, malformed and missing loads as failures without losing existing styles", async () => {
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("p { color:"), null]) {
    const played = await play(
      `var s = new TextField.StyleSheet(); s.setStyle("old", {color: "#000001"});
s.onLoad = function (ok) { trace(ok + " " + this.loaded + " " + this.getStyle("old").color); };
s.load("style.css");`,
      { fetch: async () => ({ bytes, status: bytes === null ? 404 : 200, headers: [] }) },
    );

    await played.deliver();
    assert.deepEqual(take(played), ["false false #000001"]);
  }
});

test("StyleSheet onData uses parse's return value and remains overridable, as in Flash", async () => {
  const played = await play(`var s = new TextField.StyleSheet();
s.onLoad = function (ok) { trace(ok + " " + typeof ok + " " + this.loaded); };
trace(s.loaded + " " + typeof s.onLoad + " " + typeof s.onData);
s.onData("p { color: #123456; }"); s.onData(""); s.onData(undefined);
ASSetPropFlags(TextField.StyleSheet.prototype, "parse", 0, 4);
s.parse = function (data) { trace("parse " + typeof data + " " + data); return 7; };
s.onData(false); s.onData(0); s.onData(null);`);

  assert.deepEqual(take(played), [
    "undefined function function",
    "true boolean true",
    "true boolean true",
    "false boolean false",
    "parse boolean false",
    "7 number 7",
    "parse number 0",
    "7 number 7",
    "false boolean false",
  ]);

  const custom = await play(
    `var s = new TextField.StyleSheet();
s.onData = function (data) { trace("data " + data + " " + this.loaded); };
s.onLoad = function (ok) { trace("unexpected load " + ok); };
s.load("style.css");`,
    { fetch: files({ "style.css": new TextEncoder().encode("p {}") }) },
  );

  await custom.deliver();
  assert.deepEqual(take(custom), ["data p {} false"]);
});

test("destroyed AVM1 players cancel stylesheet requests and deliver no callbacks", async () => {
  let signal: AbortSignal | undefined;
  let finish: ((value: { bytes: Uint8Array; status: number; headers: [] }) => void) | undefined;
  const played = await play(
    `var s = new TextField.StyleSheet();
s.onLoad = function (ok) { trace("unexpected load " + ok); }; s.load("style.css");`,
    {
      fetch: (_request, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  );

  played.player.destroy();
  assert.equal(signal?.aborted, true);
  finish?.({ bytes: new TextEncoder().encode("p {}"), status: 200, headers: [] });
  await played.deliver();
  assert.deepEqual(take(played), []);
});
