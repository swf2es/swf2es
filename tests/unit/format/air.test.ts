import assert from "node:assert/strict";
import { test } from "node:test";
import { readAirDescriptor, readZip, ZipError } from "@swf2es/format";
import { zip } from "../../zip-writer.ts";

const DESCRIPTOR = `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
    <id>org.example.app</id>
    <filename>App</filename>
    <!-- <content>Commented.swf</content> -->
    <initialWindow>
        <content>bin/Main.swf</content>
        <title>Tom &amp; Jerry&#39;s</title>
        <width>960</width>
        <height>550</height>
    </initialWindow>
</application>`;

test("a descriptor's id, and its first window's content, title and size", () => {
  assert.deepEqual(readAirDescriptor(DESCRIPTOR), {
    id: "org.example.app",
    content: "bin/Main.swf",
    title: "Tom & Jerry's",
    width: 960,
    height: 550,
  });
  // A size of nonsense is none; a content path written Windows' way is the URL's.
  assert.deepEqual(
    readAirDescriptor(
      "<application><id>a</id><initialWindow><content>sub\\Main.swf</content><width>-3</width></initialWindow></application>",
    ),
    { id: "a", content: "sub/Main.swf", title: null, width: null, height: null },
  );
  assert.throws(() => readAirDescriptor("<html/>"), /not an AIR application descriptor/);
  assert.throws(
    () =>
      readAirDescriptor(
        "<application><initialWindow><content>a.swf</content></initialWindow></application>",
      ),
    /no <id>/,
  );
  assert.throws(() => readAirDescriptor("<application><id>a</id></application>"), /no <content>/);
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("a ZIP's files read stored and deflated, with their sizes and times", () => {
  const entries = readZip(
    zip(
      [
        { name: "META-INF/AIR/application.xml", data: "<application/>", deflated: true },
        { name: "assets/", data: "" },
        { name: "assets/ünï.txt", data: "stored ".repeat(3) },
      ],
      "a comment, as packagers may leave",
    ),
  );
  assert.deepEqual(
    entries.map((e) => [e.name, e.size]),
    [
      ["META-INF/AIR/application.xml", 14],
      ["assets/", 0],
      ["assets/ünï.txt", 21],
    ],
  );
  assert.equal(text(entries[0].bytes()), "<application/>");
  assert.equal(text(entries[2].bytes()), "stored stored stored ");
  assert.equal(entries[0].modified, new Date(2026, 10, 7, 12, 34, 56).getTime());
});

test("what is no ZIP, or one cut short, is refused with a ZipError", () => {
  assert.throws(() => readZip(new TextEncoder().encode("not an archive at all")), ZipError);
  const whole = zip([{ name: "a.txt", data: "hello", deflated: true }]);
  // The directory's end found, the directory itself cut away.
  const cut = whole.slice(0, 10);
  assert.throws(() => readZip(cut), ZipError);
  const entries = readZip(whole);
  // A file whose data the archive no longer holds.
  const broken = whole.slice();
  new DataView(broken.buffer).setUint32(0, 0, true);
  assert.throws(() => readZip(broken)[0].bytes(), /no local header/);
  assert.equal(text(entries[0].bytes()), "hello");
});
