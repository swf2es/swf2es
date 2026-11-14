// Advanced text multi-drawn, its texts' rows and slots read by gl_DrawID, must draw exactly as
// text drawn a call each does without WEBGL_multi_draw, as in Firefox; so must a frame whose glyph
// runs pass the table's room, drawn a line of it at a time. Runs end at fills, masks, blends,
// cached and filtered layers, and one is longer than a line of the table.
import assert from "node:assert/strict";
import * as w from "../swf-writer.ts";
import { stemFont } from "./cases.ts";
import { withPage } from "./chrome.ts";
import { decodePng } from "./image.ts";
import { libraryAbcs } from "./libraries.ts";
import { compiler } from "./scripts.ts";

const RUN = 300;
const source = `package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.text.*;

  public class GlyphRuns extends Sprite {
    private var fields:Array = [];
    private var n:int = 0;

    public function GlyphRuns() {
      graphics.beginFill(0x808080);
      graphics.drawRect(0, 0, 400, 180);
      graphics.endFill();
      // Texts that overlap, alike but for their rows and slots: one run past a line of the table.
      for (var i:int = 0; i < ${RUN}; i++) {
        var t:TextField = field(i, 8 + (i % 3) * 2);
        t.x = (i % 15) * 26;
        t.y = int(i / 15) * 9;
        addChild(t);
      }

      // Texts after fills of their own: backgrounds and borders.
      for (i = 0; i < 6; i++) {
        t = field(i, 10);
        t.background = true;
        t.backgroundColor = 0xffe0c0 - i * 0x101010;
        t.border = i % 2 == 1;
        t.x = i * 64;
        t.y = 185;
        addChild(t);
      }

      // Texts masked, and a text as a mask.
      var masked:Sprite = new Sprite();
      for (i = 0; i < 4; i++) {
        t = field(i, 12);
        t.x = i * 40;
        masked.addChild(t);
      }

      var cut:Shape = new Shape();
      cut.graphics.beginFill(0);
      cut.graphics.drawRect(0, 2, 150, 8);
      cut.graphics.endFill();
      masked.addChild(cut);
      masked.mask = cut;
      masked.y = 205;
      addChild(masked);
      var under:Shape = new Shape();
      under.graphics.beginFill(0x3060a0);
      under.graphics.drawRect(0, 0, 180, 24);
      under.graphics.endFill();
      under.x = 200;
      under.y = 203;
      addChild(under);
      var shape:TextField = field(3, 18);
      shape.text = "WWmm aW";
      shape.x = 200;
      shape.y = 203;
      addChild(shape);
      under.mask = shape;
      holder(228).blendMode = BlendMode.MULTIPLY;
      holder(248).cacheAsBitmap = true;
      holder(268).filters = [new GlowFilter(0xff0000, 1, 3, 3)];
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function holder(y:Number):Sprite {
      var s:Sprite = new Sprite();
      for (var i:int = 0; i < 5; i++) {
        var t:TextField = field(i + 1, 10);
        t.x = i * 75;
        s.addChild(t);
      }

      s.y = y;
      addChild(s);
      return s;
    }

    private function field(i:int, size:int):TextField {
      var t:TextField = new TextField();
      t.embedFonts = true;
      t.antiAliasType = AntiAliasType.ADVANCED;
      t.gridFitType = [GridFitType.NONE, GridFitType.PIXEL, GridFitType.SUBPIXEL][i % 3];
      t.thickness = (i % 5) * 40 - 80;
      t.sharpness = (i % 7) * 60 - 180;
      t.defaultTextFormat = new TextFormat("Stem", size, [0x000000, 0xffffff, 0x2040c0, 0xc08020][i % 4]);
      t.autoSize = TextFieldAutoSize.LEFT;
      t.text = "aWml" + i;
      fields.push(t);
      return t;
    }

    private function frame(e:Event):void {
      n++;
      for (var i:int = n % 3; i < fields.length; i += 3) {
        fields[i].text = "Wl" + (i + n) + "am";
      }

      for (i = n % 5; i < fields.length; i += 5) {
        fields[i].x += 0.5;
      }
    }
  }
}`;
libraryAbcs();
const abc = compiler()("GlyphRuns", source);
const swf = w.swf({
  width: 400,
  height: 300,
  frameRate: 24,
  frameCount: 1,
  tags: [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    stemFont(1),
    w.doAbc(abc, "GlyphRuns"),
    w.symbolClass([[0, "GlyphRuns"]]),
    w.showFrame(),
    w.end(),
  ],
});
const capture = [1, 2, 3];

/** What the page is made to do before it plays: hide the extension, or keep the table to a line. */
const setup = (mode: "multi" | "line" | "single") => `(async () => {
  globalThis.largestMultiDraw = 0;
  const prototype = WebGL2RenderingContext.prototype;
  const getExtension = prototype.getExtension;
  prototype.getExtension = function (name) {
    if (name === "WEBGL_multi_draw" && ${mode === "single"}) {
      return null;
    }
    const extension = getExtension.call(this, name);
    if (name === "WEBGL_multi_draw" && extension && !extension.counted) {
      extension.counted = true;
      const draw = extension.multiDrawElementsWEBGL;
      extension.multiDrawElementsWEBGL = function (...args) {
        globalThis.largestMultiDraw = Math.max(globalThis.largestMultiDraw, args[6]);
        return draw.apply(this, args);
      };
    }
    return extension;
  };
  if (${mode === "line"}) {
    const { Draws } = await import("/render/webgl/draws.js");
    const setUp = Draws.prototype.setUp;
    Draws.prototype.setUp = function (textureMost) {
      setUp.call(this, textureMost);
      this.runTableMost = 1;
    };
  }
})()`;

const frames = new Map<string, { pixels: Map<number, Uint8Array>; largest: number }>();
await withPage("runSwf", async (evaluate, _send, fresh) => {
  for (const mode of ["single", "multi", "line"] as const) {
    await fresh();
    await evaluate(setup(mode));
    const { value, exception } = await evaluate<{
      images: Record<string, string>;
      error: string | null;
    }>(
      `runSwf(${JSON.stringify(Buffer.from(swf).toString("base64"))}, ${JSON.stringify({
        frames: capture.length,
        capture,
        quality: 2,
      })})`,
    );
    assert.equal(exception ?? value?.error ?? null, null, `${mode}: the SWF stopped`);
    const pixels = new Map<number, Uint8Array>();
    for (const [frame, url] of Object.entries(value?.images ?? {})) {
      pixels.set(Number(frame), decodePng(Buffer.from(url.split(",")[1], "base64")).data);
    }

    const largest = (await evaluate<number>("globalThis.largestMultiDraw")).value ?? 0;
    frames.set(mode, { pixels, largest });
  }
});

const single = frames.get("single");
assert.ok(single);
assert.equal(single.largest, 0, "drawn without WEBGL_multi_draw");
for (const frame of capture) {
  const expected = single.pixels.get(frame);
  assert.ok(expected, `frame ${frame} drawn a text a call`);
  assert.ok(
    expected.some((v, i) => i % 4 !== 3 && v !== 255),
    `frame ${frame} drew text`,
  );
  for (const mode of ["multi", "line"]) {
    const actual = frames.get(mode)?.pixels.get(frame);
    assert.ok(actual, `frame ${frame} drawn (${mode})`);
    const at = actual.findIndex((v, i) => v !== expected[i]);
    assert.equal(at, -1, `frame ${frame} (${mode}) differs from a text a call at byte ${at}`);
  }
}

// The texts alike, one multi-draw; a line of the table at a time, RUN_MOST at most.
assert.ok((frames.get("multi")?.largest ?? 0) >= RUN, "a run of texts multi-drawn in one call");
assert.ok((frames.get("line")?.largest ?? 0) <= 256, "a run past the table's room drawn by lines");
console.log(`advanced text multi-drawn as drawn a call each: ${capture.length} frames, 3 ways`);
