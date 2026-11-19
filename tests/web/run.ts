// The web embedding in headless Chrome: a page with two <swf2es-player>s
// playing the player tests' SWFs and two Flash tags that replaceFlash
// swaps, one of them nested <object> and <embed>. It checks that each
// boots and draws, that the tags' parameters carry over, ExternalInterface
// both ways and its allowScriptAccess="never", that two players share one
// compile of codegen.wasm and one copy of the libraries and keep their
// modules in the configured IndexedDB cache, that the element
// follows its size and the device's pixels, and that destroy lets go of
// everything: 20 elements made and destroyed leave no player, codegen,
// socket or audio context alive, and the heap no larger than a bound.
// Last, Chrome's own Ctrl+C, X and V and a press reach a SWF's field and
// its Clipboard through the element's copy, cut and paste events, the
// mouse's events come in Flash's order, and touches as TouchEvents and as
// the mouse. Workers: on by default and sharing memory on this isolated
// page, off by the attribute or configure, from a script of another
// origin, and on a page that is not isolated passing messages, refusing
// to share memory, and their Web Workers let go after the last player.
// Under Chrome's autoplay rule, a SWF's held stream shows the unmute
// button and fires audioblocked, and a click on the button, which the SWF
// never hears, or on the stage, which it does, lets the stream play.
//
//   node tests/web/run.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flashAssembler, script } from "../avm1-script.ts";
import { bare, cases, scripted } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compareImages, decodePng, type Image } from "../player/image.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import { importMap, importMapSource } from "../player/serve.ts";
import * as w from "../swf-writer.ts";
import { zip } from "../zip-writer.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}out/`;
const site = `${out}site/`;
/** What 20 elements made and destroyed may leave on the heap, each: a tenth of a player's. */
const BOUND = 256 * 1024;
const CHURN = 20;

// This package's own copies: pnpm runs the player's tests at the same time.
libraryAbcs(`${out}libraries/`);
const abcs = compileScripts(
  [
    "Main",
    { name: "EmbedTest", source: readFileSync(`${here}scripts/EmbedTest.as`, "utf8") },
    { name: "TextLifecycle", source: readFileSync(`${here}scripts/TextLifecycle.as`, "utf8") },
    { name: "ClipboardTest", source: readFileSync(`${here}scripts/ClipboardTest.as`, "utf8") },
    { name: "TouchTest", source: readFileSync(`${here}scripts/TouchTest.as`, "utf8") },
    { name: "MarginsTest", source: readFileSync(`${here}scripts/MarginsTest.as`, "utf8") },
    { name: "ContextMenuTest", source: readFileSync(`${here}scripts/ContextMenuTest.as`, "utf8") },
    { name: "FocusRectTest", source: readFileSync(`${here}scripts/FocusRectTest.as`, "utf8") },
    {
      name: "ActivationTest",
      source: readFileSync(`${here}scripts/ActivationTest.as`, "utf8"),
    },
    {
      name: "StageQuality",
      source: readFileSync(`${here}../player/scripts/StageQuality.as`, "utf8"),
    },
    "WorkerBasics",
    "WorkerMutex",
    {
      name: "NativeBitmapTest",
      source: readFileSync(`${here}scripts/NativeBitmapTest.as`, "utf8"),
    },
    { name: "FullScreenTest", source: readFileSync(`${here}scripts/FullScreenTest.as`, "utf8") },
    { name: "AirWebTest", source: readFileSync(`${here}scripts/AirWebTest.as`, "utf8") },
    { name: "AirAloneTest", source: readFileSync(`${here}scripts/AirAloneTest.as`, "utf8") },
    { name: "UnmuteTest", source: readFileSync(`${here}scripts/UnmuteTest.as`, "utf8") },
    {
      name: "RelativeUrlsTest",
      source: readFileSync(`${here}scripts/RelativeUrlsTest.as`, "utf8"),
    },
  ],
  out,
);
mkdirSync(site, { recursive: true });
writeFileSync(
  `${site}native-bitmap-as3.swf`,
  bare(abcs.get("NativeBitmapTest") as Uint8Array, 1, "NativeBitmapTest", 16, 16),
);
writeFileSync(
  `${site}native-bitmap-avm1.swf`,
  w.swf({
    version: 8,
    width: 16,
    height: 16,
    frameCount: 1,
    tags: [
      w.doAction([
        ...script(
          `
    var source = new flash.display.BitmapData(16, 16, true, 0x80305070);
    source.setPixel32(8, 8, 0xffff4020);
    var dest = new flash.display.BitmapData(16, 16, true, 0);
    var f = new flash.filters.ConvolutionFilter(3, 3, [1,1,1,1,1,1,1,1,1], 9);
    dest.applyFilter(source, source.rectangle, new flash.geom.Point(0, 0), f);
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), f);
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), new flash.filters.BlurFilter(4, 4, 1));
    dest.applyFilter(dest, dest.rectangle, new flash.geom.Point(0, 0), new flash.filters.GlowFilter(0xff0000, 1, 4, 4, 2, 1));
    trace(dest.getPixel32(8, 8) + " " + dest.getPixel32(0, 0));
    this.attachBitmap(dest, 1);
    stop();
  `,
          8,
        )(flashAssembler())
          .end()
          .bytes(),
      ]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
// An AIR package, as adt writes one: its descriptor under META-INF/AIR, its
// content SWF and a file of its own at the root, the application's directory.
writeFileSync(
  `${site}air-app.air`,
  zip([
    {
      name: "META-INF/AIR/application.xml",
      data: `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>org.swf2es.web</id>
  <filename>AirWebTest</filename>
  <versionNumber>1.0</versionNumber>
  <initialWindow><content>bin/AirWebTest.swf</content><title>Air on the Web</title><width>240</width><height>160</height></initialWindow>
</application>`,
      deflated: true,
    },
    {
      name: "bin/AirWebTest.swf",
      data: w.swf({
        width: 100,
        height: 50,
        frameRate: 24,
        frameCount: 1,
        tags: [
          w.fileAttributes(true),
          w.doAbc(abcs.get("AirWebTest") as Uint8Array, "AirWebTest"),
          w.symbolClass([[0, "AirWebTest"]]),
          w.showFrame(),
          w.end(),
        ],
      }),
    },
    { name: "data/hello.txt", data: "hello from the package", deflated: true },
  ]),
);
// A SWF that names AIR's classes, served alone, with a file of its own beside it.
writeFileSync(
  `${site}air-alone.swf`,
  w.swf({
    width: 120,
    height: 80,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abcs.get("AirAloneTest") as Uint8Array, "AirAloneTest"),
      w.symbolClass([[0, "AirAloneTest"]]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
mkdirSync(`${site}data`, { recursive: true });
writeFileSync(`${site}data/hello.txt`, "hello from beside it");
writeFileSync(
  `${site}context-menu.swf`,
  bare(abcs.get("ContextMenuTest") as Uint8Array, 1, "ContextMenuTest", 200, 120),
);
writeFileSync(
  `${site}focus-as3.swf`,
  bare(abcs.get("FocusRectTest") as Uint8Array, 1, "FocusRectTest", 200, 120),
);
// The same in AS2, SWF 8: Tab goes to "clip" under its green square, to "kid" in "holder",
// to "off", whose _focusrect is false, and to "btn", a button whose hit area is its up state.
const focusBox = (id: number, color: number, size: [number, number]) =>
  w.shape({
    id,
    bounds: [0, size[0] * 20, 0, size[1] * 20],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [size[0] * 20, 0] },
          { line: [size[0] * 20, size[1] * 20] },
          { line: [0, size[1] * 20] },
          { line: [0, 0] },
        ],
      },
    ],
  });
const focusAvm1 = `clip.onRelease = function() {};
holder.kid.onRelease = function() {};
off.onRelease = function() {};
off._focusrect = false;
var EI = flash.external.ExternalInterface;
EI.addCallback("focusName", null, function() { return String(Selection.getFocus()); });
EI.addCallback("focusOn", null, function(name) { Selection.setFocus(eval(name)); });
EI.addCallback("stageFocusRect", null, function(on) { _root._focusrect = on; });
EI.addCallback("showHolder", null, function(on) { holder._visible = on; });
stop();`;
writeFileSync(
  `${site}focus-avm1.swf`,
  w.swf({
    version: 8,
    width: 200,
    height: 120,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      focusBox(1, 0x0000ff, [40, 30]),
      focusBox(2, 0x0000ff, [10, 10]),
      focusBox(3, 0x00ff00, [20, 20]),
      focusBox(4, 0xff0000, [40, 20]),
      w.sprite(10, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.sprite(11, 1, [w.place({ depth: 1, character: 2 }), w.showFrame(), w.end()]),
      w.sprite(12, 1, [w.place({ depth: 1, character: 11, name: "kid" }), w.showFrame(), w.end()]),
      w.button2Records(13, [{ states: 15, character: 4 }]),
      w.place({ depth: 1, character: 10, name: "clip", matrix: { tx: 400, ty: 400 } }),
      w.place({
        depth: 2,
        character: 12,
        name: "holder",
        matrix: { a: 2, d: 2, tx: 2000, ty: 400 },
      }),
      w.place({ depth: 3, character: 10, name: "off", matrix: { tx: 400, ty: 1400 } }),
      w.place({ depth: 4, character: 13, name: "btn", matrix: { tx: 2000, ty: 1400 } }),
      w.place({ depth: 5, character: 3, matrix: { tx: 200, ty: 500 } }),
      w.doAction([...script(focusAvm1, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(
  `${site}full-screen.swf`,
  bare(abcs.get("FullScreenTest") as Uint8Array, 1, "FullScreenTest", 200, 120),
);
const fillHoles = cases.find((c) => c.name === "fill-holes")?.swf as Uint8Array;
writeFileSync(`${site}shapes.swf`, fillHoles);
writeFileSync(
  `${site}fills.swf`,
  w.swf({
    width: 90,
    height: 50,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xffffff),
      ...[0xff0000, 0x00ff00, 0x0000ff].map((color, i) =>
        w.shape({
          id: i + 1,
          bounds: [0, 400, 0, 400],
          fills: [color],
          paths: [
            {
              fill1: 1,
              commands: [
                { move: [0, 0] },
                { line: [400, 0] },
                { line: [400, 400] },
                { line: [0, 400] },
                { line: [0, 0] },
              ],
            },
          ],
        }),
      ),
      ...[1, 2, 3].map((character) =>
        w.place({
          character,
          depth: character,
          matrix: { tx: ((character - 1) * 30 + 5) * 20, ty: 200 },
        }),
      ),
      w.showFrame(),
      w.end(),
    ],
  }),
);
// Buttons in SWFs with no code, AS3 and AVM1: up a red square at (10, 20), over and down a
// green one at (60, 20), where the hit test is too.
const square = (id: number, color: number) =>
  w.shape({
    id,
    bounds: [0, 400, 0, 400],
    fills: [color],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [400, 0] },
          { line: [400, 400] },
          { line: [0, 400] },
          { line: [0, 0] },
        ],
      },
    ],
  });
const scriptFreeButton = (as3: boolean) =>
  w.swf({
    version: as3 ? 10 : 8,
    width: 100,
    height: 60,
    frameCount: 1,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      square(2, 0x00ff00),
      w.button2Records(3, [
        { states: 1, character: 1, tx: 200, ty: 400 },
        { states: 6, character: 2, tx: 1200, ty: 400 },
        { states: 8, character: 1, tx: 1200, ty: 400 },
      ]),
      w.place({ character: 3, depth: 1 }),
      w.showFrame(),
      w.end(),
    ],
  });
// A stage with nothing on it, only its SetBackgroundColor, which Flash shows in that colour.
const emptyStage = (as3: boolean) =>
  w.swf({
    version: as3 ? 10 : 8,
    width: 100,
    height: 60,
    frameCount: 2,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0x3366cc),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
/**
 * A streamed tone on the root's frames, ten seconds of 440 Hz at 22 kHz in 8-bit PCM, a block a
 * frame: with no code at all, AVM1 or AS3, or the unmute SWF's.
 */
const streamedTone = (as3: boolean, code: boolean) => {
  const rate = 22050;
  const fps = 25;
  const block = rate / fps;
  const frames: Uint8Array[] = [];
  for (let f = 0; f < 10 * fps; f++) {
    const samples = new Uint8Array(block);
    for (let i = 0; i < block; i++) {
      samples[i] = 128 + Math.round(30 * Math.sin((2 * Math.PI * 440 * (f * block + i)) / rate));
    }

    frames.push(w.soundStreamBlock(samples), w.showFrame());
  }

  return w.swf({
    version: as3 ? 10 : 8,
    width: 200,
    height: 150,
    frameRate: fps,
    frameCount: 10 * fps,
    tags: [
      w.fileAttributes(as3),
      w.backgroundColor(0x204060),
      ...(code
        ? [
            w.doAbc(abcs.get("UnmuteTest") as Uint8Array, "UnmuteTest"),
            w.symbolClass([[0, "UnmuteTest"]]),
          ]
        : []),
      w.soundStreamHead({ rate: 2, samplesPerBlock: block }),
      ...frames,
      w.end(),
    ],
  });
};
writeFileSync(`${site}tone-avm1.swf`, streamedTone(false, false));
writeFileSync(`${site}tone-as3-bare.swf`, streamedTone(true, false));
writeFileSync(`${site}tone-as3.swf`, streamedTone(true, true));
writeFileSync(`${site}button-as3.swf`, scriptFreeButton(true));
writeFileSync(`${site}button-avm1.swf`, scriptFreeButton(false));
writeFileSync(`${site}empty-as3.swf`, emptyStage(true));
writeFileSync(`${site}empty-avm1.swf`, emptyStage(false));
writeFileSync(`${site}avm1.swf`, cases.find((c) => c.name === "avm1-hello")?.swf as Uint8Array);
writeFileSync(`${site}scripted.swf`, scripted(abcs.get("Main") as Uint8Array));
// An AS2 SWF that calls the page, tells it what came back, and takes its calls.
const external = `var EI = flash.external.ExternalInterface;
var got = EI.call("avm1Hello", "hi", [1, {k: "v"}]);
EI.call("avm1Hello", got.got[0] + "!", got.got[1][1].k);
// An inline function, its quotes and && sent as they are.
EI.call("avm1Hello", EI.call("function(a) { return a && a + \\"'\\"; }", "q"));
EI.addCallback("triple", null, function(n) { return {n: n * 3, s: "a<b"}; });
stop();`;
writeFileSync(
  `${site}avm1-external.swf`,
  w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.doAction([...script(external, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
// An AS2 SWF in sub/ that loads a child by a relative URL, which reports its _url and loads its
// sibling from the directory _url names, as old clients find their files.
const avm1Swf = (source: string) =>
  w.swf({
    version: 8,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
const report = `flash.external.ExternalInterface.call("report", _url);`;
mkdirSync(`${site}sub`, { recursive: true });
writeFileSync(
  `${site}sub/avm1-urls.swf`,
  avm1Swf(`createEmptyMovieClip("child", 1).loadMovie("avm1-url-child.swf");`),
);
writeFileSync(
  `${site}sub/as3-urls.swf`,
  bare(abcs.get("RelativeUrlsTest") as Uint8Array, 1, "RelativeUrlsTest", 20, 20),
);
for (const dir of ["", "sub/", "assets/"]) {
  mkdirSync(`${site}${dir}`, { recursive: true });
  writeFileSync(`${site}${dir}relative-url-data.txt`, `/web-test/${dir}`);
  writeFileSync(
    `${site}${dir}avm1-url-child.swf`,
    avm1Swf(`${report}
createEmptyMovieClip("sibling", 1).loadMovie(_url.substring(0, _url.lastIndexOf("/") + 1) + "avm1-url-sibling.swf");`),
  );
  writeFileSync(`${site}${dir}avm1-url-sibling.swf`, avm1Swf(report));
}
// An AS2 input field, as the clipboard SWF's for AS3, which the page focuses and reads.
const avm1Field = `_root.createTextField("field", 1, 0, 0, 140, 20);
field.type = "input";
field.border = true;
var log = [];
field.onChanged = function() { log.push("change " + field.text); };
var scrolls = [];
field.onScroller = function() { scrolls.push(field.hscroll + "/" + field.maxhscroll); };
var EI = flash.external.ExternalInterface;
EI.addCallback("focusField", null, function() { Selection.setFocus(field); });
EI.addCallback("blurField", null, function() { Selection.setFocus(null); });
EI.addCallback("text", null, function() { return field.text; });
EI.addCallback("fill", null, function(text, scroll) { field.text = text; field.hscroll = scroll; });
EI.addCallback("scrollState", null, function() { return field.hscroll + " " + field.maxhscroll + " " + Selection.getCaretIndex(); });
EI.addCallback("takeLog", null, function() { var taken = log; log = []; return taken; });
EI.addCallback("takeScrolls", null, function() { var taken = scrolls; scrolls = []; return taken; });
stop();`;
writeFileSync(
  `${site}avm1-field.swf`,
  w.swf({
    version: 8,
    width: 160,
    height: 120,
    frameCount: 1,
    tags: [
      w.doAction([...script(avm1Field, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
// AS2 buttons whose press's own onMouseDown changes what is under the pointer: "shown", hidden
// at (10, 20), is shown by it, and "gone", at (60, 20), hidden by it, as is "goneClip", a clip in
// button mode at (110, 20); "remade", a clip at (160, 20), goes by it to a frame that places its
// button again in its place, a new instance, which logs its transitions from its own actions.
const pressChanges = `var log = [];
shown._visible = false;
function watch(b, name) {
  var events = ["onPress", "onRelease", "onRollOver", "onRollOut", "onDragOver", "onDragOut"];
  for (var i = 0; i < events.length; i++) {
    b[events[i]] = (function (e) { return function () { log.push(name + " " + e); }; })(events[i]);
  }
}
watch(shown, "shown");
watch(gone, "gone");
watch(goneClip, "goneClip");
Mouse.addListener({ onMouseDown: function () {
  var x = _root._xmouse;
  if (x < 50) { shown._visible = true; } else if (x < 100) { gone._visible = false; } else if (x < 150) { goneClip._visible = false; } else { remade.gotoAndStop(3); }
} });
flash.external.ExternalInterface.addCallback("takeLog", null, function () { var taken = log; log = []; return taken; });
stop();`;
writeFileSync(
  `${site}avm1-press-changes.swf`,
  w.swf({
    version: 8,
    width: 200,
    height: 60,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.button2(2, 1),
      w.sprite(3, 1, [w.place({ character: 1, depth: 1 }), w.showFrame(), w.end()]),
      w.button2(
        4,
        1,
        (
          [
            [1 << 0, "onRollOver"],
            [1 << 1, "onRollOut"],
            [1 << 2, "onPress"],
            [1 << 3, "onRelease"],
            [1 << 4, "onDragOut"],
            [1 << 5, "onDragOver"],
          ] as const
        ).map(([conditions, name]) => ({
          conditions,
          actions: [
            ...script(`_root.log.push(_name + " ${name}");`, 8)(flashAssembler()).end().bytes(),
          ],
        })),
      ),
      w.sprite(5, 3, [
        w.place({ character: 4, depth: 1 }),
        w.doAction([...script("stop();", 8)(flashAssembler()).end().bytes()]),
        w.showFrame(),
        w.remove(1),
        w.showFrame(),
        w.place({ character: 4, depth: 1 }),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ character: 2, depth: 1, name: "shown", matrix: { tx: 200, ty: 400 } }),
      w.place({ character: 2, depth: 2, name: "gone", matrix: { tx: 1200, ty: 400 } }),
      w.place({ character: 3, depth: 3, name: "goneClip", matrix: { tx: 2200, ty: 400 } }),
      w.place({ character: 5, depth: 4, name: "remade", matrix: { tx: 3200, ty: 400 } }),
      w.doAction([...script(pressChanges, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(
  `${site}embed.swf`,
  bare(abcs.get("EmbedTest") as Uint8Array, 1, "EmbedTest", 160, 120),
);
writeFileSync(
  `${site}text.swf`,
  bare(abcs.get("TextLifecycle") as Uint8Array, 1, "TextLifecycle", 160, 120),
);
writeFileSync(
  `${site}clipboard.swf`,
  bare(abcs.get("ClipboardTest") as Uint8Array, 1, "ClipboardTest", 160, 120),
);
writeFileSync(
  `${site}quality.swf`,
  bare(abcs.get("StageQuality") as Uint8Array, 1, "StageQuality", 290, 60),
);
writeFileSync(
  `${site}touch.swf`,
  bare(abcs.get("TouchTest") as Uint8Array, 1, "TouchTest", 200, 100),
);
writeFileSync(
  `${site}margins.swf`,
  bare(abcs.get("MarginsTest") as Uint8Array, 1, "MarginsTest", 100, 100),
);
// The same on a frame that starts at (30, 20), not (0, 0).
writeFileSync(
  `${site}origin.swf`,
  w.swf({
    x: 30,
    y: 20,
    width: 100,
    height: 100,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abcs.get("MarginsTest") as Uint8Array, "MarginsTest"),
      w.symbolClass([[0, "MarginsTest"]]),
      w.showFrame(),
      w.end(),
    ],
  }),
);
writeFileSync(
  `${site}activation.swf`,
  bare(abcs.get("ActivationTest") as Uint8Array, 1, "ActivationTest", 100, 100),
);
// The player tests' worker cases, and the traces Flash gave them.
const workerCase = (name: string, script: string) =>
  (
    (cases.find((c) => c.name === name) as (typeof cases)[number]).swf as (
      abc: Uint8Array,
    ) => Uint8Array
  )(abcs.get(script) as Uint8Array);
const reference = (name: string) =>
  readFileSync(`${here}../player/references/${name}/trace.txt`, "utf8")
    .replace(/\n$/, "")
    .split(/\r|\n/);
writeFileSync(`${site}worker-basics.swf`, workerCase("worker-basics", "WorkerBasics"));
writeFileSync(`${site}worker-mutex.swf`, workerCase("worker-mutex", "WorkerMutex"));
// Played in real time, up to its terminate: its last steps count frames from the first, which
// may pass before a Web Worker has loaded, and trace its self-channel early then.
const basicsFull = reference("worker-basics");
const workerBasicsTrace = basicsFull.slice(0, basicsFull.indexOf("terminate again false") + 1);
/** A run's own traces: without the page's other players' frames, or an early self-channel line. */
const own = (traces: string[]) =>
  traces.filter((t) => !/^frame \d/.test(t) && !t.startsWith("self events "));
const workerMutexTrace = reference("worker-mutex");
// A page of no players of its own, for the workers on a page that is not isolated.
writeFileSync(
  `${site}workers.html`,
  `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body><script type="module" src="/web-src/page.ts"></script></body>
</html>`,
);
writeFileSync(
  `${site}fills-csp.html`,
  readFileSync(`${site}workers.html`, "utf8").replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self' ${importMapSource}; style-src 'unsafe-inline'; img-src 'self' data:">`,
  ),
);
writeFileSync(
  `${site}index.html`,
  `<!doctype html>
<html>
<head><meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
<style>body { margin: 0; background: #fff } swf2es-player, object { display: block }</style>
</head>
<body>
<swf2es-player id="shapes" src="/web-test/shapes.swf"></swf2es-player>
<swf2es-player id="scripted" src="/web-test/scripted.swf" scale="noScale" salign="TL"></swf2es-player>
<object id="movie" type="application/x-shockwave-flash" data="/web-test/embed.swf" width="160" height="120">
  <param name="FlashVars" value="greeting=hello%20there&amp;n=7">
  <param name="wmode" value="opaque">
  <param name="scale" value="exactfit">
  <param name="allowScriptAccess" value="always">
  <embed src="/web-test/embed.swf" name="movieEmbed" type="application/x-shockwave-flash" quality="low">
  <p>Get Flash Player</p>
</object>
<object id="locked" classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="160" height="120">
  <param name="movie" value="/web-test/embed.swf">
  <param name="allowScriptAccess" value="never">
  <p>Get Flash Player</p>
</object>
<script type="module" src="/web-src/page.ts"></script>
</body>
</html>`,
);

type Evaluate = <R>(expression: string) => Promise<{ value?: R; exception: string | null }>;
type Send = <R>(method: string, params?: object) => Promise<R>;

const call = async <R>(evaluate: Evaluate, expression: string): Promise<R> => {
  const { value, exception } = await evaluate<R>(expression);
  if (exception !== null || value === undefined) {
    throw new Error(`${expression}: ${exception ?? "no answer"}`);
  }

  return value;
};

interface Booted {
  id: string;
  error: string | null;
  attributes: Record<string, string>;
  rect: [number, number, number, number];
  canvas: [number, number] | null;
  canvasCss: [string, string] | null;
}

/** The colours in a CSS-pixel rectangle of a screenshot taken at `scale` device pixels a CSS pixel. */
function colours(image: Image, [x, y, w, h]: number[], scale: number): Map<number, number> {
  const found = new Map<number, number>();
  for (let py = Math.ceil(y * scale); py < Math.floor((y + h) * scale); py++) {
    for (let px = Math.ceil(x * scale); px < Math.floor((x + w) * scale); px++) {
      const i = (py * image.width + px) * 4;
      const rgb = (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
      found.set(rgb, (found.get(rgb) ?? 0) + 1);
    }
  }

  return found;
}

const checks: [string, (evaluate: Evaluate, send: Send) => Promise<void>][] = [];
const boundTextureWarnings: string[] = [];
const check = (name: string, run: (evaluate: Evaluate, send: Send) => Promise<void>) =>
  checks.push([name, run]);

let booted: Booted[] = [];
const byId = (id: string) => booted.find((b) => b.id === id) as Booted;

check("file dialogs select and read real browser Files", async (evaluate, send) => {
  const filePath = `${out}chosen.txt`;
  writeFileSync(filePath, Uint8Array.of(65, 0, 255));
  await call(
    evaluate,
    `(async () => {
    window.fileDialogHost = (await import("@swf2es/player")).browserFileHost();
    window.fileDialogAbort = new AbortController();
    return true;
  })()`,
  );
  const denied = await call<unknown[]>(
    evaluate,
    "fileDialogHost.browse([], false, fileDialogAbort.signal)",
  );
  assert.deepEqual(denied, []);
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  try {
    const started = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
      expression: `window.fileDialogResult = fileDialogHost.browse([{description:"Text", extension:"*.txt"}], true, fileDialogAbort.signal).then(async files => ({ name: files[0].name, size: files[0].size, bytes: Array.from(await files[0].read(fileDialogAbort.signal)) }))`,
      userGesture: true,
    });
    assert.equal(started.exceptionDetails, undefined);
    const { root } = await send<{ root: { nodeId: number } }>("DOM.getDocument");
    const { nodeId } = await send<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type=file]",
    });
    assert.ok(nodeId);
    assert.equal(await call(evaluate, 'document.querySelector("input[type=file]").accept'), ".txt");
    await send("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    assert.deepEqual(await call(evaluate, "fileDialogResult"), {
      name: "chosen.txt",
      size: 3,
      bytes: [65, 0, 255],
    });
    assert.equal(await call(evaluate, 'document.querySelectorAll("input[type=file]").length'), 0);
  } finally {
    await send("Page.setInterceptFileChooserDialog", { enabled: false });
    await call(evaluate, "fileDialogAbort.abort(); true");
  }
});

check("each element boots and draws", async (evaluate, send) => {
  booted = await call<Booted[]>(evaluate, "booted()");
  assert.deepEqual(
    booted.map((b) => [b.id, b.error]),
    [
      ["shapes", null],
      ["scripted", null],
      ["movie", null],
      ["locked", null],
    ],
  );
  const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const image = decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
  const dominant = (id: string) =>
    [...colours(image, byId(id).rect, 2).entries()].sort((a, b) => b[1] - a[1])[0][0];
  // The shapes' fills, the scripted SWF's red box, and each EmbedTest's colour, edge to edge.
  assert.ok(colours(image, byId("shapes").rect, 2).size > 1, "shapes drew nothing");
  assert.ok(colours(image, byId("scripted").rect, 2).has(0xff0000), "no red box");
  assert.equal(dominant("movie").toString(16), "ff");
  assert.equal(dominant("locked").toString(16), "ff00");
  // The SWF's own stage size where the page gives none; Flash's tag's where it does.
  assert.deepEqual(byId("shapes").rect.slice(2), [200, 60]);
  assert.deepEqual(byId("scripted").rect.slice(2), [200, 100]);
  assert.deepEqual(byId("movie").rect.slice(2), [160, 120]);
  // Drawn at the device's pixels: two a CSS pixel here.
  assert.deepEqual(byId("shapes").canvas, [400, 120]);
});

interface WorkerRun {
  traces: string[];
  errors: string[];
  made: number;
}

check(
  "workers: on by default, sharing memory on this isolated page, off by attribute or configure",
  async (evaluate) => {
    // None of the page's SWFs names a worker: none was started ahead for them.
    assert.equal((await call<{ made: number }>(evaluate, "webWorkers()")).made, 0);

    const mutex = await call<WorkerRun>(
      evaluate,
      `workerRun("/web-test/worker-mutex.swf", {}, {}, "free true")`,
    );
    assert.deepEqual(mutex.errors, []);
    assert.deepEqual(own(mutex.traces), workerMutexTrace);
    assert.ok(mutex.made >= 2, `${mutex.made} Web Workers for two workers`);

    const off = `workerRun("/web-test/worker-basics.swf"`;
    for (const run of [
      `${off}, { workers: "false" }, {}, "supported false false")`,
      `${off}, {}, { workers: false }, "supported false false")`,
    ]) {
      const r = await call<WorkerRun>(evaluate, run);
      assert.equal(own(r.traces)[0], "supported false false", run);
      assert.equal(r.made, 0, run);
    }

    const on = await call<WorkerRun>(
      evaluate,
      `${off}, { workers: "true" }, { workers: false }, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
    );
    assert.deepEqual(on.errors, []);
    assert.deepEqual(own(on.traces), workerBasicsTrace);
  },
);

check(
  "a worker script from another origin, as a CDN's, starts through a module of the page's",
  async (evaluate) => {
    // The same server under another name: another origin, which serves the script with CORS.
    const r = await call<WorkerRun>(
      evaluate,
      `workerRun("/web-test/worker-basics.swf", {}, { workerUrl: "http://localhost:" + location.port + "/player-hosts/thread/player-hosts/web-worker.js" }, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(own(r.traces), workerBasicsTrace);
  },
);

check(
  "the quality attribute draws aliased and unsmoothed at low, while it plays",
  async (evaluate, send) => {
    boundTextureWarnings.length = 0;
    const shown = async (rect: number[]) => {
      const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      const image = decodePng(new Uint8Array(Buffer.from(shot.data, "base64")));
      return colours(image, rect, 2).size;
    };
    const rect = await call<number[]>(evaluate, 'requality("high", "/web-test/quality.swf")');
    const high = await shown(rect);
    await call(evaluate, 'requality("low")');
    const low = await shown(rect);
    await call(evaluate, 'requality("high")');
    // Edges and smoothed bitmaps blend colours at high quality; at low, the fills' and texels' alone.
    assert.ok(low * 4 < high, `${low} colours at low, ${high} at high`);
    assert.equal(await shown(rect), high);
    // Flash's medium covers an edge with 4 samples, high with 16: high, with as many as the
    // GPU allows, shades the edges more finely where it allows more than 4.
    await call(evaluate, 'requality("medium")');
    const medium = await shown(rect);
    await call(evaluate, 'requality("high")');
    const most = await call<number>(
      evaluate,
      `(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const most = gl?.getParameter(gl.MAX_SAMPLES) ?? 0;
        // A context let go of at once, not left to count against the page's.
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        return most;
      })()`,
    );
    if (most > 4) {
      assert.ok(medium < high, `${medium} colours at medium, ${high} at high (${most} samples)`);
    }
    await call(evaluate, 'requality("high", "/web-test/shapes.swf")');
    assert.deepEqual(
      boundTextureWarnings,
      [],
      "quality changes or replacement destroyed a bound texture",
    );
  },
);

check("replaceFlash swaps each Flash tag once, its parameters carried over", async (evaluate) => {
  const r = await call<Record<string, unknown>>(evaluate, "replacement()");
  assert.deepEqual(r, { replaced: ["movie", "locked"], objects: 0, fallback: false, players: 4 });
  assert.deepEqual(byId("movie").attributes, {
    src: "/web-test/embed.swf",
    flashvars: "greeting=hello%20there&n=7",
    wmode: "opaque",
    scale: "exactfit",
    allowscriptaccess: "always",
    // What the <object> left out, its <embed> gave.
    quality: "low",
    id: "movie",
    name: "movieEmbed",
    width: "160",
    height: "120",
    tabindex: "0",
  });
  assert.equal(byId("locked").attributes.src, "/web-test/embed.swf");
  assert.equal(byId("locked").attributes.allowscriptaccess, "never");
});

check(
  "ExternalInterface both ways, safe from keys and names, none where allowScriptAccess is never",
  async (evaluate) => {
    const ei = await call<{
      calls: { hello: unknown[][]; reports: Record<string, unknown>[]; captured: unknown[] };
      shadowed: string[];
      attribute: string;
      pwned: boolean;
      echo: unknown;
      add: unknown;
      failed: string;
      lockedCallbacks: string[];
    }>(evaluate, "externalInterface()");
    // The SWF called pageHello once, the locked one never, and reported what it got.
    assert.deepEqual(ei.calls.hello, [["hi", [1, 2], { k: "v", d: "1970-01-01T00:00:00.005Z" }]]);
    assert.deepEqual(ei.calls.reports, [
      {
        objectID: "movie",
        hello: { got: ["hi", [1, 2], { k: "v", d: "1970-01-01T00:00:00.005Z" }] },
        inline: 42,
        href: ei.calls.reports[0]?.href,
        sum: 5,
        greeting: "hello there",
        n: "7",
      },
    ]);
    assert.deepEqual(ei.echo, { got: [1, { a: "b" }, "x<y"], n: 42 });
    assert.equal(ei.add, 5);
    assert.match(ei.failed, /Error calling method on NPObject: fail/);
    assert.deepEqual(ei.lockedCallbacks, []);
    assert.deepEqual(ei.shadowed, []);
    assert.equal(ei.attribute, "movie");
    assert.equal(ei.pwned, false);
    // window.location.href, through an inline function with no space before "(".
    assert.match(String(ei.calls.reports[0]?.href), /\/web-test\/index\.html(\?[a-z&]+)?$/);
    assert.deepEqual(ei.calls.captured, [
      { "a:(window.swf2esPwned=1),b": 1 },
      { "a:(window.swf2esPwned=1),b": 1 },
    ]);
  },
);

check(
  "two players share one compile of codegen.wasm and one copy of the libraries",
  async (evaluate) => {
    const counts = await call<Record<string, number>>(evaluate, "webCounts()");
    assert.equal(counts.codegenFetches, 1);
    assert.equal(counts.codegenCompiles, 1);
    // None but Flash Player's playerglobal where the page is given it in place of the package's.
    assert.equal(counts.libraryFetches, process.env.SWF2ES_PLAYERGLOBAL === "adobe" ? 1 : 0);
  },
);

check("with cache, the players keep their modules in IndexedDB", async (evaluate) => {
  assert.ok((await call<string[]>(evaluate, "databases()")).includes("swf2es-modules"));
});

check("the element follows its size and the device's pixels", async (evaluate) => {
  const r = await call<{ dpr: number; canvas: number[]; css: string[] }>(evaluate, "resize()");
  // exactFit to 320 by 120, twice as wide: drawn as fine as that axis needs, twice that for the device.
  assert.deepEqual(r, { dpr: 2, canvas: [640, 480], css: ["320px", "120px"] });
});

check("an AIR package plays as adl runs it, its files read from memory", async (evaluate) => {
  const r = await call<{
    traces: string[];
    errors: string[];
    exit: number | null;
    playing: boolean;
  }>(evaluate, "airRun(true)");
  assert.deepEqual(r.errors, []);
  // What it traces at once, in order; then what arrives on later frames, in any.
  assert.deepEqual(r.traces.slice(0, 12), [
    "air: url app:/bin/AirWebTest.swf",
    "air: sandbox application",
    "air: id org.swf2es.web",
    "air: window Air on the Web 240x160",
    "air: screen true true 1 1",
    "air: invoke one|two words true",
    "air: files true 22 false true true",
    "air: listing META-INF,bin,data",
    "air: stream hello from the package",
    "air: items 0",
    "air: saved 0",
    // In the cache directory of its files in IndexedDB.
    "air: temp temporary true /cache true 0 true true",
  ]);
  assert.deepEqual(r.traces.slice(12, -1).sort(), [
    "air: app hello from the package",
    "air: async stream hello from the package",
    "air: file hello from the package",
    "air: missing refused",
    "air: storage 1",
  ]);
  assert.equal(r.traces.at(-1), "air: exit");
  // NativeApplication.exit stopped it, and the page heard the code.
  assert.equal(r.exit, 3);
  assert.equal(r.playing, false);
});

check("an AIR application finds what it wrote and kept when it plays again", async (evaluate) => {
  const r = await call<{ traces: string[]; errors: string[]; exit: number | null }>(
    evaluate,
    "airRun()",
  );
  assert.deepEqual(r.errors, []);
  // Its files and item from the last play, read back from IndexedDB.
  assert.ok(r.traces.includes("air: items 1"), r.traces.join("\n"));
  assert.ok(r.traces.includes("air: saved 1"), r.traces.join("\n"));
  assert.ok(r.traces.includes("air: storage 2"), r.traces.join("\n"));
  // With the network this time: the server's 404 and its body, as AIR gives an application an
  // error's response, a load that completes where it listens for the response and fails without.
  for (const line of [
    "air: gone status 404",
    "air: gone not found",
    "air: gone unheard refused not found",
  ]) {
    assert.ok(r.traces.includes(line), `${line}\n${r.traces.join("\n")}`);
  }
  assert.equal(r.exit, 3);
});

check("a SWF that names AIR's classes plays alone as an AIR application", async (evaluate) => {
  const r = await call<{ traces: string[]; errors: string[]; exit: number | null }>(
    evaluate,
    "airAloneRun()",
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.traces, [
    "alone: url app:/air-alone.swf",
    "alone: sandbox application",
    "alone: id swf2es.air-alone",
    "alone: title air-alone",
    "alone: listing air-alone.swf",
    "alone: beside hello from beside it",
    // The server's 404 for a file of its own is no file, not that error's body.
    "alone: no file refused ",
  ]);
  assert.equal(r.exit, 5);
});

check("an embedder's fetch loads the SWF, asked for as the movie", async (evaluate) => {
  assert.deepEqual(await call(evaluate, "embedderFetch()"), {
    asked: [["/web-test/shapes.swf", "movie"]],
    played: true,
  });
});

check("watchFlash replaces the Flash tags the page adds or makes Flash later", async (evaluate) => {
  assert.deepEqual(await call(evaluate, "watched()"), {
    before: "embed",
    tag: "swf2es-player",
    playing: true,
  });
});

check("a SWF plays on while the page gets no animation frames", async (evaluate) => {
  // A minimized window's page gets none: a timer plays the frames, drawing nothing.
  const r = await call<{ played: number; rate: number }>(evaluate, "playsUnframed()");
  assert.ok(r.played >= r.rate / 2, `played ${r.played} frames in a second at ${r.rate} fps`);
});

check(
  "a frame listener hears each animation frame's work, and costs nothing unset",
  async (evaluate) => {
    const r = await call<{
      heard: {
        time: number;
        frames: number;
        frameRate: number;
        play: number;
        draw: number;
        drew: boolean;
        shown: boolean;
      }[];
      same: boolean;
      after: number;
      rate: number;
      off: boolean;
      on: boolean;
      memory: { codegen: number; native: number };
    }>(evaluate, "frameStats()");
    // About a second's animation frames, each one object filled anew.
    // At least a slow display's, as a loaded machine's software GL may give.
    assert.ok(r.heard.length >= 10, `${r.heard.length} calls in a second`);
    assert.ok(r.same, "a new object for a call");
    let played = 0;
    for (let i = 0; i < r.heard.length; i++) {
      const s = r.heard[i];
      assert.ok(i === 0 || s.time >= r.heard[i - 1].time, `time went back at ${i}`);
      assert.ok(Number.isInteger(s.frames) && s.frames >= 0, `frames ${s.frames}`);
      assert.equal(s.frameRate, r.rate);
      assert.ok(Number.isFinite(s.play) && s.play >= 0 && s.play < 1000, `play ${s.play}`);
      assert.ok(Number.isFinite(s.draw) && s.draw >= 0 && s.draw < 1000, `draw ${s.draw}`);
      assert.ok(s.drew || s.draw === 0, `${s.draw} ms drawing what was not drawn`);
      // A stall of a quarter second, as a loaded machine may give, has the timer play a call,
      // which never draws.
      assert.ok(s.shown || (!s.drew && s.draw === 0), `a timer's call at ${i} drew`);
      played += s.frames;
    }
    const span = (r.heard.at(-1)?.time ?? 0) - r.heard[0].time;
    const expected = (span / 1000) * r.rate;
    assert.ok(
      played >= expected * 0.5 && played <= expected + 2,
      `${played} frames in ${span.toFixed(0)} ms at ${r.rate} fps`,
    );
    assert.ok(
      r.heard.filter((s) => s.shown).length >= r.heard.length / 2,
      "most calls came by the timer, not animation frames",
    );
    assert.ok(
      r.heard.some((s) => s.drew),
      "no call drew",
    );
    // Unset, nothing is told, and the loop has no hook to measure for.
    assert.equal(r.after, 0);
    assert.deepEqual([r.off, r.on], [false, true]);
    assert.ok(r.memory.codegen > 0 && r.memory.native > 0, JSON.stringify(r.memory));
  },
);

check("destroy takes the callbacks off and closes the socket and the audio", async (evaluate) => {
  const before = await call<Record<string, number>>(evaluate, "webCounts()");
  const r = await call<{
    callbacks: string[];
    player: boolean;
    destroyed: boolean;
    kept: boolean;
    awaited: boolean;
    counts: Record<string, number>;
  }>(evaluate, "destroyMovie()");
  assert.deepEqual(r.callbacks, []);
  assert.ok(r.awaited, "the element was a thenable");
  assert.ok(r.kept, "a callback kept past destroy still ran the SWF's code");
  assert.ok(r.player && r.destroyed);
  // Each EmbedTest opened a socket and its sound made an audio context; the movie's are gone.
  assert.equal(before.openSockets, 2);
  assert.equal(r.counts.openSockets, 1);
  assert.equal(r.counts.openAudio, before.openAudio - 1);
});

// Before the checks that count the compilers left, which then hold its AVM1 movies, which call
// functions and load others, to letting theirs go: the last object a CallFunction found kept
// its movie's compiler alive (releaseFound), as whatever AVM1 ran last before a count did.
check(
  'relative URLs resolve against the page, base against it but ".", the SWF\'s own with relativeurls="movie"',
  async (evaluate) => {
    const loads = async (
      src: string,
      attributes: Record<string, string>,
      n: number,
      page?: string,
      suffix?: string,
    ) =>
      (
        await call<string[]>(
          evaluate,
          `relativeLoads(${[src, attributes, n, page ?? null, suffix ?? null].map((v) => JSON.stringify(v)).join(", ")})`,
        )
      ).map((url) => (url.startsWith("as3 ") ? url : new URL(url).pathname));
    const avm1 = (attributes: Record<string, string>, page?: string, suffix?: string) =>
      loads("/web-test/sub/avm1-urls.swf", attributes, 2, page, suffix);
    const as3 = (attributes: Record<string, string>, page?: string, suffix?: string) =>
      loads("/web-test/sub/as3-urls.swf", attributes, 1, page, suffix);
    // The page is /web-test/index.html and the SWFs are in /web-test/sub/. As Flash's plug-in
    // (PepperFlash 32) resolved them, AS3's and AVM1's alike: against the page, or its base, "."
    // the SWF's directory and any other value against the page. Each AVM1 child's _url is where
    // it came from, which its sibling's load follows.
    const pair = (dir: string) => [`${dir}avm1-url-child.swf`, `${dir}avm1-url-sibling.swf`];
    assert.deepEqual(await avm1({}), pair("/web-test/"));
    assert.deepEqual(await avm1({ base: "." }), pair("/web-test/sub/"));
    assert.deepEqual(await avm1({ base: "assets/" }), pair("/web-test/assets/"));
    assert.deepEqual(await avm1({ relativeurls: "movie" }), pair("/web-test/sub/"));
    assert.deepEqual(await as3({}), ["as3 /web-test/"]);
    assert.deepEqual(await as3({ base: "." }), ["as3 /web-test/sub/"]);
    assert.deepEqual(await as3({ base: "assets/" }), ["as3 /web-test/assets/"]);
    assert.deepEqual(await as3({ relativeurls: "movie" }), ["as3 /web-test/sub/"]);
    // A page URL's query and fragment are no directory.
    assert.deepEqual(await avm1({}, undefined, "?x=/a/b#/c/d"), pair("/web-test/"));
    assert.deepEqual(await as3({}, undefined, "?x=/a/b#/c/d"), ["as3 /web-test/"]);
    // The page's choice for elements that make none, which the attribute overrides.
    assert.deepEqual(await avm1({}, "movie"), pair("/web-test/sub/"));
    assert.deepEqual(await as3({}, "movie"), ["as3 /web-test/sub/"]);
    assert.deepEqual(await as3({ relativeurls: "page" }, "movie"), ["as3 /web-test/"]);
  },
);

/** Ctrl and a letter, as a user presses it, with the editing command Chrome runs for it, if any. */
async function ctrl(send: Send, letter: string, command?: string) {
  const key = {
    modifiers: 2,
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
  };
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...key,
    ...(command ? { commands: [command] } : {}),
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

check(`${CHURN} elements made and destroyed leave nothing behind`, async (evaluate, send) => {
  const heap = async () => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    return (await send<{ usedSize: number }>("Runtime.getHeapUsage")).usedSize;
  };
  await call(evaluate, "churn(5)");
  const warm = await heap();
  const counts = await call<Record<string, number>>(evaluate, `churn(${CHURN})`);
  const after = await heap();
  const left = await call<{ players: number; codegens: number; counts: Record<string, number> }>(
    evaluate,
    "survivors()",
  );
  console.log(
    `  heap ${(warm / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB after ${CHURN} more`,
  );
  assert.equal(counts.socketsMade, 2 + 5 + CHURN);
  assert.equal(left.counts.openSockets, 1, "the locked SWF's alone");
  assert.equal(left.counts.openAudio, left.counts.audioMade - 1 - 5 - CHURN);
  assert.equal(left.players, 0, "a destroyed player is still alive");
  // The scripted and locked players' instances alone.
  assert.equal(left.codegens, 2);
  assert.ok(after - warm < BOUND * CHURN, `the heap grew by ${after - warm} bytes`);
});

check("device font measurement caches let go of destroyed players", async (evaluate, send) => {
  await call(evaluate, 'churn(5, "text.swf")');
  await send("HeapProfiler.collectGarbage");
  await send("HeapProfiler.collectGarbage");
  const left = await call<{ players: number; codegens: number; textScenes: number }>(
    evaluate,
    "survivors()",
  );
  assert.equal(left.textScenes, 0, "a text measurement retained its player's scene");
  assert.equal(left.players, 0, "a text measurement retained its player's scene");
  assert.equal(left.codegens, 2);
});

check("an AVM1 SWF's ExternalInterface calls the page and takes its calls", async (evaluate) => {
  const ei = await call<{ calls: unknown[][]; triple: unknown; never: boolean }>(
    evaluate,
    "avm1External()",
  );
  // The SWF under allowScriptAccess="never" called nothing and added no callback.
  assert.deepEqual(ei.calls, [["hi", [1, { k: "v" }]], ["hi!", "v"], ["q'"]]);
  assert.deepEqual(ei.triple, { n: 15, s: "a<b" });
  assert.equal(ei.never, false);
});

check(
  "an AVM1 SWF's actions run, and its players and compilers go with them",
  async (evaluate, send) => {
    const stopped = await call<number>(evaluate, "avm1Churn(5)");
    assert.equal(stopped, 5, "the actions' stop held the root on frame 2");
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const left = await call<{ players: number; codegens: number }>(evaluate, "survivors()");
    assert.equal(left.players, 0, "a destroyed AVM1 player is still alive");
    assert.equal(left.codegens, 2);
  },
);

check(
  "Ctrl+C, X and V and a press use the clipboard, as Flash Player did",
  async (evaluate, send) => {
    type State = { log: string[]; text: string; copied: string | null; seed: string };
    const state = () => call<State>(evaluate, "clipState()");
    const [left, top] = await call<[number, number]>(evaluate, "clipboardPlayer()");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });

    // The page's own copy puts two lines on the clipboard; pasted into the
    // single-line field, they lose the line break, a TextEvent and a change.
    await call(evaluate, `seedFocus("two\\nlines")`);
    await ctrl(send, "c", "copy");
    await call(evaluate, `clipFocus("Field")`);
    await ctrl(send, "v", "paste");
    assert.deepEqual(await state(), {
      log: ["textInput twolines", "change twolines"],
      text: "twolines",
      // The page's own copy, whose data the browser fills in after the event.
      copied: "",
      seed: "two\nlines",
    });

    // Ctrl+A selects the field's text, Ctrl+X cuts it to the clipboard.
    await ctrl(send, "a", "selectAll");
    await ctrl(send, "x", "cut");
    assert.deepEqual(await state(), {
      log: ["change "],
      text: "",
      copied: null,
      seed: "two\nlines",
    });
    await call(evaluate, `seedFocus("")`);
    await ctrl(send, "v", "paste");
    assert.equal((await state()).seed, "twolines");

    // The box hears copy, paste and selectAll, and writes and reads the clipboard in them.
    await call(evaluate, `clipFocus("Box")`);
    await ctrl(send, "c", "copy");
    await ctrl(send, "v", "paste");
    await ctrl(send, "a", "selectAll");
    assert.deepEqual(await state(), {
      log: ["copy", "paste copied by the box", "selectAll"],
      text: "",
      copied: "copied by the box",
      seed: "twolines",
    });

    // A press on the stage writes the clipboard with System.setClipboard, through the async API.
    const at = { x: left + 100, y: top + 100, button: "left", clickCount: 1 };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    // The write is a promise the page settles later: paste until it lands, or give up.
    let pressed = await state();
    const log = pressed.log;
    for (let i = 0; i < 20 && pressed.seed !== "set on a press"; i++) {
      await new Promise((done) => setTimeout(done, 50));
      await call(evaluate, `seedFocus("")`);
      await ctrl(send, "v", "paste");
      pressed = await state();
    }

    assert.deepEqual([log, pressed.seed], [["press"], "set on a press"]);
    await call(evaluate, "clipDestroy()");
  },
);

for (const [vm, src] of [
  ["AS3", "/web-test/clipboard.swf"],
  ["AVM1", "/web-test/avm1-field.swf"],
]) {
  check(
    `an IME's or a soft keyboard's text reaches an ${vm} input field once, as typed keys do`,
    async (evaluate, send) => {
      type State = { log: string[]; text: string };
      const state = () => call<State>(evaluate, "imeState()");
      // AS3's field hears a TextEvent for what was inserted, then its change; AS2's its change.
      const typed = (text: string, inserted: string) =>
        vm === "AS3" ? [`textInput ${inserted}`, `change ${text}`] : [`change ${text}`];
      const key = async (type: string) =>
        send("Input.dispatchKeyEvent", {
          type,
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          ...(type === "keyDown" ? { text: "a" } : {}),
        });
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const focused = await call(evaluate, `imePlayer(${JSON.stringify(src)})`);
      try {
        // Text inserted with no key, as an IME's commit or a soft keyboard's word.
        await send("Input.insertText", { text: "日本語" });
        assert.deepEqual(await state(), { log: typed("日本語", "日本語"), text: "日本語" });
        // The field focused, the player's hidden textarea took the page's focus, where an IME types.
        assert.equal(focused, "TEXTAREA");

        // A composition: nothing while it composes, its text once as it ends.
        await send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
        assert.deepEqual(await state(), { log: [], text: "日本語" });
        await send("Input.insertText", { text: "仮名" });
        assert.deepEqual(await state(), { log: typed("日本語仮名", "仮名"), text: "日本語仮名" });

        // A key types its character by its keydown, and the textarea's insertion adds no other.
        await key("keyDown");
        await key("keyUp");
        assert.deepEqual(await state(), { log: typed("日本語仮名a", "a"), text: "日本語仮名a" });

        // The field's focus gone, the player itself has the page's focus again.
        assert.equal(await call(evaluate, "imeBlur()"), "HOST");
        await send("Input.insertText", { text: "x" });
        assert.deepEqual(await state(), { log: [], text: "日本語仮名a" });
      } finally {
        await call(evaluate, "imeDestroy()");
      }
    },
  );
}

for (const [vm, src] of [
  ["AS3", "/web-test/clipboard.swf"],
  ["AVM1", "/web-test/avm1-field.swf"],
]) {
  check(
    `typing past an ${vm} input field's right edge scrolls it to keep the caret in view`,
    async (evaluate, send) => {
      // [scrollH, maxScrollH, caretIndex], given as a string.
      const scroll = async () =>
        (await call<string>(evaluate, "imeScroll()")).split(" ").map(Number) as [
          number,
          number,
          number,
        ];
      const press = async (key: string, code: string, keyCode: number, text?: string) => {
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          ...(text ? { text } : {}),
        });
        await send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        });
      };
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await call(evaluate, `imePlayer(${JSON.stringify(src)})`);
      try {
        // Far more than the field's 140 pixels: the newest characters and the caret at its right edge.
        for (let i = 0; i < 60; i++) {
          await press("a", "KeyA", 65, "a");
        }

        // The caret at the text's end is in view where the scroll is within a quarter of the
        // room, 34 of the field's 136 pixels inside its gutters, of an input field's maxScrollH,
        // which is that quarter past the text's end.
        const atEnd = ([h, max, caret]: [number, number, number]) => {
          assert.equal(caret, 60);
          assert.ok(max > 34, `the text overflows the field: maxScrollH ${max}`);
          assert.ok(h > max - 34 && h <= max, `the caret is in view: scrollH ${h} of ${max}`);
        };
        const typed = await scroll();
        atEnd(typed);

        // Home shows the text's start, End its end again.
        await press("Home", "Home", 36);
        assert.deepEqual(await scroll(), [0, typed[1], 0]);
        await press("End", "End", 35);
        atEnd(await scroll());
      } finally {
        await call(evaluate, "imeDestroy()");
      }
    },
  );
}

for (const [vm, src] of [
  ["AS3", "/web-test/clipboard.swf"],
  ["AVM1", "/web-test/avm1-field.swf"],
]) {
  check(
    `typing that moves an ${vm} input field's scroll tells it, as Flash Player 32 did`,
    async (evaluate, send) => {
      // [scrollH, maxScrollH, caretIndex]
      const scroll = async () =>
        (await call<string>(evaluate, "imeScroll()")).split(" ").map(Number) as [
          number,
          number,
          number,
        ];
      // What the field told of its scroll since last asked: AS3's SCROLL at once, AVM1's
      // onScroller once the SWF's frame has run, which may take a few of the page's. Asked
      // till it told something, or `last` last.
      const told = async (last?: string) => {
        const all: string[] = [];
        for (let i = 0; i < 60 && (last ? all.at(-1) !== last : all.length === 0); i++) {
          await call(evaluate, "imeFrames()");
          all.push(...(await call<string[]>(evaluate, "imeScrolls()")));
        }

        return all;
      };
      const press = async (key: string, code: string, keyCode: number, text?: string) => {
        for (const type of ["keyDown", "keyUp"]) {
          await send("Input.dispatchKeyEvent", {
            type,
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            ...(text && type === "keyDown" ? { text } : {}),
          });
        }
      };
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await call(evaluate, `imePlayer(${JSON.stringify(src)})`);
      try {
        // Typed till the text reaches into the quarter of the room an input field scrolls by,
        // the field not scrolled yet: how far it scrolls moved alone, and that is told.
        let state = await scroll();
        while (state[1] === 0 && state[2] < 60) {
          await press("a", "KeyA", 65, "a");
          state = await scroll();
        }

        assert.ok(state[1] > 0 && state[0] === 0, `maxScrollH moved alone: ${state}`);
        assert.ok((await told()).length > 0, "a maxScrollH typed further was not told");

        // Typed past the edge: scrolled, and told so, the last as the field now is.
        for (let i = 0; i < 30; i++) {
          await press("a", "KeyA", 65, "a");
        }

        state = await scroll();
        assert.ok(state[0] > 0, `scrolled to the caret: ${state}`);
        assert.equal((await told(`${state[0]}/${state[1]}`)).at(-1), `${state[0]}/${state[1]}`);

        // All of it selected and deleted: back to no scroll at all, told.
        await ctrl(send, "a", "selectAll");
        await press("Backspace", "Backspace", 8);
        assert.deepEqual(await scroll(), [0, 0, 0]);
        assert.equal((await told("0/0")).at(-1), "0/0");
      } finally {
        await call(evaluate, "imeDestroy()");
      }
    },
  );
}

for (const [vm, src] of [
  ["AS3", "/web-test/clipboard.swf"],
  ["AVM1", "/web-test/avm1-field.swf"],
]) {
  check(
    `a click in a scrolled ${vm} input field puts the caret under it and keeps the scroll`,
    async (evaluate, send) => {
      // [scrollH, maxScrollH, caretIndex]
      const scroll = async () =>
        (await call<string>(evaluate, "imeScroll()")).split(" ").map(Number) as [
          number,
          number,
          number,
        ];
      const click = async (x: number, y: number) => {
        const [left, top] = await call<[number, number]>(evaluate, "imeBox()");
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", {
            type,
            x: left + x,
            y: top + y,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
        }

        await call(evaluate, "imeFrames()");
      };
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await call(evaluate, `imePlayer(${JSON.stringify(src)})`);
      try {
        // Far wider than the field's 140 pixels, scrolled 40 by script, and without the focus.
        await call(evaluate, `imeFill(${JSON.stringify("a".repeat(60))}, 40)`);
        await call(evaluate, "imeBlur()");
        const [h, max] = await scroll();
        assert.ok(max > 40 && h === 40, `scrolled by script: scrollH ${h} of ${max}`);

        // A press focuses the field, its caret where it was pressed in the text as scrolled.
        await click(30, 10);
        const [pressedH, , pressed] = await scroll();
        assert.equal(pressedH, 40);
        assert.ok(pressed > 0 && pressed < 60, `the caret under the press: ${pressed}`);

        // Pressed again further along, focused: the scroll stays, the caret moves with it.
        await click(100, 10);
        const [againH, , again] = await scroll();
        assert.equal(againH, 40);
        assert.ok(again > pressed && again < 60, `the caret under the second press: ${again}`);
      } finally {
        await call(evaluate, "imeDestroy()");
      }
    },
  );
}

check(
  "the window's blur and focus and the page taking the focus deactivate and activate the SWF",
  async (evaluate, send) => {
    // A focused page, as a user's: the player starts active.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await call(evaluate, "activationPlayer()");
    const log = () => call<string[]>(evaluate, "activationLog()");
    assert.deepEqual(await log(), []);

    // The window's blur, told twice, then its focus.
    await call(evaluate, `activationWindow("blur")`);
    await call(evaluate, `activationWindow("blur")`);
    await call(evaluate, `activationWindow("focus")`);
    assert.deepEqual(await log(), [
      "deactivate root1",
      "deactivate orphan",
      "activate root1",
      "activate orphan",
    ]);

    // A blur and a focus in one call of the page's: nothing changed by its end.
    await call(evaluate, `activationWindow("blur") && activationWindow("focus")`);
    assert.deepEqual(await log(), []);

    // The page's textarea takes the focus, and the element takes it back.
    await call(evaluate, "activationFocus(false)");
    await call(evaluate, "activationFocus(true)");
    assert.deepEqual(await log(), [
      "deactivate root1",
      "deactivate orphan",
      "activate root1",
      "activate orphan",
    ]);
    await call(evaluate, "activationDestroy()");
  },
);

check(
  "showAll draws past the stage's edges in its margins, and takes the mouse there",
  async (evaluate, send) => {
    const shot = async () => {
      const data = (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
      return decodePng(new Uint8Array(Buffer.from(data, "base64")));
    };
    const only = (image: Image, rect: number[]) => [...colours(image, rect, 2).keys()];

    // Twice its size in a box three times as wide: 200 CSS pixels of margin each side, centred.
    const [left, top, width, height] = await call<number[]>(evaluate, 'marginsPlayer("")');
    // As in Flash, the stage keeps the SWF's size however large the box is.
    assert.deepEqual([width, height], [100, 100]);
    let image = await shot();
    assert.deepEqual(only(image, [left + 110, top + 10, 80, 180]), [0xff0000], "left margin");
    assert.deepEqual(only(image, [left + 210, top + 10, 180, 180]), [0xffff00], "stage");
    assert.deepEqual(only(image, [left + 410, top + 10, 80, 180]), [0x00ff00], "right margin");
    assert.deepEqual(only(image, [left + 510, top + 10, 80, 180]), [0xffffff], "past the art");

    const press = async (x: number, y: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + x,
          y: top + y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      }
    };
    // Flash (adl, 2026-10-24) hears a press in the margins at stage coordinates past its edges.
    await press(150, 100);
    await press(550, 40);
    await press(300, 100);
    assert.deepEqual(await call<string[]>(evaluate, "marginsLog()"), [
      "red -25,50 -25,50",
      "stage 175,20 175,20",
      "yellow 50,50 50,50",
    ]);

    // A right-click in a margin opens the player's menu, not the browser's.
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: left + 50,
        y: top + 100,
        button: type === "mouseMoved" ? "none" : "right",
        clickCount: 1,
      });
    }
    const menu =
      'document.getElementById("margins").shadowRoot.querySelector("[data-swf2es-context-menu]")';
    assert.equal(await call(evaluate, `!!${menu}`), true, "no player menu in the margin");
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: "Escape", windowsVirtualKeyCode: 27 });
    }
    assert.equal(await call(evaluate, `!!${menu}`), false, "the menu stayed open");

    // Held to the left edge, the stage's right margin is the whole rest of the box.
    const [l, t] = await call<number[]>(evaluate, 'marginsPlayer("L")');
    image = await shot();
    assert.deepEqual(only(image, [l + 10, t + 10, 180, 180]), [0xffff00], "stage at the left");
    assert.deepEqual(only(image, [l + 210, t + 10, 80, 180]), [0x00ff00], "right margin");
    await press(250, 100);
    assert.deepEqual(await call<string[]>(evaluate, "marginsLog()"), ["green 125,50 125,50"]);
    await call(evaluate, "marginsDestroy()");
  },
);

check(
  "a frame that starts off (0, 0) is placed by its corner, the stage's coordinates the SWF's",
  async (evaluate, send) => {
    const data = async () =>
      (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
    const only = (image: Image, rect: number[]) => [...colours(image, rect, 2).keys()];

    // The frame from (30, 20), twice its size and centred: its corner 200 CSS pixels in, as
    // the projector and adl place it, so the stage's (0, 0) is 60 left of that and 40 above.
    const [left, top, width, height] = await call<number[]>(
      evaluate,
      'marginsPlayer("", "/web-test/origin.swf")',
    );
    assert.deepEqual([width, height], [100, 100]);
    const image = decodePng(new Uint8Array(Buffer.from(await data(), "base64")));
    assert.deepEqual(only(image, [left + 50, top + 10, 80, 140]), [0xff0000], "red");
    assert.deepEqual(only(image, [left + 150, top + 10, 180, 140]), [0xffff00], "yellow");
    assert.deepEqual(only(image, [left + 350, top + 10, 80, 140]), [0x00ff00], "green");
    assert.deepEqual(only(image, [left + 150, top + 170, 180, 20]), [0xffffff], "below the art");

    for (const [x, y] of [
      [300, 100],
      [200, 0],
      [100, 100],
    ]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + x,
          y: top + y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      }
    }
    // The pointer at the element's stage corner is at the frame's, (30, 20).
    assert.deepEqual(await call<string[]>(evaluate, "marginsLog()"), [
      "yellow 80,70 80,70",
      "yellow 30,20 30,20",
      "red -20,70 -20,70",
    ]);
    await call(evaluate, "marginsDestroy()");
  },
);

check("a stage holding nothing shows its background colour, not black", async (evaluate, send) => {
  for (const vm of ["as3", "avm1"]) {
    const [left, top] = await call<number[]>(
      evaluate,
      `scriptFreePlayer("/web-test/empty-${vm}.swf")`,
    );
    // Past the frames that draw, and those after that draw nothing: the canvas shows what it drew.
    await call(evaluate, "frames(10).then(() => true)");
    const data = (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    assert.deepEqual([...colours(image, [left, top, 100, 60], 2).keys()], [0x3366cc], vm);
    await call(evaluate, "scriptFreeDestroy()");
  }
});

// Flash Player 32's projector, driven by real keys (adl takes none): the focus's rectangle is
// opaque yellow, three screen pixels wide inside its object's bounds on the stage, over what
// is above the object; a button's hit area's. Two device pixels a stage pixel here, so its
// bars are three device pixels. Tab and a script show it, a press's listener's too; a press
// hides it, in AVM1 below SWF 9 a move too; an object's focusRect or _focusrect, or the
// stage's, as the focus moves, keeps it off, as do a text field, the stage, the root and a
// hidden parent.
check("the focus's yellow rectangle shows as Flash draws it", async (evaluate, send) => {
  const YELLOW = 0xffff00;
  const settle = () => call(evaluate, "frames(3).then(() => true)");
  const tab = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
      });
    }
    await settle();
  };
  const mouse = async (types: string[], x: number, y: number) => {
    for (const type of types) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
    await settle();
  };
  const focusCall = <R>(name: string, ...args: unknown[]) =>
    call<R>(
      evaluate,
      `focusCall(${[name, ...args].map((a) => JSON.stringify(a)).join(", ")}) ?? true`,
    );
  // The device pixels' colours at the given points, and how many are yellow in the stage.
  const look = async (points: [number, number][]) => {
    const data = (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
    const image = decodePng(new Uint8Array(Buffer.from(data, "base64")));
    const at = (x: number, y: number) => {
      const i = (y * image.width + x) * 4;
      return (image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2];
    };
    let yellow = 0;
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 400; x++) {
        yellow += at(x, y) === YELLOW ? 1 : 0;
      }
    }

    return { yellow, colours: points.map(([x, y]) => at(x, y)) };
  };
  // A frame of 3 device pixels inside w by h device pixels: its pixel count.
  const frame = (w: number, h: number) => w * h - (w - 6) * (h - 6);
  // The clip's frame, at (40, 40) to (120, 100) in device pixels: each bar's outer and inner
  // pixels yellow, the pixels on either side not. The green square covers its left edge.
  const clipPoints: [number, number][] = [
    [39, 70],
    [40, 70],
    [42, 70],
    [43, 70],
    [80, 39],
    [80, 40],
    [80, 42],
    [80, 43],
    [120, 70],
    [119, 70],
    [117, 70],
    [116, 70],
    [80, 100],
    [80, 99],
    [80, 97],
    [80, 96],
  ];
  const G = 0x00ff00;
  const B = 0x0000ff;
  const W = 0xffffff;
  const Y = YELLOW;
  const clipColours = [G, Y, Y, G, W, Y, Y, B, W, Y, Y, B, W, Y, Y, B];

  for (const vm of ["as3", "avm1"]) {
    const name = (n: string) => (vm === "as3" ? n.replace(/^.*\./, "") : `_level0.${n}`);
    const [left, top] = await call<number[]>(evaluate, `focusPlayer("/web-test/focus-${vm}.swf")`);
    assert.deepEqual([left, top], [0, 0], vm);
    try {
      assert.equal((await look([])).yellow, 0, `${vm}: a rectangle before Tab`);

      await tab();
      assert.equal(await focusCall("focusName"), name("clip"), vm);
      let seen = await look(clipPoints);
      assert.equal(seen.yellow, frame(80, 60), `${vm}: the clip's rectangle`);
      assert.deepEqual(seen.colours, clipColours, `${vm}: the clip's rectangle's edges`);

      // Three screen pixels in a holder scaled twice, not six.
      await tab();
      assert.equal(await focusCall("focusName"), name("holder.kid"), vm);
      seen = await look([
        [200, 60],
        [202, 60],
        [203, 60],
      ]);
      assert.equal(seen.yellow, frame(40, 40), `${vm}: the scaled kid's rectangle`);
      assert.deepEqual(seen.colours, [Y, Y, B], `${vm}: the scaled kid's rectangle's edge`);

      // Its own focusRect false: none.
      await tab();
      assert.equal(await focusCall("focusName"), name("off"), vm);
      assert.equal((await look([])).yellow, 0, `${vm}: off's rectangle`);

      // A text field, AS3's, shows none; a button, AS2's, its hit area's.
      await tab();
      if (vm === "as3") {
        assert.equal(await focusCall("focusName"), "field", vm);
        assert.equal((await look([])).yellow, 0, "as3: the field's rectangle");
      } else {
        assert.equal(await focusCall("focusName"), name("btn"), vm);
        seen = await look([
          [200, 160],
          [202, 160],
          [203, 160],
          [279, 160],
          [280, 160],
        ]);
        assert.equal(seen.yellow, frame(80, 40), "avm1: the button's rectangle");
        assert.deepEqual(seen.colours, [Y, Y, 0xff0000, Y, W], "avm1: the button's edges");
      }

      // Round to the clip, then a press on it hides the rectangle, the focus kept.
      await tab();
      assert.equal((await look([])).yellow, frame(80, 60), `${vm}: the clip's again`);
      await mouse(["mouseMoved", "mousePressed", "mouseReleased"], left + 50, top + 35);
      assert.equal(await focusCall("focusName"), name("clip"), vm);
      assert.equal((await look([])).yellow, 0, `${vm}: a rectangle after a press`);

      // Tab shows it again; below SWF 9 a move hides it, as a press does.
      await tab();
      assert.equal((await look([])).yellow, frame(40, 40), `${vm}: the kid's after a press`);
      await mouse(["mouseMoved"], left + 190, top + 110);
      assert.equal((await look([])).yellow, vm === "avm1" ? 0 : frame(40, 40), `${vm}: a move`);

      // The stage's off: none on the clip, whose own is not set.
      await focusCall("stageFocusRect", false);
      for (let i = 0; i < 3; i++) {
        await tab();
      }
      assert.equal(await focusCall("focusName"), name("clip"), vm);
      assert.equal((await look([])).yellow, 0, `${vm}: the stage's focus rectangle off`);
      await focusCall("stageFocusRect", true);

      // A script's focus shows it, as Tab does, but not where a parent of it is hidden.
      await focusCall("focusOn", vm === "as3" ? "kid" : "holder.kid");
      await settle();
      assert.equal((await look([])).yellow, frame(40, 40), `${vm}: a script's focus`);
      await focusCall("showHolder", false);
      await settle();
      assert.equal((await look([])).yellow, 0, `${vm}: a hidden parent's child's`);
      await focusCall("showHolder", true);
      await settle();

      if (vm === "as3") {
        // The stage or the root focused, to hear the keys: none.
        for (const target of ["stage", "root"]) {
          await focusCall("focusOn", target);
          await settle();
          assert.equal(await focusCall("focusName"), target);
          assert.equal((await look([])).yellow, 0, `as3: the ${target}'s focus`);
        }

        // It follows what it frames as that moves, drawn once where it was first.
        await focusCall("focusOn", "clip");
        await settle();
        assert.equal((await look([])).yellow, frame(80, 60), "as3: the clip's before it moves");
        await focusCall("nudge");
        await settle();
        seen = await look([
          [59, 70],
          [60, 70],
          [139, 70],
          [140, 70],
        ]);
        assert.equal(seen.yellow, frame(80, 60), "as3: the moved clip's rectangle");
        assert.deepEqual(seen.colours, [G, Y, Y, W], "as3: the moved clip's edges");

        // A mouseDown listener's focus shows it, as Flash Player 32's does; the stage's not.
        await focusCall("focusOn", "stage");
        await mouse(["mouseMoved", "mousePressed", "mouseReleased"], left + 180, top + 30);
        assert.equal(await focusCall("focusName"), "clip");
        assert.equal((await look([])).yellow, frame(80, 60), "as3: a mouseDown's focus");
        await mouse(["mouseMoved", "mousePressed", "mouseReleased"], left + 180, top + 80);
        assert.equal(await focusCall("focusName"), "stage");
        assert.equal((await look([])).yellow, 0, "as3: a mouseDown's focus on the stage");
      }
    } finally {
      await call(evaluate, "focusDestroy()");
    }
  }
});

check("a SWF with no code has buttons the pointer reaches", async (evaluate, send) => {
  // The GL clears of the player's canvas from now, which every frame it draws makes.
  const countClears = (left: number, top: number) =>
    call(
      evaluate,
      `(() => {
      const canvas = document.elementFromPoint(${left + 1}, ${top + 1}).shadowRoot.querySelector("canvas");
      const gl = canvas.getContext("webgl2");
      window.stillClears = 0;
      const clear = WebGL2RenderingContext.prototype.clear;
      gl.clear = function (...a) { window.stillClears++; return clear.apply(this, a); };
      return true;
    })()`,
    );
  const clears = () => call<number>(evaluate, "window.stillClears");
  const shot = async () => {
    const data = (await send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
    return decodePng(new Uint8Array(Buffer.from(data, "base64")));
  };
  const only = (image: Image, rect: number[]) => [...colours(image, rect, 2).keys()];
  const move = (x: number, y: number) =>
    send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  const press = async (x: number, y: number) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  };

  for (const vm of ["as3", "avm1"]) {
    const [left, top] = await call<number[]>(
      evaluate,
      `scriptFreePlayer("/web-test/button-${vm}.swf")`,
    );
    const up = [left + 12, top + 22, 16, 16];
    const over = [left + 62, top + 22, 16, 16];
    // On the up state's square, outside the hit test: still up.
    await move(left + 20, top + 30);
    await call(evaluate, "frames(2).then(() => true)");
    let image = await shot();
    assert.deepEqual(only(image, up), [0xff0000], `${vm}: up off the hit test`);
    assert.deepEqual(only(image, over), [0xffffff], `${vm}: over off the hit test`);

    // Frames that change nothing draw nothing, the canvas showing what it drew.
    await countClears(left, top);
    await call(evaluate, "frames(10).then(() => true)");
    assert.equal(await clears(), 0, `${vm}: a still stage drawn again`);
    image = await shot();
    assert.deepEqual(only(image, up), [0xff0000], `${vm}: up while still`);

    // On the hit test: over, drawn there, and the up state gone.
    await move(left + 70, top + 30);
    await call(evaluate, "frames(2).then(() => true)");
    assert.ok((await clears()) > 0, `${vm}: the over state not drawn`);
    image = await shot();
    assert.deepEqual(only(image, up), [0xffffff], `${vm}: up on the hit test`);
    assert.deepEqual(only(image, over), [0x00ff00], `${vm}: over on the hit test`);

    // A press and a release there leave it over, and moving off puts it up again.
    await press(left + 70, top + 30);
    await move(left + 95, top + 5);
    await call(evaluate, "frames(2).then(() => true)");
    image = await shot();
    assert.deepEqual(only(image, up), [0xff0000], `${vm}: up once off`);
    assert.deepEqual(only(image, over), [0xffffff], `${vm}: over once off`);
    await call(evaluate, "scriptFreeDestroy()");
  }
});

check(
  "an AS2 press reaches only what was under the pointer before its onMouseDown and still is",
  async (evaluate, send) => {
    const [left, top] = await call<number[]>(
      evaluate,
      `scriptFreePlayer("/web-test/avm1-press-changes.swf")`,
    );
    const mouse = async (types: string[], x: number, y: number) => {
      for (const type of types) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + x,
          y: top + y,
          button: type === "mouseMoved" ? "none" : "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      }

      await call(evaluate, "frames(2).then(() => true)");
      return call<string[]>(evaluate, `scriptFreeCall("takeLog")`);
    };
    const click = ["mousePressed", "mouseReleased"];

    try {
      // Flash Player 32 under real clicks: the button the press shows takes no press, nor its
      // release, only the roll over the release gives it; then it is pressed as any other.
      assert.deepEqual(await mouse(["mouseMoved"], 20, 30), []);
      assert.deepEqual(await mouse(click, 20, 30), ["shown onRollOver"]);
      assert.deepEqual(await mouse(click, 20, 30), ["shown onPress", "shown onRelease"]);

      // The one it hides rolls out, as with the button up, and takes no press either.
      assert.deepEqual(await mouse(["mouseMoved"], 70, 30), ["shown onRollOut", "gone onRollOver"]);
      assert.deepEqual(await mouse(click, 70, 30), ["gone onRollOut"]);

      // A clip hidden so gets its roll out too, as Flash sends a hidden clip's roll and drag outs.
      assert.deepEqual(await mouse(["mouseMoved"], 120, 30), ["goneClip onRollOver"]);
      assert.deepEqual(await mouse(click, 120, 30), ["goneClip onRollOut"]);

      // A button a goto makes again in its place is still the one pressed, as in Flash.
      assert.deepEqual(await mouse(["mouseMoved"], 170, 30), ["remade onRollOver"]);
      assert.deepEqual(await mouse(click, 170, 30), ["remade onPress", "remade onRelease"]);
    } finally {
      await call(evaluate, "scriptFreeDestroy()");
    }
  },
);

check(
  "the mouse's events come in Flash's order, and a drag off the player keeps the mouse",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    // Test pointer routing independently of the popup, which takes the pointer while open.
    await call(
      evaluate,
      `(() => {
      const canvas = document.elementFromPoint(${left + 1}, ${top + 1}).shadowRoot.querySelector("canvas");
      canvas.addEventListener("contextmenu", e => e.preventDefault(), {capture:true});
      return true;
    })()`,
    );
    const log = () => call<string[]>(evaluate, "touchLog()");
    const mouse = async (type: string, x: number, y: number, buttons = 0, button = "left") => {
      await send("Input.dispatchMouseEvent", {
        type,
        x: left + x,
        y: top + y,
        button: type === "mouseMoved" && buttons === 0 ? "none" : button,
        buttons,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
      return log();
    };

    // As Flash Player 32 traced it: a move first, then the hover; the empty
    // stage takes the move, but no over.
    assert.deepEqual(await mouse("mouseMoved", 150, 90), ["mouseMove stage 150,90 false null"]);
    assert.deepEqual(await mouse("mouseMoved", 30, 30), [
      "mouseMove b 10,10 false null",
      "rollOver b 10,10 false null",
      "rollOver a 30,30 false null",
      "mouseOver b 10,10 false null",
    ]);
    // A press where the mouse was not is a move there first, its button still up.
    assert.deepEqual(await mouse("mousePressed", 110, 30, 1), [
      "mouseMove c 10,30 false null",
      "mouseOut b 90,10 false c",
      "rollOut b 90,10 false c",
      "rollOut a 110,30 false c",
      "rollOver c 10,30 false b",
      "mouseOver c 10,30 false b",
      "mouseDown c 10,30 true null",
    ]);
    // Dragged off the player, the mouse stays its own: moves to the stage,
    // the release too, and the leave only at the next move after it.
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 1), [
      "mouseMove stage 300,30 true null",
      "mouseOut c 200,30 true null",
      "rollOut c 200,30 true null",
    ]);
    assert.deepEqual(await mouse("mouseReleased", 300, 30), ["mouseUp stage 300,30 false null"]);
    assert.deepEqual(await mouse("mouseMoved", 310, 30), ["mouseLeave stage"]);

    // The right button holds nothing: the pointer leaves as it goes, and its
    // release outside leaves no second time.
    await mouse("mouseMoved", 110, 30);
    await mouse("mousePressed", 110, 30, 2, "right");
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 2, "right"), [
      "mouseOut c -101,-1 false null",
      "rollOut c -101,-1 false null",
      "mouseLeave stage",
    ]);
    assert.deepEqual(await mouse("mouseReleased", 300, 30, 0, "right"), []);
    assert.deepEqual(await mouse("mouseMoved", 310, 30), []);

    // The left button let go while the right stays down is a release, which
    // the browser tells as a move: the leave after it is not held back.
    await mouse("mouseMoved", 110, 30);
    await mouse("mousePressed", 110, 30, 1);
    await mouse("mousePressed", 110, 30, 3, "right");
    assert.deepEqual(await mouse("mouseReleased", 110, 30, 2), [
      "mouseUp c 10,30 false null",
      "click c 10,30 false null",
    ]);
    assert.deepEqual(await mouse("mouseMoved", 300, 30, 2, "right"), [
      "mouseOut c -101,-1 false null",
      "rollOut c -101,-1 false null",
      "mouseLeave stage",
    ]);
    await mouse("mouseReleased", 300, 30, 0, "right");
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "a double click in Chrome is a doubleClick where the target's doubleClickEnabled is true",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    const log = () => call<string[]>(evaluate, "touchLog()");
    // Both clicks as the browser sends a double click's, back to back: the
    // player counts a second press within half a second of the first, and a
    // read of the log between them, under a slow build, has taken longer.
    const click = async (clickCount: number) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: left + 110,
          y: top + 30,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount,
        });
      }
    };

    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left + 110, y: top + 30 });
    await log();
    await call(evaluate, `touchCall("setBox", "c", "doubleClickEnabled", true)`);
    await click(1);
    await click(2);
    assert.deepEqual(await log(), [
      "mouseDown c 10,30 true null",
      "mouseUp c 10,30 false null",
      "click c 10,30 false null",
      "mouseDown c 10,30 true null",
      "mouseUp c 10,30 false null",
      "doubleClick c 10,30 false null",
    ]);
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "the wheel scrolls the page over a SWF that does not listen for it, and only goes to one that does",
  async (evaluate, send) => {
    const [left, top] = await call<[number, number]>(evaluate, "touchPlayer()");
    const scrolled = () =>
      call<number>(evaluate, "(document.body.style.height = '3000px', window.scrollY)");
    // The wheel over c, the page at its top; a page that scrolls takes the
    // player from under the pointer, whose leave is logged too.
    const wheel = async (deltaY: number) => {
      await call(evaluate, "(window.scrollTo(0, 0), window.scrollY)");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left + 110, y: top + 30 });
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: left + 110,
        y: top + 30,
        deltaX: 0,
        deltaY,
      });
      // The page scrolls a moment later, unless the SWF took the wheel: its
      // listener runs in the wheel event's, which then prevents the scroll.
      const log: string[] = [];
      let moved = false;
      for (let i = 0; i < 60 && !moved && log.length === 0; i++) {
        await new Promise((done) => setTimeout(done, 50));
        const heard = await call<string[]>(evaluate, "touchLog()");
        log.push(...heard.filter((line) => line.startsWith("mouseWheel")));
        moved = (await scrolled()) > 0;
      }

      return [moved, log];
    };

    await scrolled();
    assert.deepEqual(await wheel(100), [true, []]);
    await call(evaluate, `touchCall("listenWheel")`);
    // A notch of 100 pixels is 3 lines, down negative, as Flash's delta.
    assert.deepEqual(await wheel(100), [false, ["mouseWheel c -3"]]);
    assert.deepEqual(await wheel(-100), [false, ["mouseWheel c 3"]]);
    await call(evaluate, "(document.body.style.height = '', window.scrollTo(0, 0), true)");
    await call(evaluate, "touchDestroy()");
  },
);

check(
  "touches reach a SWF as TouchEvents and as the mouse, and a tap may write the clipboard",
  async (evaluate, send) => {
    // A touch screen the page has from here on: the players made before it saw none.
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const [left, top, touchAction] = await call<[number, number, string]>(
      evaluate,
      "touchPlayer()",
    );
    const log = () => call<string[]>(evaluate, "touchLog()");
    const touch = (type: string, points: [x: number, y: number, id: number][]) =>
      send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y, id]) => ({ x: left + x, y: top + y, id })),
      });

    // The page does not scroll or zoom under the SWF, which takes every touch as Flash's plug-in did.
    assert.equal(touchAction, "none");
    assert.deepEqual(await call(evaluate, `touchCall("touchState")`), [
      true,
      5,
      "gesture",
      "finger",
    ]);

    // In gesture mode, which recognizes no gestures here, a tap is the mouse's alone.
    await touch("touchStart", [[30, 30, 0]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "mouseMove b 10,10 false null",
      "rollOver b 10,10 false null",
      "rollOver a 30,30 false null",
      "mouseOver b 10,10 false null",
      "mouseDown b 10,10 true null",
      "mouseUp b 10,10 false null",
      "click b 10,10 false null",
    ]);

    // In touchPoint mode, each step's touch events, then the primary touch's mouse
    // events; the mouse stays over b, where the tap left it.
    assert.equal(await call(evaluate, `touchCall("setMode", "touchPoint")`), "touchPoint");
    await touch("touchStart", [[30, 30, 0]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "touchRollOver b primary 10,10 30,30 null",
      "touchRollOver a primary 30,30 30,30 null",
      "touchOver b primary 10,10 30,30 null",
      "touchBegin b primary 10,10 30,30 null",
      "mouseDown b 10,10 true null",
      "touchEnd b primary 10,10 30,30 null",
      "touchTap b primary 10,10 30,30 null",
      "touchOut b primary 10,10 30,30 null",
      "touchRollOut b primary 10,10 30,30 null",
      "touchRollOut a primary 30,30 30,30 null",
      "mouseUp b 10,10 false null",
      "click b 10,10 false null",
    ]);
    // The tap's listener wrote the clipboard, through the async API, as a click's would.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    let seed = "";
    for (let i = 0; i < 20 && seed !== "tapped b"; i++) {
      await new Promise((done) => setTimeout(done, 50));
      await call(evaluate, `seedFocus("")`);
      await ctrl(send, "v", "paste");
      seed = await call<string>(evaluate, "touchSeed()");
    }

    assert.equal(seed, "tapped b");

    // A drag from b to c: a move that may not write the clipboard, then out
    // and rolls as the point moves, in the mouse's order, and the mouse after it.
    await touch("touchStart", [[30, 30, 0]]);
    await log();
    await touch("touchMove", [[110, 30, 0]]);
    assert.deepEqual(await log(), [
      "touchMove c primary 10,30 110,30 null",
      "setClipboard in touchMove 2176",
      "touchOut b primary 90,10 110,30 c",
      "touchRollOut b primary 90,10 110,30 c",
      "touchRollOut a primary 110,30 110,30 c",
      "touchRollOver c primary 10,30 110,30 b",
      "touchOver c primary 10,30 110,30 b",
      "mouseMove c 10,30 true null",
      "mouseOut b 90,10 true c",
      "rollOut b 90,10 true c",
      "rollOut a 110,30 true c",
      "rollOver c 10,30 true b",
      "mouseOver c 10,30 true b",
    ]);

    // A second finger is touch events alone; the first, lifted over c where
    // it did not begin, is no tap and no click.
    await touch("touchStart", [
      [110, 30, 0],
      [10, 10, 1],
    ]);
    await touch("touchEnd", [[10, 10, 1]]);
    await touch("touchEnd", []);
    assert.deepEqual(await log(), [
      "touchRollOver a secondary 10,10 10,10 null",
      "touchOver a secondary 10,10 10,10 null",
      "touchBegin a secondary 10,10 10,10 null",
      "touchEnd a secondary 10,10 10,10 null",
      "touchTap a secondary 10,10 10,10 null",
      "touchOut a secondary 10,10 10,10 null",
      "touchRollOut a secondary 10,10 10,10 null",
      "touchEnd c primary 10,30 110,30 null",
      "touchOut c primary 10,30 110,30 null",
      "touchRollOut c primary 10,30 110,30 null",
      "mouseUp c 10,30 false null",
    ]);
    await call(evaluate, "touchDestroy()");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  },
);

check(
  "lazy compilation is opt-in and destroyed players release their compilers",
  async (evaluate, send) => {
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const before = await call<{ codegens: number }>(evaluate, "survivors()");
    assert.equal(await call<number>(evaluate, "lazyChurn(5)"), 5);
    await send("HeapProfiler.collectGarbage");
    await send("HeapProfiler.collectGarbage");
    const after = await call<{ players: number; codegens: number }>(evaluate, "survivors()");
    assert.equal(after.players, 0);
    assert.equal(after.codegens, before.codegens);
  },
);

check(
  "a page's frame listener and the meter each hear the frames, whichever comes first",
  async (evaluate) => {
    const steps = await call<[string, number, string, boolean][]>(evaluate, "meterWithListener()");
    const live = (text: string) => Number(/^(\d+\.\d) \//.exec(text)?.[1] ?? 0) > 0;
    // Each step: whether the listener heard calls, whether the meter's fps is live (null for a
    // hidden meter's last figure), and whether the loop has a hook: none once neither listens.
    const expected: [string, boolean, boolean | null, boolean][] = [
      ["listener", true, null, true],
      ["both", true, true, true],
      ["meter", false, true, true],
      ["both again", true, true, true],
      ["listener again", true, null, true],
      ["neither", false, null, false],
    ];
    assert.equal(steps.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      const [label, listening, metered, hook] = expected[i];
      const [step, heard, fps, hooked] = steps[i];
      assert.equal(step, label);
      assert.equal(heard > 0, listening, `${label}: the listener heard ${heard} calls`);
      if (metered !== null) {
        assert.equal(live(fps), metered, `${label}: the meter shows ${fps}`);
      }
      assert.equal(hooked, hook, `${label}: the loop's hook`);
    }
  },
);

check(
  "the context menu shows and hides the performance meter, kept for the viewer, unless left out",
  async (evaluate, send) => {
    const at = await call<number[]>(
      evaluate,
      `(async () => {
    localStorage.removeItem("swf2es.performanceMeter");
    localStorage.removeItem("swf2es.performanceMeterCorner");
    window.meterPlayer = document.createElement("swf2es-player");
    meterPlayer.style.cssText = "position:fixed;left:0;top:0;z-index:1000";
    window.meterChanges = [];
    meterPlayer.addEventListener("performancemeterchange", (e) => meterChanges.push(e.detail.shown));
    document.body.append(meterPlayer);
    await meterPlayer.load("/web-test/context-menu.swf");
    window.meterMenu = () => meterPlayer.shadowRoot.querySelector("[data-swf2es-context-menu]");
    window.meterButtons = () => Array.from(meterMenu()?.shadowRoot.querySelectorAll("button") ?? []);
    window.meterBox = () => meterPlayer.shadowRoot.querySelector(".meter");
    window.meterFigure = (name) => meterBox().querySelector("[data-figure=" + name + "]");
    window.meterWrapped = () => Object.hasOwn(meterPlayer.gl, "drawElements");
    const r = meterPlayer.getBoundingClientRect();
    return [r.x, r.y];
  })()`,
    );
    const open = async () => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: at[0] + 45,
          y: at[1] + 45,
          button: type === "mouseMoved" ? "none" : "right",
          clickCount: 1,
        });
      }
    };
    const until = async (expression: string) => {
      for (let i = 0; i < 100; i++) {
        if (await call<boolean>(evaluate, expression)) {
          return;
        }

        await new Promise((done) => setTimeout(done, 50));
      }

      assert.fail(`not ${expression}`);
    };
    const dismiss = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: "Escape", windowsVirtualKeyCode: 27 });
      }
    };
    try {
      // Off: not even made, and the context its own.
      assert.equal(await call(evaluate, "meterBox() === null && !meterWrapped()"), true);
      // Just above About, in their own group below the SWF's items.
      await open();
      assert.deepEqual(
        await call(
          evaluate,
          "meterButtons().slice(-2).map((b) => [b.textContent, b.previousElementSibling?.tagName ?? null])",
        ),
        [
          ["Show stats", "HR"],
          ["About swf2es", "BUTTON"],
        ],
      );
      await call(evaluate, "meterButtons().at(-2).click(), true");
      assert.equal(
        await call(evaluate, "meterMenu() === null && meterPlayer.performanceMeter"),
        true,
      );
      assert.equal(await call(evaluate, "!meterBox().hidden && meterWrapped()"), true);
      assert.equal(await call(evaluate, "localStorage.getItem('swf2es.performanceMeter')"), "1");
      await until("/^\\d+\\.\\d \\/ \\d+(\\.\\d+)? fps$/.test(meterFigure('fps').textContent)");
      await until("/ ms, max /.test(meterFigure('frame').textContent)");

      // Hidden again by its item, it hears, ticks and wraps nothing more.
      await open();
      // While it shows, the item to move it follows.
      assert.deepEqual(await call(evaluate, "meterButtons().slice(-3).map((b) => b.textContent)"), [
        "Hide stats",
        "Move stats",
        "About swf2es",
      ]);
      await call(evaluate, "meterButtons().at(-3).click(), true");
      assert.equal(
        await call(evaluate, "meterBox().hidden && !meterPlayer.performanceMeter"),
        true,
      );
      assert.equal(await call(evaluate, "meterWrapped()"), false);
      assert.equal(await call(evaluate, "localStorage.getItem('swf2es.performanceMeter')"), null);
      await call(evaluate, "meterFigure('fps').textContent = 'still', true");
      await new Promise((done) => setTimeout(done, 700));
      assert.equal(await call(evaluate, "meterFigure('fps').textContent"), "still");
      assert.deepEqual(await call(evaluate, "meterChanges"), [true, false]);

      // A script shows and hides it for the page alone: the viewer's choice is not touched.
      await call(evaluate, "meterPlayer.performanceMeter = true, true");
      assert.equal(await call(evaluate, "!meterBox().hidden"), true);
      assert.equal(await call(evaluate, "localStorage.getItem('swf2es.performanceMeter')"), null);
      await call(evaluate, "localStorage.setItem('swf2es.performanceMeter', '1'), true");
      await call(evaluate, "meterPlayer.performanceMeter = false, true");
      assert.equal(await call(evaluate, "localStorage.getItem('swf2es.performanceMeter')"), "1");
      await call(evaluate, "localStorage.removeItem('swf2es.performanceMeter'), true");

      // Left out by the attribute: no item, though a script may still show it, which the
      // attribute leaves be.
      await call(evaluate, 'meterPlayer.setAttribute("performancemeter", "false"), true');
      await open();
      assert.equal(await call(evaluate, "meterButtons().at(-1).textContent"), "About swf2es");
      assert.equal(await call(evaluate, "meterButtons().at(-2)?.textContent"), "<b>Literal</b>");
      await dismiss();
      await call(evaluate, "meterPlayer.performanceMeter = true, true");
      await call(evaluate, 'meterPlayer.setAttribute("performancemeter", "False"), true');
      assert.equal(await call(evaluate, "!meterBox().hidden"), true);
      await call(evaluate, "meterPlayer.performanceMeter = false, true");

      // What the viewer turned on goes as the item is taken away, and comes back with it.
      await call(evaluate, 'meterPlayer.removeAttribute("performancemeter"), true');
      await open();
      await call(evaluate, "meterButtons().at(-2).click(), true");
      assert.equal(await call(evaluate, "!meterBox().hidden"), true);
      await call(evaluate, 'meterPlayer.setAttribute("performancemeter", "false"), true');
      assert.equal(await call(evaluate, "meterBox().hidden"), true);
      assert.equal(await call(evaluate, "localStorage.getItem('swf2es.performanceMeter')"), "1");
      await call(evaluate, 'meterPlayer.removeAttribute("performancemeter"), true');
      assert.equal(await call(evaluate, "!meterBox().hidden"), true);

      // Left out by the page's configuration, likewise.
      await call(
        evaluate,
        `(async () => { (await import("@swf2es/web")).configure({ performanceMeter: false }); return true; })()`,
      );
      await call(evaluate, 'meterPlayer.setAttribute("performancemeter", ""), true');
      assert.equal(await call(evaluate, "meterBox().hidden"), true);
      await open();
      assert.equal(await call(evaluate, "meterButtons().at(-2)?.textContent"), "<b>Literal</b>");
      await dismiss();

      // An element connected before the page's configure(), as one in its markup is, plays
      // without the meter the viewer kept on: the choice is read as its SWF starts.
      assert.deepEqual(
        await call(
          evaluate,
          `(async () => {
        const web = await import("@swf2es/web");
        web.configure({ performanceMeter: true });
        localStorage.setItem("swf2es.performanceMeter", "1");
        document.body.insertAdjacentHTML(
          "beforeend",
          '<swf2es-player id="meter-markup" src="/web-test/context-menu.swf" style="position:fixed;left:0;top:200px"></swf2es-player>',
        );
        window.meterSecond = document.getElementById("meter-markup");
        web.configure({ performanceMeter: false });
        await meterSecond.ready;
        await new Promise((done) => requestAnimationFrame(() => done()));
        return [meterSecond.performanceMeter, meterSecond.shadowRoot.querySelector(".meter") === null];
      })()`,
        ),
        [false, true],
      );
      // Offered again, the next SWF it plays shows it.
      assert.equal(
        await call(
          evaluate,
          `(async () => {
        (await import("@swf2es/web")).configure({ performanceMeter: true });
        await meterSecond.load("/web-test/context-menu.swf");
        return meterSecond.performanceMeter && !meterSecond.shadowRoot.querySelector(".meter").hidden;
      })()`,
        ),
        true,
      );
    } finally {
      await call(
        evaluate,
        `(async () => {
        localStorage.removeItem("swf2es.performanceMeter");
        (await import("@swf2es/web")).configure({ performanceMeter: undefined });
        for (const p of [window.meterPlayer, window.meterSecond]) { p?.destroy(); p?.remove(); }
        return true;
      })()`,
      );
    }
  },
);

check(
  "the context menu moves the meter through the stage's corners, kept for the viewer",
  async (evaluate, send) => {
    const at = await call<number[]>(
      evaluate,
      `(async () => {
    localStorage.removeItem("swf2es.performanceMeter");
    localStorage.removeItem("swf2es.performanceMeterCorner");
    window.cornerPlayer = document.createElement("swf2es-player");
    // Larger than its 200 by 120 stage, so that the meter's corners are apart.
    cornerPlayer.setAttribute("width", "400");
    cornerPlayer.setAttribute("height", "300");
    cornerPlayer.style.cssText = "position:fixed;left:0;top:0;z-index:1000";
    document.body.append(cornerPlayer);
    await cornerPlayer.load("/web-test/context-menu.swf");
    window.cornerButtons = () =>
      Array.from(
        cornerPlayer.shadowRoot.querySelector("[data-swf2es-context-menu]")?.shadowRoot.querySelectorAll("button") ?? [],
      );
    window.cornerItem = (caption) => cornerButtons().find((b) => b.textContent === caption) ?? null;
    // Which corner the meter's box sits in, within 12 px of the player's edges, or none.
    window.cornerOf = () => {
      const m = cornerPlayer.shadowRoot.querySelector(".meter").getBoundingClientRect();
      const p = cornerPlayer.getBoundingClientRect();
      const top = m.top - p.top <= 12;
      const bottom = p.bottom - m.bottom <= 12;
      const left = m.left - p.left <= 12;
      const right = p.right - m.right <= 12;
      return (top && !bottom ? "top" : bottom && !top ? "bottom" : "?") + "-" +
        (left && !right ? "left" : right && !left ? "right" : "?");
    };
    window.cornerEvents = () => cornerPlayer.shadowRoot.querySelector(".meter").style.pointerEvents ||
      getComputedStyle(cornerPlayer.shadowRoot.querySelector(".meter")).pointerEvents;
    const r = cornerPlayer.getBoundingClientRect();
    return [r.x, r.y];
  })()`,
    );
    const open = async () => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: at[0] + 100,
          y: at[1] + 100,
          button: type === "mouseMoved" ? "none" : "right",
          clickCount: 1,
        });
      }
    };
    const dismiss = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: "Escape", windowsVirtualKeyCode: 27 });
      }
    };
    const stored = "localStorage.getItem('swf2es.performanceMeterCorner')";
    try {
      // Hidden, nothing to move.
      await open();
      assert.equal(await call(evaluate, "cornerItem('Move stats') === null"), true);
      await call(evaluate, "cornerItem('Show stats').click(), true");
      assert.equal(await call(evaluate, "cornerOf()"), "top-left");

      // Each choice moves it to the next corner and is kept, the pointer passing through it.
      for (const corner of ["top-right", "bottom-left", "bottom-right", "top-left"]) {
        await open();
        await call(evaluate, "cornerItem('Move stats').click(), true");
        assert.equal(await call(evaluate, "cornerPlayer.performanceMeterCorner"), corner);
        assert.equal(await call(evaluate, "cornerOf()"), corner);
        assert.equal(await call(evaluate, "cornerEvents()"), "none");
        assert.equal(await call(evaluate, stored), corner === "top-left" ? null : corner);
      }

      // A script moves it for the page alone, keeping nothing; a corner it does not know is ignored.
      await call(evaluate, "cornerPlayer.performanceMeterCorner = 'bottom-right', true");
      assert.equal(await call(evaluate, "cornerOf()"), "bottom-right");
      assert.equal(await call(evaluate, stored), null);
      await call(evaluate, "cornerPlayer.performanceMeterCorner = 'middle', true");
      assert.equal(await call(evaluate, "cornerPlayer.performanceMeterCorner"), "bottom-right");

      // Kept, the next SWF's meter is in the viewer's corner.
      await call(
        evaluate,
        "localStorage.setItem('swf2es.performanceMeterCorner', 'bottom-left'), true",
      );
      assert.equal(
        await call(
          evaluate,
          `(async () => {
        window.cornerSecond = document.createElement("swf2es-player");
        cornerSecond.style.cssText = "position:fixed;left:420px;top:0";
        document.body.append(cornerSecond);
        await cornerSecond.load("/web-test/context-menu.swf");
        return cornerSecond.performanceMeter + " " + cornerSecond.performanceMeterCorner +
          " " + cornerSecond.shadowRoot.querySelector(".meter").dataset.corner;
      })()`,
        ),
        "true bottom-left bottom-left",
      );

      // A corner a script set holds against another kept, through the next load.
      assert.equal(
        await call(
          evaluate,
          `(async () => {
        localStorage.setItem("swf2es.performanceMeterCorner", "top-right");
        await cornerPlayer.load("/web-test/context-menu.swf");
        return cornerPlayer.performanceMeterCorner;
      })()`,
        ),
        "bottom-right",
      );

      // Restored as a SWF starts, the kept choice is told once, and only if the meter shows.
      assert.deepEqual(
        await call(
          evaluate,
          `(async () => {
        const told = async (on) => {
          if (on) {
            localStorage.setItem("swf2es.performanceMeter", "1");
          } else {
            localStorage.removeItem("swf2es.performanceMeter");
          }
          const p = document.createElement("swf2es-player");
          p.style.cssText = "position:fixed;left:420px;top:200px";
          const events = [];
          p.addEventListener("performancemeterchange", (e) => events.push(e.detail.shown + " " + e.detail.corner));
          document.body.append(p);
          await p.load("/web-test/context-menu.swf");
          await new Promise((done) => requestAnimationFrame(() => done()));
          const corner = p.performanceMeterCorner;
          p.destroy();
          p.remove();
          return [corner, events];
        };
        localStorage.setItem("swf2es.performanceMeterCorner", "bottom-right");
        return [await told(false), await told(true)];
      })()`,
        ),
        [
          ["bottom-right", []],
          ["bottom-right", ["true bottom-right"]],
        ],
      );

      // Left out, a kept corner is ignored where no script set one.
      assert.equal(
        await call(
          evaluate,
          `(async () => {
        localStorage.setItem("swf2es.performanceMeterCorner", "bottom-left");
        const p = document.createElement("swf2es-player");
        p.setAttribute("performancemeter", "false");
        document.body.append(p);
        await p.load("/web-test/context-menu.swf");
        const corner = p.performanceMeterCorner;
        p.destroy();
        p.remove();
        return corner;
      })()`,
        ),
        "top-left",
      );

      // Left out, neither item is there, though the meter shows.
      await call(evaluate, 'cornerPlayer.setAttribute("performancemeter", "false"), true');
      await call(evaluate, "cornerPlayer.performanceMeter = true, true");
      await open();
      assert.deepEqual(
        await call(
          evaluate,
          "[cornerItem('Hide stats'), cornerItem('Move stats')].map((b) => b === null)",
        ),
        [true, true],
      );
      await dismiss();
    } finally {
      await call(
        evaluate,
        `(() => {
        localStorage.removeItem("swf2es.performanceMeter");
        localStorage.removeItem("swf2es.performanceMeterCorner");
        for (const p of [window.cornerPlayer, window.cornerSecond]) { p?.destroy(); p?.remove(); }
        return true;
      })()`,
      );
    }
  },
);

check(
  "custom context menus inherit, snapshot after menuSelect, select and release their DOM",
  async (evaluate, send) => {
    const at = await call<number[]>(
      evaluate,
      `(async () => {
    window.menuLines = [];
    window.menuTrace = line => menuLines.push(line);
    window.menuPlayer = document.createElement("swf2es-player");
    // Without the performance meter's item, as an embedder may leave it out: About comes last alone.
    menuPlayer.setAttribute("performancemeter", "false");
    menuPlayer.style.cssText = "position:fixed;left:0;top:0;z-index:1000";
    document.body.append(menuPlayer);
    await menuPlayer.load("/web-test/context-menu.swf");
    menuPlayer.focus();
    window.menuHost = () => menuPlayer.shadowRoot.querySelector("[data-swf2es-context-menu]");
    window.menuButtons = () => Array.from(menuHost().shadowRoot.querySelectorAll("button"));
    const r = menuPlayer.getBoundingClientRect();
    return [r.x, r.y];
  })()`,
    );
    const open = async (x = 45, y = 45) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: at[0] + x,
          y: at[1] + y,
          button: type === "mouseMoved" ? "none" : "right",
          clickCount: 1,
        });
      }
    };
    const key = async (name: string, code: number) => {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: name, windowsVirtualKeyCode: code });
      }
    };
    try {
      await open();
      assert.deepEqual(
        await call(evaluate, `menuButtons().map(b => [b.textContent, b.disabled])`),
        [
          ["Action 1", false],
          ["Disabled", true],
          ["<b>Literal</b>", false],
          ["About swf2es", false],
        ],
      );
      assert.equal(await call(evaluate, 'menuHost().shadowRoot.querySelectorAll("b").length'), 0);
      assert.equal(
        await call(evaluate, 'menuHost().shadowRoot.querySelectorAll("[role=separator]").length'),
        2,
      );
      assert.deepEqual(await call(evaluate, "menuLines"), [
        ["menuSelect", "menu", "child", "owner", false, false, 2],
      ]);
      assert.equal(
        await call(
          evaluate,
          `(() => {
      const h = menuHost(), r = h.getBoundingClientRect();
      return h.matches(":popover-open") && r.bottom > menuPlayer.getBoundingClientRect().bottom;
    })()`,
        ),
        true,
      );
      // Opened by the pointer, no item has focus until a key moves it there.
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement?.getAttribute('role')"),
        "menu",
      );
      // Focused, the menu draws no focus ring: its items show focus, and the ring's square corners
      // stood out past the rounded border.
      assert.equal(
        await call(
          evaluate,
          'getComputedStyle(menuHost().shadowRoot.querySelector("[role=menu]")).outlineStyle',
        ),
        "none",
      );
      await key("ArrowDown", 40);
      await key("ArrowDown", 40);
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement.textContent"),
        "<b>Literal</b>",
      );
      await key("Home", 36);
      await key("Enter", 13);
      assert.equal(await call(evaluate, "menuHost() === null"), true);
      assert.deepEqual(await call(evaluate, "menuLines[1]"), [
        "menuItemSelect",
        "item",
        "child",
        "owner",
        false,
        false,
        2,
      ]);
      assert.equal(await call(evaluate, "document.activeElement === menuPlayer"), true);

      await open();
      await key("ArrowUp", 38);
      assert.equal(
        await call(evaluate, "menuHost().shadowRoot.activeElement.textContent"),
        "About swf2es",
        "ArrowUp with no item focused goes to the last",
      );
      await call(evaluate, "window.cancelledMenuButton = menuButtons()[0]; true");
      await key("Escape", 27);
      await call(evaluate, "cancelledMenuButton.click(); true");
      assert.equal(await call(evaluate, "menuHost() === null"), true);
      assert.equal(
        await call(evaluate, 'menuLines.filter(x => x[0] === "menuItemSelect").length'),
        1,
      );

      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type,
          key: "F10",
          code: "F10",
          windowsVirtualKeyCode: 121,
          modifiers: 8,
        });
      }
      assert.equal(await call(evaluate, "menuHost() !== null"), true, "Shift+F10 opens the menu");
      assert.equal(
        await call(
          evaluate,
          "menuHost().shadowRoot.activeElement === menuButtons().find((b) => !b.disabled)",
        ),
        true,
        "a menu opened from the keyboard focuses its first item",
      );
      await key("Escape", 27);

      await call(evaluate, 'menuPlayer.menuMode("own"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuLines[menuLines.length - 1]"), [
        "menuSelect",
        "menu",
        "child",
        "child",
        false,
        false,
        2,
      ]);
      const clicked = await call<number[]>(
        evaluate,
        `(() => {
      const r = menuButtons()[0].getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: clicked[0],
          y: clicked[1],
          button: "left",
          clickCount: 1,
        });
      }
      assert.deepEqual(await call(evaluate, "menuLines[menuLines.length - 1]"), [
        "menuItemSelect",
        "item",
        "child",
        "child",
        false,
        false,
        2,
      ]);

      await open(160, 90);
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "Root action",
        "About swf2es",
      ]);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 300,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 300,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      assert.equal(await call(evaluate, "menuHost() === null"), true);

      // NativeMenu.display: the same menu, at its point on the stage, with no About.
      await call(evaluate, 'menuPlayer.menuMode("display"); true');
      assert.equal(
        await call(
          evaluate,
          `(async () => {
        for (let i = 0; i < 100 && !menuHost(); i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return menuHost() !== null;
      })()`,
        ),
        true,
        "display shows the menu",
      );
      assert.deepEqual(
        await call(evaluate, "menuButtons().map(b => [b.textContent, b.disabled])"),
        [
          ["Pick", false],
          ["Off", true],
        ],
      );
      assert.equal(await call(evaluate, 'menuHost().shadowRoot.querySelectorAll("hr").length'), 1);
      const shownAt = await call<number[]>(
        evaluate,
        "(() => { const r = menuHost().getBoundingClientRect(); return [r.x, r.y]; })()",
      );
      assert.deepEqual(
        shownAt.map((v) => Math.round(v)),
        [at[0] + 60, at[1] + 70],
      );
      const pick = await call<number[]>(
        evaluate,
        `(() => {
      const r = menuButtons()[0].getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x: pick[0],
          y: pick[1],
          button: "left",
          clickCount: 1,
        });
      }
      assert.equal(await call(evaluate, "menuHost() === null"), true);
      assert.deepEqual(await call(evaluate, "menuLines[menuLines.length - 1]"), [
        "select",
        "Pick",
        3,
      ]);

      await call(evaluate, 'menuPlayer.menuMode("defaults"); true');
      await open();
      assert.equal(
        await call(
          evaluate,
          'menuButtons().filter(b => b.textContent.startsWith("Quality:")).length',
        ),
        4,
      );
      await key("Escape", 27);
      await call(evaluate, 'menuPlayer.setAttribute("menu", "false"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "About swf2es",
      ]);
      await key("Escape", 27);
      await call(evaluate, 'menuPlayer.removeAttribute("menu"); true');
      await call(evaluate, 'menuPlayer.menuMode("noDefaults"); true');
      await open();
      assert.deepEqual(await call(evaluate, "menuButtons().map(b => b.textContent)"), [
        "About swf2es",
      ]);
      await key("Escape", 27);
      await call(
        evaluate,
        `(() => {
        window.preventMenu = e => e.preventDefault();
        menuPlayer.shadowRoot.querySelector("canvas").addEventListener("contextmenu", preventMenu, {capture:true});
        return true;
      })()`,
      );
      await open();
      assert.equal(
        await call(evaluate, "menuHost() === null"),
        true,
        "an embedder can replace the menu",
      );
      await key("ContextMenu", 93);
      assert.equal(
        await call(evaluate, "menuHost() === null"),
        true,
        "keyboard opening honors cancellation",
      );
      await call(
        evaluate,
        `menuPlayer.shadowRoot.querySelector("canvas").removeEventListener("contextmenu", preventMenu, {capture:true}); true`,
      );
      const fullscreen = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
        expression: "menuPlayer.requestFullscreen()",
        userGesture: true,
        awaitPromise: true,
      });
      assert.equal(fullscreen.exceptionDetails, undefined);
      await key("ContextMenu", 93);
      assert.equal(
        await call(
          evaluate,
          'document.fullscreenElement === menuPlayer && menuHost()?.matches(":popover-open")',
        ),
        true,
      );
      await call(evaluate, "menuPlayer.destroy(); true");
      assert.equal(await call(evaluate, "menuHost() === null"), true);
    } finally {
      await call(
        evaluate,
        "(async () => { menuPlayer.destroy(); if (document.fullscreenElement) await document.exitFullscreen(); menuPlayer.remove(); delete window.menuTrace; return true; })()",
      );
    }
  },
);

check(
  "Stage.displayState takes the element full screen on a click, where allowfullscreen lets it, and back",
  async (evaluate, send) => {
    const at = await call<number[]>(
      evaluate,
      `(async () => {
    window.fsLines = [];
    window.fsTrace = line => fsLines.push(line);
    window.fsPlayer = document.createElement("swf2es-player");
    fsPlayer.style.cssText = "position:fixed;left:0;top:0;z-index:1000";
    document.body.append(fsPlayer);
    await fsPlayer.load("/web-test/full-screen.swf");
    window.fsCanvas = () => {
      const r = fsPlayer.shadowRoot.querySelector("canvas").getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map(Math.round);
    };
    const r = fsPlayer.getBoundingClientRect();
    return [r.x, r.y];
  })()`,
    );
    const click = async () => {
      const point = { x: at[0] + 50, y: at[1] + 60, button: "left", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
    };
    const until = async (what: string, expression: string) => {
      for (let i = 0; i < 100; i++) {
        if (await call<boolean>(evaluate, expression)) {
          return;
        }

        await new Promise((done) => setTimeout(done, 50));
      }

      assert.fail(`${what}: ${JSON.stringify(await call(evaluate, "fsLines"))}`);
    };
    const lines = () => call<string[]>(evaluate, "fsLines.splice(0)");
    try {
      // As Flash Player's plug-in without allowFullScreen: refused, click or no click.
      assert.equal(await call(evaluate, "fsPlayer.fsState()"), "normal false false");
      await click();
      await until("the click's answer", "fsLines.length > 0");
      assert.deepEqual(await lines(), ["click refused 2152"]);
      assert.equal(await call(evaluate, "document.fullscreenElement === null"), true);

      // With it, a click's handler enters: the state and its event before the setter returns.
      await call(evaluate, 'fsPlayer.setAttribute("allowfullscreen", "true"); true');
      assert.equal(await call(evaluate, "fsPlayer.fsState()"), "normal true false");
      await click();
      await until("full screen", "document.fullscreenElement === fsPlayer");
      assert.deepEqual(await lines(), ["event true false fullScreen", "click fullScreen"]);
      // Its source rect, the stage's left half of 100 by 120, fitted to the screen and centred.
      const [width, height] = await call<number[]>(evaluate, "[innerWidth, innerHeight]");
      const scale = Math.min(width / 100, height / 120);
      await until(
        "the source rect on the screen",
        `JSON.stringify(fsCanvas()) === ${JSON.stringify(
          JSON.stringify(
            [(width - 100 * scale) / 2, (height - 120 * scale) / 2, 100 * scale, 120 * scale].map(
              Math.round,
            ),
          ),
        )}`,
      );
      // The interactive kind is not allowed: refused, and the stage stays as it is.
      assert.equal(await call(evaluate, 'fsPlayer.fsAsk("fullScreenInteractive")'), "refused 2152");
      assert.equal(await call(evaluate, "fsPlayer.fsState()"), "fullScreen true false");

      // The browser leaves, as on the user's Esc: the stage hears of it.
      await call(evaluate, "document.exitFullscreen().then(() => true)");
      await until("the stage's event", "fsLines.length > 0");
      assert.deepEqual(await lines(), ["event false false normal"]);
      assert.equal(await call(evaluate, "fsPlayer.fsState()"), "normal true false");
      await until("the whole stage again", "fsCanvas()[2] === 200 && fsCanvas()[3] === 120");

      // With no click to answer, the request is refused, as Flash refused it: entering used the last one up.
      assert.equal(await call(evaluate, 'fsPlayer.fsAsk("fullScreen")'), "refused 2152");
      assert.deepEqual(await lines(), []);

      // In by a click, with the keys too once allowed, and out by the script.
      await call(evaluate, 'fsPlayer.setAttribute("allowfullscreeninteractive", "true"); true');
      await click();
      await until("full screen again", "document.fullscreenElement === fsPlayer");
      assert.equal(
        await call(evaluate, 'fsPlayer.fsAsk("fullScreenInteractive")'),
        "fullScreenInteractive",
      );
      assert.equal(await call(evaluate, 'fsPlayer.fsAsk("normal")'), "normal");
      await until("the page out of full screen", "document.fullscreenElement === null");
      assert.deepEqual(await lines(), [
        "event true false fullScreen",
        "click fullScreen",
        "event false false normal",
      ]);

      // In and straight out again within one gesture, before the browser has entered: the
      // page leaves once it is in, and its late word of the entry puts the stage back in nothing.
      const bounced = await send<{ result?: { value?: string } }>("Runtime.evaluate", {
        expression: "fsPlayer.fsBounce()",
        userGesture: true,
        returnByValue: true,
      });
      assert.equal(bounced.result?.value, "fullScreen normal");
      await call(
        evaluate,
        "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 500))))",
      );
      await until("the page out of full screen", "document.fullscreenElement === null");
      assert.equal(await call(evaluate, "fsPlayer.fsState()"), "normal true true");
      assert.deepEqual(await lines(), ["event true false fullScreen", "event false false normal"]);

      // A full screen the page asked for itself is the stage's too, and a destroy gives it back.
      const asked = await send<{ exceptionDetails?: object }>("Runtime.evaluate", {
        expression: "fsPlayer.requestFullscreen()",
        userGesture: true,
        awaitPromise: true,
      });
      assert.equal(asked.exceptionDetails, undefined);
      await until("the stage's event", "fsLines.length > 0");
      assert.deepEqual(await lines(), ["event true false fullScreen"]);
      await call(evaluate, "fsPlayer.destroy(); true");
      await until("the screen given back", "document.fullscreenElement === null");
    } finally {
      await call(
        evaluate,
        "(async () => { fsPlayer.destroy(); if (document.fullscreenElement) await document.exitFullscreen(); fsPlayer.remove(); delete window.fsTrace; return true; })()",
      );
    }
  },
);

const failures = await withPage(
  "survivors",
  async (evaluate, send, fresh, listen) => {
    // What the page threw, told with a failing check: an error of its own, not a time out.
    const thrown: string[] = [];
    listen("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "warning") {
        return;
      }

      const args = params.args as { value?: unknown }[];
      const message = args.map((arg) => String(arg.value ?? "")).join(" ");
      if (message.includes("destroyed while still bound")) {
        boundTextureWarnings.push(message);
      }
    });
    listen("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        text: string;
      };
      thrown.push(details.exception?.description ?? details.text);
    });
    // Two device pixels a CSS pixel, as on a high-density display.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await fresh();
    // Under a loaded run, the browser has failed to fetch one of the
    // package's many unbundled modules, and keeps that failure for the
    // document. A fetch failure alone is tried again, in a new document,
    // twice at most; any other failure, or a third, is the checks' to report.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failure = (await evaluate<string | null>("loaded()")).value ?? null;
      if (failure === null || !/Failed to fetch dynamically imported module/.test(failure)) {
        break;
      }

      console.log(`  the page's import failed (${failure}); loading it again`);
      await fresh();
    }

    let failed = 0;
    for (const [name, run] of checks) {
      try {
        await run(evaluate, send);
        console.log(`ok ${name}`);
      } catch (e) {
        failed++;
        console.log(`not ok ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
        for (const text of thrown.splice(0)) {
          console.log(`  the page threw: ${text}`);
        }
      }
    }

    return failed;
  },
  // Software GL by default; SWF2ES_WEB_GPU=1 draws on the GPU, whose multisampling may go past 4.
  process.env.SWF2ES_WEB_GPU === "1",
  {
    page: "web-test/index.html",
    mounts: [
      ["/web-test/", site],
      ["/web-src/", here],
      ["/libraries/", `${out}libraries/`],
    ],
  },
);

// On a page that is not cross-origin isolated, workers pass messages as on
// one that is, and sharing memory with one says it needs isolation; the
// Web Workers started ahead go once the page's last player has.
const unisolated = await withPage(
  "workerRun",
  async (evaluate) => {
    try {
      const basics = await call<WorkerRun>(
        evaluate,
        `workerRun("/web-test/worker-basics.swf", {}, {}, ${JSON.stringify(workerBasicsTrace.at(-1))})`,
      );
      assert.deepEqual(basics.errors, []);
      assert.deepEqual(own(basics.traces), workerBasicsTrace);
      const mutex = await call<WorkerRun>(
        evaluate,
        `workerRun("/web-test/worker-mutex.swf", {}, {}, "free true")`,
      );
      assert.deepEqual(mutex.traces, []);
      assert.match(
        mutex.errors.join("\n"),
        /sharing a Mutex with another worker needs shared memory, which a browser gives only a cross-origin isolated page/,
      );
      const start = Date.now();
      let live = -1;
      while (live !== 0 && Date.now() - start < 30_000) {
        await new Promise((done) => setTimeout(done, 250));
        live = (await call<{ live: number }>(evaluate, "webWorkers()")).live;
      }

      assert.equal(live, 0, "the Web Workers started ahead outlived the last player");
      console.log("ok workers on a page that is not isolated, and let go after the last player");
      return 0;
    } catch (e) {
      console.log(
        `not ok workers on a page that is not isolated\n  ${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
  },
  false,
  {
    page: "web-test/workers.html",
    isolated: false,
    mounts: [
      ["/web-test/", site],
      ["/web-src/", here],
      ["/libraries/", `${out}libraries/`],
    ],
  },
);

let fillFailures = 0;
let fillReference: Image | null = null;
// Drawn by the render module; where the page cannot compile it (blocked, a CSP without
// 'wasm-unsafe-eval'), no playback, and the element says why. The player loads the module with
// itself, so a page without it has no player at all.
for (const mode of ["default", "blocked", "csp"] as const) {
  try {
    await withPage(
      "fillRun",
      async (evaluate, send) => {
        const r = await call<{
          rect: [number, number, number, number];
          compiles: number;
          instances: number;
          error: string | null;
        }>(evaluate, `fillRun(${JSON.stringify(mode)})`);
        if (mode !== "default") {
          assert.ok(r.error, "a page that cannot run the render module played");
          assert.equal(r.instances, 0);
          assert.ok(r.compiles > 0, "the module was not compiled");

          return;
        }

        assert.equal(r.error, null);
        const [x, y, width, height] = r.rect;
        const shot = await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { x, y, width, height, scale: 1 },
        });
        const image = decodePng(Buffer.from(shot.data, "base64"));
        for (const [index, color] of [
          [15, [255, 0, 0, 255]],
          [45, [0, 255, 0, 255]],
          [75, [0, 0, 255, 255]],
        ] as const) {
          const at = (20 * image.width + index) * 4;
          assert.deepEqual(Array.from(image.data.subarray(at, at + 4)), color);
        }
        if (fillReference) {
          assert.equal(compareImages(image, fillReference, 0).outliers, 0);
        } else {
          fillReference = image;
        }

        // One compile for the page; each playback's tessellator an instance, and no line builder's,
        // as fills.swf has no lines.
        assert.equal(r.compiles, 1);
        assert.equal(r.instances, 3);

        await call(evaluate, "fillDestroy()");
        await send("HeapProfiler.collectGarbage");
        await send("HeapProfiler.collectGarbage");
        assert.equal(
          await call(evaluate, "fillSurvivors()"),
          0,
          "native memory outlived the playbacks",
        );
      },
      false,
      {
        page: mode === "csp" ? "web-test/fills-csp.html" : "web-test/workers.html",
        mounts: [
          ["/web-test/", site],
          ["/web-src/", here],
          ["/libraries/", `${out}libraries/`],
        ],
      },
    );
    console.log(`ok native fills: ${mode}`);
  } catch (error) {
    fillFailures++;
    console.log(
      `not ok native fills: ${mode}\n  ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}

let bitmapFailures = 0;
for (const vm of ["as3", "avm1"]) {
  let reference: string[] | null = null;
  let imageReference: Image | null = null;
  // Where the page cannot compile the render module, nothing plays (native fills, above).
  for (const mode of ["default", "trap"]) {
    try {
      await withPage(
        "bitmapRun",
        async (evaluate, send) => {
          const result = await call<{
            traces: string[];
            errors: string[];
            calls: number;
            instances: number;
            rect: [number, number, number, number];
          }>(evaluate, `bitmapRun(${JSON.stringify(mode)}, ${JSON.stringify(vm)})`);
          assert.deepEqual(result.errors, []);
          assert.equal(result.traces.length, 1);
          if (reference) {
            assert.deepEqual(result.traces, reference);
          } else {
            reference = result.traces;
          }

          const [x, y, width, height] = result.rect;
          const shot = await send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            clip: { x, y, width, height, scale: 1 },
          });
          const image = decodePng(Buffer.from(shot.data, "base64"));
          if (imageReference) {
            assert.equal(compareImages(image, imageReference, 0).outliers, 0);
          } else {
            imageReference = image;
          }

          // One kernel for the page's players, each of which convolves twice, blurs and glows; the
          // first call of each kind trapped and made again in a new instance.
          assert.equal(result.calls, mode === "trap" ? 15 : 12);
          assert.equal(result.instances, mode === "trap" ? 4 : 1);

          await call(evaluate, "bitmapDestroy()");
          await send("HeapProfiler.collectGarbage");
          await send("HeapProfiler.collectGarbage");
          // The page's kernel keeps its instance for the next player; the rest go with theirs.
          assert.ok((await call<number>(evaluate, "bitmapSurvivors()")) <= 1);
        },
        false,
        {
          page: "web-test/workers.html",
          mounts: [
            ["/web-test/", site],
            ["/web-src/", here],
            ["/libraries/", `${out}libraries/`],
          ],
        },
      );
      console.log(`ok native bitmaps: ${vm} ${mode}`);
    } catch (error) {
      bitmapFailures++;
      console.log(
        `not ok native bitmaps: ${vm} ${mode}\n  ${error instanceof Error ? error.stack : String(error)}`,
      );
    }
  }
}

try {
  await withPage(
    "fillRun",
    async (evaluate) => {
      const result = await call(
        evaluate,
        `import("@swf2es/native/render").then(({BitmapKernel}) => {
      try {
        new BitmapKernel();
        return false;
      } catch {
        return true;
      }
    })`,
      );
      assert.equal(
        result,
        true,
        "a CSP that refuses the module must refuse the kernel as it is made",
      );
    },
    false,
    {
      page: "web-test/fills-csp.html",
      mounts: [
        ["/web-test/", site],
        ["/web-src/", here],
        ["/libraries/", `${out}libraries/`],
      ],
    },
  );
  console.log("ok native bitmaps: CSP refusal");
} catch (error) {
  bitmapFailures++;
  console.log(
    `not ok native bitmaps: CSP refusal\n  ${error instanceof Error ? error.stack : String(error)}`,
  );
}

// Under Chrome's autoplay rule as a page meets it, each run a page of its own, which no gesture
// has reached yet: the sound a SWF streams waits, the element says so and shows its button, a
// click on which lets it play, reaches the SWF no further and leaves it the keys; or a click on
// the stage, which the SWF hears, before the hold is told or after. A SWF destroyed while held
// is held no more.
interface UnmuteState {
  events: string[];
  traces: string[];
  button: { label: string; text: string; focusable: boolean; center: [number, number] } | null;
  context: string | null;
  starts: string[];
  focused: boolean;
}
type Unmute = "button" | "stage" | "early stage" | "destroy";
let unmuteFailures = 0;
for (const [name, src, attributes, unmute] of [
  ["a script-free SWF's stream, unmuted by the button", "tone-avm1.swf", {}, "button"],
  ["a code-free AS3 SWF's stream, unmuted by the button", "tone-as3-bare.swf", {}, "button"],
  [
    "an AS3 SWF's stream, unmuted by the button, then its keys and the stage",
    "tone-as3.swf",
    {},
    "button",
  ],
  [
    "an AS3 SWF's stream, no button, unmuted by the stage",
    "tone-as3.swf",
    { unmuteprompt: "false" },
    "stage",
  ],
  [
    "an AS3 SWF's stream, unmuted by the stage before it is told as held",
    "tone-as3.swf",
    {},
    "early stage",
  ],
  ["a held SWF destroyed, its hold ended with it", "tone-avm1.swf", {}, "destroy"],
] as [string, string, Record<string, string>, Unmute][]) {
  try {
    await withPage(
      "unmutePlayer",
      async (evaluate, send) => {
        const state = () => call<UnmuteState>(evaluate, "unmuteState()");
        const until = async (what: string, test: (s: UnmuteState) => boolean) => {
          const start = Date.now();
          let last = await state();
          while (!test(last)) {
            if (Date.now() - start > 15_000) {
              assert.fail(`${what}: ${JSON.stringify(last)}`);
            }

            await new Promise((done) => setTimeout(done, 50));
            last = await state();
          }

          return last;
        };
        const click = async (x: number, y: number) => {
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          for (const type of ["mousePressed", "mouseReleased"]) {
            await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
          }
        };
        // A page with the focus, as one a person looks at, whose element's focus can be lost.
        await send("Emulation.setFocusEmulationEnabled", { enabled: true });
        const [left, top] = await call<[number, number]>(
          evaluate,
          `unmutePlayer(${JSON.stringify(`/web-test/${src}`)}, ${JSON.stringify(attributes)})`,
        );
        let destroyed = false;
        try {
          if (unmute === "early stage") {
            // Two frames in, well within the wait: the SWF hears the press as the sound runs.
            await call(evaluate, "frames(2).then(() => true)");
            await click(left + 10, top + 10);
            const playing = await until("the stream started", (s) => s.starts.length > 0);
            assert.deepEqual(playing.starts, ["running"]);
            const pressed = await until("the stage's press", (s) => s.traces.length > 0);
            assert.deepEqual(pressed.traces, ["unmute: down 10 10"]);
            // Past the wait after which a sound held would have been told.
            await new Promise((done) => setTimeout(done, 1500));
            const after = await state();
            assert.deepEqual(after.events, [], "a sound the click let run was told as held");
            assert.equal(after.button, null);
            return;
          }

          const blocked = await until("the sound held", (s) => s.events.length > 0);
          assert.deepEqual(blocked.events, ["audioblocked"]);
          assert.equal(blocked.context, "suspended");
          assert.deepEqual(blocked.starts, [], "the stream started on a held context");
          if (unmute === "destroy") {
            assert.ok(blocked.button);
            await call(evaluate, "unmuteDestroy()");
            destroyed = true;
            assert.deepEqual(await call(evaluate, "unmuteEvents()"), [
              "audioblocked",
              "audiounblocked",
            ]);
            return;
          }

          if (unmute === "button") {
            assert.ok(blocked.button, "no unmute button");
            assert.equal(blocked.button.label, "Click to unmute the sound");
            assert.equal(blocked.button.text, "Click to unmute");
            assert.ok(blocked.button.focusable);
            // A script's click is no gesture: the sound stays held, and the button with it.
            await call(evaluate, "unmuteScriptClick()");
            await new Promise((done) => setTimeout(done, 300));
            const scripted = await state();
            assert.equal(scripted.context, "suspended");
            assert.ok(scripted.button, "a script's click hid the button");
            await click(...blocked.button.center);
          } else {
            assert.equal(blocked.button, null, "a button though the element says none");
            await click(left + 10, top + 10);
          }

          const unblocked = await until("the sound let go", (s) => s.events.length > 1);
          assert.deepEqual(unblocked.events, ["audioblocked", "audiounblocked"]);
          assert.equal(unblocked.button, null, "the button outlived the sound's hold");
          assert.equal(unblocked.context, "running");
          assert.ok(unblocked.focused, "the element lost the focus");
          const playing = await until("the stream started", (s) => s.starts.length > 0);
          assert.deepEqual(playing.starts, ["running"]);
          if (src === "tone-as3.swf") {
            // A few frames for a press to reach the SWF, if it went through the button.
            await new Promise((done) => setTimeout(done, 300));
            const expected: string[] = [];
            if (unmute === "button") {
              assert.deepEqual((await state()).traces, [], "the button's press reached the SWF");
              // The keys are the SWF's still.
              for (const type of ["keyDown", "keyUp"]) {
                await send("Input.dispatchKeyEvent", {
                  type,
                  key: "a",
                  code: "KeyA",
                  windowsVirtualKeyCode: 65,
                  ...(type === "keyDown" ? { text: "a" } : {}),
                });
              }

              await until("the key", (s) => s.traces.length > 0);
              expected.push("unmute: key 65");
              await click(left + 10, top + 10);
            }

            expected.push("unmute: down 10 10");
            const pressed = await until("the stage's press", (s) =>
              s.traces.includes("unmute: down 10 10"),
            );
            assert.deepEqual(pressed.traces, expected);
          }
        } finally {
          if (!destroyed) {
            await call(evaluate, "unmuteDestroy()");
          }
        }
      },
      false,
      {
        page: "web-test/workers.html",
        args: ["--autoplay-policy=document-user-activation-required"],
        mounts: [
          ["/web-test/", site],
          ["/web-src/", here],
          ["/libraries/", `${out}libraries/`],
        ],
      },
    );
    console.log(`ok unmute: ${name}`);
  } catch (error) {
    unmuteFailures++;
    console.log(
      `not ok unmute: ${name}\n  ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}

const failed = failures + unisolated + fillFailures + bitmapFailures + unmuteFailures;
if (failed > 0) {
  console.log(`${failed} checks failed`);
  process.exitCode = 1;
}
