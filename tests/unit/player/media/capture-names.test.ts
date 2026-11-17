// Which SWFs wait for the capture host to read its devices: those whose
// ActionScript names flash.media's Camera or Microphone, by import, by a
// package's wildcard import or by the string getDefinitionByName takes,
// and not one with a Camera class of its own. And the host's prepare:
// asked for once, waited for until it ends, and a host whose prepare
// fails, refuses or throws dropped, as no host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import type { CaptureHost } from "../../../../packages/player/dist/hosts.js";
import { namesCapture } from "../../../../packages/player/dist/media/capture-names.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/capture-names/", import.meta.url));
const compile = compiler(out);
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A constant pool alone, naming `name` by a Multiname whose set holds a private namespace and `ns`'s package. */
function multinameAbc(ns: string, name: string): Uint8Array {
  const string = (s: string) => [s.length, ...new TextEncoder().encode(s)];
  return Uint8Array.from([
    ...[16, 0, 46, 0],
    ...[0, 0, 0], // ints, uints, doubles: none
    ...[4, ...string(ns), ...string(name), ...string("private")],
    ...[3, 0x16, 1, 0x05, 3], // namespaces: the package and a private one
    ...[2, 2, 2, 1], // a set of both
    ...[2, 0x09, 2, 1], // multinames: name in that set
  ]);
}

test("namesCapture: flash.media's Camera and Microphone, not a class of the SWF's own", () => {
  const own = compile(
    "Camera",
    `package {
  public class Camera {
    public static var names:Array = ["mine"];
    public static function getCamera():Camera { return new Camera(); }
  }
}`,
  );
  const usesOwn = compile(
    "CaptureOwnUser",
    `package {
  import flash.display.Sprite;
  import flash.media.Sound;
  public class CaptureOwnUser extends Sprite {
    public function CaptureOwnUser() { new Sound(); trace(Camera.names, Camera.getCamera()); }
  }
}`,
  );
  const wildcard = compile(
    "CaptureWildcard",
    `package {
  import flash.display.Sprite;
  import flash.media.*;
  public class CaptureWildcard extends Sprite {
    public function CaptureWildcard() { trace(Camera.names.length); }
  }
}`,
  );
  const microphone = compile(
    "CaptureMicrophone",
    `package {
  import flash.display.Sprite;
  import flash.media.Microphone;
  public class CaptureMicrophone extends Sprite {
    public function CaptureMicrophone() { trace(Microphone.getMicrophone()); }
  }
}`,
  );
  const byName = compile(
    "CaptureDefinition",
    `package {
  import flash.display.Sprite;
  import flash.utils.getDefinitionByName;
  public class CaptureDefinition extends Sprite {
    public function CaptureDefinition() { trace(getDefinitionByName("flash.media.Camera")); }
  }
}`,
  );
  const plain = compile(
    "CapturePlain",
    "package { import flash.display.Sprite; public class CapturePlain extends Sprite {} }",
  );

  assert.equal(namesCapture([own, usesOwn]), false, "a Camera class of the SWF's own");
  assert.equal(namesCapture([plain]), false, "no capture at all");
  assert.equal(namesCapture([wildcard]), true, "a Multiname under import flash.media.*");
  assert.equal(namesCapture([microphone]), true, "Microphone by its import");
  assert.equal(namesCapture([byName]), true, "the full name as a string");
  assert.equal(namesCapture([plain, wildcard]), true, "any of the SWF's ABCs");
  // ASC 1 binds a wildcard import's Camera to a QName; a compiler that leaves it to run time
  // writes a Multiname whose set holds the package.
  assert.equal(namesCapture([multinameAbc("flash.media", "Camera")]), true, "a Multiname's set");
  assert.equal(namesCapture([multinameAbc("game.view", "Camera")]), false, "another package's");
});

async function scripting(host: CaptureHost) {
  const s = new Scripting(await createCodegen(wasm), { capture: host, audio: null });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  return s;
}

const devices = { cameras: [], openCamera: () => assert.fail("no capture opens") };

test("prepareCapture: a prepare that answers false, rejects or throws leaves no host", async () => {
  for (const [why, prepare] of [
    ["false", () => Promise.resolve(false)],
    ["rejected", () => Promise.reject(new Error("no devices"))],
    [
      "thrown",
      () => {
        throw new Error("thrown before a promise");
      },
    ],
  ] as const) {
    let calls = 0;
    const s = await scripting({
      ...devices,
      prepare: () => {
        calls++;
        return prepare();
      },
    });
    assert.equal(s.captureUnprepared, true, why);
    await s.prepareCapture();
    assert.equal(s.capture, null, `${why}: host kept`);
    assert.equal(s.captureUnprepared, false, why);
    await s.prepareCapture();
    assert.equal(calls, 1, `${why}: prepared again`);
  }
});

test("prepareCapture: waited for until it ends, once, and a native's call starts it", async () => {
  let finish: (ready: boolean) => void = () => {};
  let calls = 0;
  const cameras: { id: string; name: string }[] = [];
  const s = await scripting({
    ...devices,
    get cameras() {
      return cameras;
    },
    prepare: () => {
      calls++;
      return new Promise<boolean>((resolve) => {
        finish = (ready) => {
          cameras.push({ id: "generated", name: "Generated camera" });
          resolve(ready);
        };
      });
    },
  });
  const rt = s.rt;
  const names = () => {
    const array = rt.getProperty(rt.classNamed("flash.media::Camera"), rt.publicName("names"));
    return rt.getProperty(array as avm2.AsObject, rt.publicName("length"));
  };

  // A SWF that reached Camera unseen: no devices yet, but they are being read.
  assert.equal(names(), 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(s.captureUnprepared, true, "started is not ended");
  const waiting = s.prepareCapture();
  finish(true);
  await waiting;
  assert.equal(s.captureUnprepared, false);
  assert.equal(names(), 1);
  assert.equal(calls, 1);
  assert.ok(s.capture);
});

test("a SWF that names Camera finds its devices in its constructor, read while it compiles", async () => {
  const lines: string[] = [];
  let finish: () => void = () => {};
  const cameras: { id: string; name: string }[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    capture: {
      ...devices,
      get cameras() {
        return cameras;
      },
      prepare: () =>
        new Promise<boolean>((resolve) => {
          finish = () => {
            cameras.push({ id: "generated", name: "Generated camera" });
            resolve(true);
          };
        }),
    },
    audio: null,
    print: (line) => lines.push(line),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compile(
    "CaptureFirstFrame",
    `package {
  import flash.display.Sprite;
  import flash.media.Camera;
  public class CaptureFirstFrame extends Sprite {
    public function CaptureFirstFrame() { trace("names", Camera.names.length); }
  }
}`,
  );
  const player = new Player(bare(abc, 1, "CaptureFirstFrame"), s);
  const started = player.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lines, [], "ran before the devices were read");
  finish();
  await started;
  assert.deepEqual(lines, ["names 1"]);
});
