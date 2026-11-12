// The player's AS3 cases (cases.ts): events, the natives, loads,
// workers, application domains and the stage's children.
import { readFileSync } from "node:fs";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import {
  bare,
  innerSwf,
  type PlayerCase,
  probeFont,
  rectPath,
  scripted,
  square,
} from "./common.ts";

// A sprite with one child, bound to a class the script constructs during
// its initializer and again later (scripts/Init.as).
function bound(abc: Uint8Array): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      w.doAbc(abc, "Init"),
      w.symbolClass([
        [0, "Main"],
        [2, "Box"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Clips of a square, two MorphShapes growing a square and three empty
// text fields, side by side, which frames 2 to 4 move with every property a place sets, for
// scripts/ScriptedMoves.as to touch, then a loop back to frame 1's places.
function scriptedMoves(abc: Uint8Array): Uint8Array {
  const grow = w.morphShape({
    id: 3,
    startBounds: [0, 400, 0, 400],
    endBounds: [0, 800, 0, 800],
    fills: [{ start: 0xff0000cc, end: 0xff00cc00 }],
    lines: [],
    start: [{ fill0: 1, commands: rectPath(0, 0, 20, 20) }],
    end: [rectPath(0, 0, 40, 40)],
  });
  const count = 29;
  const morph = (i: number) => i === 23 || i === 24;
  const field = (i: number) => i >= 25 && i <= 27;
  const at = (i: number, dx: number) => ({ tx: (i * 38 + dx) * 20, ty: 400 });
  const each = (f: (i: number) => Uint8Array) => Array.from({ length: count }, (_, i) => f(i));
  return w.swf({
    version: 10,
    width: 1120,
    height: 100,
    frameRate: 24,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      square(1, 0x806040, 400),
      w.sprite(2, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
      grow,
      w.editText(4, "", 400, 400),
      w.doAbc(abc, "ScriptedMoves"),
      w.symbolClass([[0, "Main"]]),
      ...each((i) =>
        w.place({ depth: i + 1, character: morph(i) ? 3 : field(i) ? 4 : 2, matrix: at(i, 0) }),
      ),
      w.showFrame(),
      ...each((i) =>
        w.place({
          depth: i + 1,
          move: true,
          matrix: at(i, 10),
          colorTransform: { mult: [0.5, 1, 1, 0.75] },
          ratio: morph(i) ? 32768 : undefined,
          blurs: [2],
          blendMode: 3,
          visible: false,
        }),
      ),
      w.showFrame(),
      ...each((i) =>
        w.place({
          depth: i + 1,
          move: true,
          matrix: { ...at(i, 20), a: 1.5, d: 1.5 },
          colorTransform: { mult: [1, 1, 1, 1], add: [100, 0, 0, 0] },
          ratio: morph(i) ? 65535 : undefined,
          blurs: [],
          blendMode: 6,
          visible: true,
        }),
      ),
      w.showFrame(),
      ...each((i) => w.place({ depth: i + 1, move: true, matrix: at(i, 30) })),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

function loads(compile: Compile): Uint8Array {
  return loading(compile, "Loads", 2);
}

// ApplicationDomain.currentDomain is the domain of the code that asks
// (scripts/CurrentDomain.as.template): the main SWF's, before and after
// it loads a SWF into a child domain, and the loaded SWF's in its own
// code (scripts/CurrentDomainChild.as), whose second DoABC defines a class
// only it sees. The domain is found from the script each frame of the
// stack names, which JavaScriptCore gives no Function's code.
function currentDomain(compile: Compile): Uint8Array {
  const inner = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(compile("CurrentDomainOnly"), "CurrentDomainOnly"),
      w.doAbc(compile("CurrentDomainChild"), "CurrentDomainChild"),
      w.symbolClass([[0, "CurrentDomainChild"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(
    new URL("../scripts/CurrentDomain.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "CurrentDomain",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 4,
    tags: [
      w.fileAttributes(true),
      w.doAbc(abc, "CurrentDomain"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// The same, unloading from INIT (scripts/LoadsInit.as.template). The inner
// SWF has one frame: a clip taken off the display list plays on in Flash,
// which is not this case's.
// A document class that looks definitions up (scripts/Definitions.as), and
// lazy DoABCs whose scripts throw when they run (scripts/DefinitionsBad.as,
// scripts/DefinitionsIndirect.as).
function definitions(compile: Compile): Uint8Array {
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(compile("DefinitionsBad"), "DefinitionsBad", true),
      w.doAbc(compile("DefinitionsIndirect"), "DefinitionsIndirect", true),
      w.doAbc(compile("Definitions"), "Definitions"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// loaderInfo.parameters of SWFs loaded from bytes with a LoaderContext's
// (scripts/LoaderParameters.as.template, scripts/ParametersInner.as).
function loaderParameters(compile: Compile): Uint8Array {
  const inner = bare(compile("ParametersInner"), 1, "ParametersInner");
  const template = readFileSync(
    new URL("../scripts/LoaderParameters.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "LoaderParameters",
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return bare(abc, 3);
}

// Errors nothing catches, told to uncaughtErrorEvents (scripts/UncaughtErrors.as.template):
// the main SWF's, a loaded SWF's (scripts/UncaughtErrorsChild.as) and one whose
// document class's constructor throws (scripts/UncaughtErrorsBad.as).
function uncaughtErrors(compile: Compile): Uint8Array {
  const inner = bare(compile("UncaughtErrorsChild"), 2, "UncaughtErrorsChild");
  const bad = bare(compile("UncaughtErrorsBad"), 1, "UncaughtErrorsBad");
  const template = readFileSync(
    new URL("../scripts/UncaughtErrors.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "UncaughtErrors",
    template
      .replaceAll("@@INNER@@", Buffer.from(inner).toString("base64"))
      .replaceAll("@@BAD@@", Buffer.from(bad).toString("base64")),
  );
  return bare(abc, UNCAUGHT_FRAMES);
}

/** A step every third frame, 32 of them, after the load. */
const UNCAUGHT_FRAMES = 110;

function loadsInit(compile: Compile): Uint8Array {
  return loading(compile, "LoadsInit", 1);
}

function loading(compile: Compile, script: string, innerFrames: number): Uint8Array {
  const inner = innerSwf(compile("Inner"), innerFrames);
  const template = readFileSync(
    new URL(`../scripts/${script}.as.template`, import.meta.url),
    "utf8",
  );
  const abc = compile(
    script,
    template.replaceAll("@@INNER@@", Buffer.from(inner).toString("base64")),
  );
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, script),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// When content from Loader.loadBytes comes (scripts/LoaderBytesFrames.as):
// a small SWF, and a large one of 200 classes' ABC and a megabyte of
// sounds, each in the frame after the call whatever its size, as adl has
// it. Their bytes are DefineBinaryData bound to ByteArray subclasses, too
// large for the script's source.
function loaderBytesFrames(compile: Compile): Uint8Array {
  const bytesClass = (name: string) =>
    compile(
      name,
      `package { import flash.utils.ByteArray; public class ${name} extends ByteArray { public function ${name}() { super(); } } }`,
    );
  const inner = (name: string, body: string, tags: Uint8Array[]) =>
    w.swf({
      width: 100,
      height: 50,
      frameRate: 24,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        ...tags,
        w.doAbc(
          compile(
            name,
            `package { import flash.display.MovieClip; public class ${name} extends MovieClip { public function ${name}() { ${body} addFrameScript(0, function():void { trace("${name} frame 1"); }); } } }`,
          ),
          name,
        ),
        w.symbolClass([[0, name]]),
        w.showFrame(),
        w.end(),
      ],
    });
  const classes = Array.from(
    { length: 200 },
    (_, c) =>
      `package { public class Many${c} { public static function f(x:int):int { var y:int = x; for (var i:int = 0; i < 4; i++) { y = (y ^ i) + ${c}; } return y; } public function g():String { return "${c}"; } } }`,
  );
  const sounds = Array.from({ length: 4 }, (_, k) => {
    const data = new Uint8Array(250_000);
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 7 + k) & 0xff;
    }

    return w.defineSound(
      10 + k,
      { rate: 3, sixteen: true, stereo: true, samples: data.length / 4 },
      data,
    );
  });
  const small = inner("SmallInner", `trace("SmallInner made");`, []);
  const large = inner("LargeInner", `trace("LargeInner made", Many0.f(1) + Many199.f(2));`, [
    ...sounds,
    w.doAbc(compile("ManyClasses", classes.join("\n")), "ManyClasses"),
  ]);
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.binaryData(1, small),
      w.binaryData(2, large),
      w.doAbc(bytesClass("SmallBytes"), "SmallBytes"),
      w.doAbc(bytesClass("LargeBytes"), "LargeBytes"),
      w.doAbc(compile("LoaderBytesFrames"), "LoaderBytesFrames"),
      w.symbolClass([
        [1, "SmallBytes"],
        [2, "LargeBytes"],
        [0, "Main"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
}

// What Crossbridge's runtime asks of the player as it starts
// (scripts/CrossbridgeRuntime.as): a ByteArray subclass bound to
// DefineBinaryData, as Crossbridge keeps a C program's data, among the rest.
function crossbridgeRuntime(compile: Compile): Uint8Array {
  const blob = compile(
    "Blob",
    "package { import flash.utils.ByteArray; public class Blob extends ByteArray { public function Blob() { super(); } } }",
  );
  const main = compile("CrossbridgeRuntime");
  return w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.binaryData(1, Uint8Array.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xfe, 1, 2])),
      w.doAbc(blob, "Blob"),
      w.doAbc(main, "CrossbridgeRuntime"),
      w.symbolClass([
        [1, "Blob"],
        [0, "CrossbridgeRuntime"],
      ]),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Seven red squares and seven texts, each but the first given a property
// of another value by scripts/ScriptedTouch.as on frame 1 (visible,
// cacheAsBitmap, a mask of its own, blendMode the same and another, and
// visible set and set back), and a larger blue square or another text put
// in each one's place with the move flag on frame 2.
function scriptedTouch(abc: Uint8Array): Uint8Array {
  const at = (x: number, y: number) => ({ tx: x * 20, ty: y * 20 });
  const columns = [0, 1, 2, 3, 4, 5, 6];
  return w.swf({
    width: 320,
    height: 140,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      probeFont(9),
      square(1, 0xff0000, 400),
      square(2, 0x0000ff, 600),
      square(3, 0x00aa00, 200),
      square(6, 0x0000ff, 400),
      w.staticText({
        id: 4,
        bounds: [0, 800, -600, 100],
        records: [{ font: 9, height: 600, color: 0x0000cc, x: 0, y: 0, glyphs: [[1, 400]] }],
      }),
      w.staticText({
        id: 5,
        bounds: [0, 800, -400, 800],
        records: [
          { font: 9, height: 400, color: 0xcc0000, x: 0, y: 0, glyphs: [[4, 400]] },
          { x: 0, y: 500, glyphs: [[3, 300]] },
        ],
      }),
      w.doAbc(abc, "ScriptedTouch"),
      w.symbolClass([[0, "Main"]]),
      ...columns.map((i) => w.place({ depth: 1 + i, character: 1, matrix: at(10 + i * 44, 20) })),
      ...columns.map((i) => w.place({ depth: 8 + i, character: 4, matrix: at(10 + i * 44, 100) })),
      w.place({ depth: 15, character: 3, matrix: at(142, 20) }),
      w.place({ depth: 16, character: 3, matrix: at(142, 85) }),
      w.place({ depth: 17, character: 1, matrix: at(10, 60) }),
      w.place({ depth: 18, character: 1, matrix: at(54, 60) }),
      w.showFrame(),
      ...columns.map((i) => w.place({ depth: 1 + i, move: true, character: 2 })),
      ...columns.map((i) => w.place({ depth: 8 + i, move: true, character: 5 })),
      w.place({ depth: 17, move: true, character: 6 }),
      w.place({ depth: 18, move: true, character: 6 }),
      w.showFrame(),
      w.end(),
    ],
  });
}

export const scriptingCases: PlayerCase[] = [
  {
    name: "air-float",
    swf: bare(
      new Uint8Array(readFileSync(new URL("../fixtures/AirFloat.abc", import.meta.url))),
      2,
      "AirFloat",
    ),
    frames: 2,
    capture: [],
    traced: true,
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "scripted-touch",
    swf: scriptedTouch,
    script: "ScriptedTouch",
    frames: 2,
    capture: [1, 2],
    tolerance: 32,
    maxOutliers: 60,
  },
  {
    name: "scripted",
    swf: scripted,
    script: "Main",
    frames: 2,
    capture: [1, 2],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "events",
    swf: bare,
    script: "Events",
    frames: 2,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "init",
    swf: bound,
    script: "Init",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "scripted-moves",
    swf: scriptedMoves,
    script: "ScriptedMoves",
    frames: 9,
    capture: [3, 4],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "root-added-to-stage",
    swf: (abc) => bare(abc, 1, "RootAddedToStage"),
    script: "RootAddedToStage",
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // Worker needs SWF 17; frames enough for Flash to start the worker and answer.
    name: "worker-basics",
    swf: (abc) => {
      const bytes = bare(abc, 1, "WorkerBasics");
      bytes[3] = 26;
      return bytes;
    },
    script: "WorkerBasics",
    frames: 120,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // Two workers writing one shareable ByteArray: needs a cross-origin isolated page.
    name: "worker-shared-bytes",
    swf: (abc) => {
      const bytes = bare(abc, 1, "WorkerSharedBytes");
      bytes[3] = 26;
      return bytes;
    },
    script: "WorkerSharedBytes",
    frames: 120,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    // A Mutex and a Condition shared with two workers, and receive(true): needs a cross-origin isolated page.
    name: "worker-mutex",
    swf: (abc) => {
      const bytes = bare(abc, 1, "WorkerMutex");
      bytes[3] = 26;
      return bytes;
    },
    script: "WorkerMutex",
    frames: 10,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "accessibility-natives",
    swf: (abc) => bare(abc, 1, "AccessibilityNatives"),
    script: "AccessibilityNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "currency-parse-result-natives",
    swf: (abc) => bare(abc, 1, "CurrencyParseResultNatives"),
    script: "CurrencyParseResultNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "touch-natives",
    swf: (abc) => bare(abc, 1, "TouchNatives"),
    script: "TouchNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // The events' fields as scripts read and write them: playerglobal keeps
  // them in AS3, which must look to describeType, coercion, clone and
  // dispatch as Flash's natives do.
  {
    name: "event-fields",
    swf: (abc) => bare(abc, 1, "EventFields"),
    script: "EventFields",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Natives that keep a value or answer a constant (contextMenu, TextRenderer,
  // selectedText and others), and the errors a wrong argument gives.
  {
    name: "small-natives",
    swf: (abc) => bare(abc, 1, "SmallNatives"),
    script: "SmallNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "number-parse-result-natives",
    swf: (abc) => bare(abc, 1, "NumberParseResultNatives"),
    script: "NumberParseResultNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "number-formatter-natives",
    swf: (abc) => bare(abc, 1, "NumberFormatterNatives"),
    script: "NumberFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "currency-formatter-natives",
    swf: (abc) => bare(abc, 1, "CurrencyFormatterNatives"),
    script: "CurrencyFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "date-time-formatter-natives",
    swf: (abc) => bare(abc, 1, "DateTimeFormatterNatives"),
    script: "DateTimeFormatterNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "collator-natives",
    swf: (abc) => bare(abc, 1, "CollatorNatives"),
    script: "CollatorNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "string-tools-natives",
    swf: (abc) => bare(abc, 1, "StringToolsNatives"),
    script: "StringToolsNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "locale-id-natives",
    swf: (abc) => bare(abc, 1, "LocaleIDNatives"),
    script: "LocaleIDNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sprite-drag-natives",
    swf: (abc) => bare(abc, 1, "SpriteDragNatives"),
    script: "SpriteDragNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "sprite-hit-area",
    swf: (abc) => bare(abc, 1, "SpriteHitArea"),
    script: "SpriteHitArea",
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "crypto-random",
    swf: (abc) => bare(abc, 1, "CryptoRandom"),
    script: "CryptoRandom",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "amf0",
    swf: (abc) => bare(abc, 1, "Amf0"),
    script: "Amf0",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "bytearray-multibyte",
    swf: (abc) => bare(abc, 1, "ByteArrayMultibyte"),
    script: "ByteArrayMultibyte",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "security-domain",
    swf: (abc) => bare(abc, 1, "SecurityDomainNatives"),
    script: "SecurityDomainNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "mouse-visibility",
    swf: (abc) => bare(abc, 1, "MouseVisibility"),
    script: "MouseVisibility",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "mouse-cursor",
    swf: (abc) => bare(abc, 1, "MouseCursorNatives"),
    script: "MouseCursorNatives",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "native-strings",
    swf: (abc) => bare(abc, 1, "NativeStrings"),
    script: "NativeStrings",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  // The unload at INIT follows frame 2's capture (see the harness): frame 3 shows it.
  { name: "loads-init", build: loadsInit, frames: 3, capture: [3], tolerance: 0, maxOutliers: 0 },
  {
    name: "loader-images",
    swf: bare,
    script: "LoaderImages",
    frames: 5,
    capture: [3, 5],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loader-image-alpha",
    swf: bare,
    script: "LoaderImageAlpha",
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loader-image-formats",
    swf: bare,
    script: "LoaderImageFormats",
    frames: 9,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loader-bytes-frames",
    build: loaderBytesFrames,
    frames: 5,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "loader-parameters",
    build: loaderParameters,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "vector-definitions",
    swf: bare,
    script: "VectorDefinitions",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "shared-objects",
    swf: bare,
    script: "SharedObjects",
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "stage-children",
    swf: bare,
    script: "StageChildren",
    frames: 4,
    capture: [1, 2, 3, 4],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "stage-hits",
    swf: (abc) => bare(abc, 2, "StageHits", 100, 50),
    script: "StageHits",
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "definitions",
    build: definitions,
    frames: 1,
    capture: [1],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Last: the content it unloads plays on in Flash until collected, and its
  // traces would reach the case recorded after it.
  { name: "loads", build: loads, frames: 3, capture: [1, 2, 3], tolerance: 0, maxOutliers: 0 },
  {
    name: "uncaught-errors",
    build: uncaughtErrors,
    frames: UNCAUGHT_FRAMES,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "current-domain",
    build: currentDomain,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "crossbridge-runtime",
    build: crossbridgeRuntime,
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "url-stream-close",
    swf: (abc) => bare(abc, 1, "UrlStreamClose"),
    script: "UrlStreamClose",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "system-natives",
    swf: (abc) => bare(abc, 2, "SystemNatives"),
    script: "SystemNatives",
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
