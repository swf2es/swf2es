import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import type {
  CameraEvents,
  CameraMode,
  CameraPicture,
  CaptureHost,
} from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/camera/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

async function setup(realTime: (() => number) | null = null) {
  const opens: {
    events: CameraEvents;
    modes: CameraMode[];
    closed: number;
    signal: AbortSignal;
  }[] = [];
  const host: CaptureHost = {
    cameras: [{ id: "test", name: "Generated camera" }],
    openCamera(_device, mode, events, signal) {
      const opened = { events, modes: [mode], closed: 0, signal };
      opens.push(opened);
      return {
        setMode: (next) => opened.modes.push(next),
        close: () => {
          opened.closed++;
        },
      };
    },
  };
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    capture: host,
    realTime,
    audio: null,
    onUncaught: (e) => errors.push(e),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compiler(out)(
    "CameraRoot",
    "package { import flash.display.Sprite; public class CameraRoot extends Sprite {} }",
  );
  const player = new Player(bare(abc, 1, "CameraRoot"), s);
  await player.start();
  const rt = s.rt;
  const get = (o: avm2.AsObject, key: string) => rt.getProperty(o, rt.publicName(key));
  const call = (o: avm2.AsObject, key: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(key), ...args);
  const listen = (o: avm2.AsObject, type: string, fn: (event: avm2.AsObject) => void) => {
    const listener = { $f: fn };
    call(o, "addEventListener", type, listener);
    return () => call(o, "removeEventListener", type, listener);
  };
  const cameraClass = rt.classNamed("flash.media::Camera");
  const camera = call(cameraClass, "getCamera") as avm2.AsObject;
  const video = rt.construct(rt.classNamed("flash.media::Video"), 2, 1);
  const frame = (time: number, gray: number) => {
    const picture: CameraPicture = {
      time,
      width: 2,
      height: 1,
      image: {} as CameraPicture["image"],
      readPixels: () => new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      motion: () => new Uint8Array([gray, gray]),
      retain: () => ({
        width: 2,
        height: 1,
        image: {} as CameraPicture["image"],
        readPixels: () => new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      }),
    };
    opens.at(-1)?.events.frame(picture);
  };
  return { s, player, rt, get, call, listen, cameraClass, camera, video, opens, frame, errors };
}

test("Camera starts on attach, delivers status and motion on frames, and stops on detach/destroy", async () => {
  const h = await setup();
  try {
    assert.equal(h.call(h.cameraClass, "getCamera", "0"), h.camera);
    assert.equal(h.call(h.cameraClass, "getCamera", "1"), null);
    assert.equal(h.opens.length, 0);
    assert.equal(h.get(h.camera, "muted"), true);
    assert.equal(h.get(h.camera, "activityLevel"), -1);
    assert.equal(h.get(h.camera, "name"), "Generated camera");
    const names = h.get(h.cameraClass, "names");
    assert.notEqual(h.get(h.cameraClass, "names"), names);
    const statuses: avm2.Value[] = [];
    const activity: avm2.Value[] = [];
    h.listen(h.camera, "status", (e) => statuses.push(h.get(e, "code")));
    h.listen(h.camera, "activity", (e) => activity.push(h.get(e, "activating")));
    h.call(h.camera, "setMode", 80, 60, 10, false);
    assert.equal(h.opens.length, 0);
    h.call(h.video, "attachCamera", h.camera);
    const opened = h.opens[0];
    assert.deepEqual(opened.modes[0], { width: 80, height: 60, fps: 10, favorArea: false });
    opened.events.state("granted");
    assert.deepEqual(statuses, []);
    h.player.tick();
    assert.deepEqual(statuses, ["Camera.Unmuted"]);
    assert.equal(h.get(h.camera, "muted"), false);
    h.call(h.camera, "setMotionLevel", 10, 200);
    h.frame(0, 0);
    h.frame(100, 255);
    assert.equal(h.get(h.camera, "activityLevel"), 100);
    assert.equal(h.get(h.camera, "currentFPS"), 10);
    assert.equal(h.get(h.video, "videoWidth"), 2);
    h.player.tick();
    assert.deepEqual(activity, [true]);
    h.frame(400, 255);
    h.player.tick();
    assert.deepEqual(activity, [true, false]);
    h.call(h.camera, "setMotionLevel", 10, 0);
    h.frame(500, 0);
    h.player.tick();
    assert.deepEqual(activity, [true, false, true]);
    h.call(h.camera, "setMotionLevel", 100, 200);
    h.frame(600, 255);
    h.frame(900, 255);
    h.player.tick();
    assert.deepEqual(activity, [true, false, true]);
    h.call(h.camera, "setMode", 320, 240, 30, true);
    assert.equal(opened.modes.at(-1)?.width, 320);
    opened.events.settings(300, 200, 29, "front");
    assert.equal(h.get(h.camera, "width"), 300);
    assert.equal(h.get(h.camera, "position"), "front");
    const second = h.rt.construct(h.rt.classNamed("flash.media::Video"));
    h.call(second, "attachCamera", h.camera);
    assert.equal(h.video.$display.source, null);
    assert.equal(h.opens.length, 1);
    h.call(second, "attachNetStream", null);
    assert.equal(opened.closed, 1);
    opened.events.frame({
      time: 600,
      width: 1,
      height: 1,
      image: {} as CameraPicture["image"],
      readPixels: () => new Uint8Array(4),
      motion: () => new Uint8Array(1),
    });
    assert.equal(second.$display.picture?.width, 2);
    assert.deepEqual([...second.$display.source.bitmap().pixels], [0xffff0000, 0xff0000ff]);
    h.call(h.video, "attachCamera", h.camera);
    h.s.captureLifetime.abort();
    h.call(h.video, "attachCamera", h.camera);
    assert.equal(h.opens.length, 2);
    h.player.destroy();
    assert.equal(h.opens[1].signal.aborted, true);
    assert.equal(h.opens[1].closed, 1);
    h.opens[1].events.state("granted");
    assert.equal(h.video.$display.source, null);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Camera denial and ending are muted, and CPU copies use the captured frame", async () => {
  const h = await setup();
  try {
    const statuses: avm2.Value[] = [];
    h.listen(h.camera, "status", (e) => statuses.push(h.get(e, "code")));
    h.call(h.video, "attachCamera", h.camera);
    h.opens[0].events.state("denied");
    h.player.tick();
    assert.deepEqual(statuses, ["Camera.Muted"]);
    assert.equal(h.get(h.camera, "muted"), true);
    h.call(h.video, "attachCamera", h.camera);
    h.opens[1].events.state("granted");
    const bitmapClass = h.rt.classNamed("flash.display::BitmapData");
    const bitmap = h.rt.construct(bitmapClass, 2, 1, true, 0);
    let frames = 0;
    h.listen(h.camera, "videoFrame", () => {
      frames++;
      h.call(h.camera, "drawToBitmapData", bitmap);
    });
    h.frame(0, 0);
    h.frame(100, 0);
    h.player.tick();
    assert.equal(frames, 1);
    assert.equal(h.call(bitmap, "getPixel32", 0, 0), 0xffff0000);
    assert.equal(h.call(bitmap, "getPixel32", 1, 0), 0xff0000ff);
    const small = h.rt.construct(bitmapClass, 1, 1);
    assert.throws(() => h.call(h.camera, "drawToBitmapData", small));
    const rect = h.rt.construct(h.rt.classNamed("flash.geom::Rectangle"), 0, 0, 2, 1);
    const bytesObject = h.rt.construct(h.rt.classNamed("flash.utils::ByteArray"));
    h.call(h.camera, "copyToByteArray", rect, bytesObject);
    const bytes = avm2.bytesOf(h.rt, bytesObject);
    assert.equal(bytes.length, 8);
    assert.deepEqual([...bytes.buffer.subarray(0, 8)], [255, 255, 0, 0, 255, 0, 0, 255]);
    const vectorClass = h.rt.resolve(h.rt.vector("uint"));
    const vector = h.rt.construct(vectorClass);
    h.call(h.camera, "copyToVector", rect, vector);
    assert.deepEqual([...vector.$a], [0xffff0000, 0xff0000ff]);
    h.opens[1].events.state("ended");
    h.player.tick();
    assert.deepEqual(statuses, ["Camera.Muted", "Camera.Unmuted", "Camera.Muted"]);
    assert.equal(h.video.$display.picture?.width, 2);
    assert.deepEqual([...h.video.$display.source.bitmap().pixels], [0xffff0000, 0xff0000ff]);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Camera coalesces activity while the player does not tick", async () => {
  const h = await setup();
  try {
    h.call(h.video, "attachCamera", h.camera);
    h.opens[0].events.state("granted");
    h.player.tick();
    h.call(h.camera, "setMotionLevel", 10, 0);
    h.listen(h.camera, "activity", () => {});
    const defer = h.s.loads.deferHostEvent.bind(h.s.loads);
    let queued = 0;
    h.s.loads.deferHostEvent = (event) => {
      queued++;
      defer(event);
    };
    for (let i = 0; i < 1000; i++) {
      h.frame(i * 100, Math.floor(i / 2) % 2 ? 255 : 0);
    }
    assert.equal(queued, 1);
    h.player.tick();
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Camera consent survives reattachment, revocation notifies once and activity has no orphan false", async () => {
  const h = await setup();
  try {
    const statuses: avm2.Value[] = [];
    const activity: avm2.Value[] = [];
    h.listen(h.camera, "status", (e) => statuses.push(h.get(e, "code")));
    h.listen(h.camera, "activity", (e) => activity.push(h.get(e, "activating")));
    h.call(h.video, "attachCamera", h.camera);
    h.opens[0].events.state("granted");
    h.player.tick();
    h.call(h.video, "attachCamera", null);
    h.call(h.video, "attachCamera", h.camera);
    h.opens[1].events.state("granted");
    h.call(h.camera, "setMotionLevel", 1, 0);
    h.frame(0, 0);
    h.frame(100, 255);
    h.frame(200, 255);
    h.player.tick();
    assert.deepEqual(activity, []);
    assert.deepEqual(statuses, ["Camera.Unmuted"]);
    h.s.captureLifetime.abort();
    h.player.tick();
    assert.deepEqual(statuses, ["Camera.Unmuted", "Camera.Muted"]);
    assert.equal(h.get(h.camera, "muted"), true);
    h.call(h.video, "attachCamera", h.camera);
    h.player.tick();
    assert.equal(h.opens.length, 2);
    assert.equal(statuses.length, 2);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("camera motion readback needs a listener and FPS averages then decays", async () => {
  let clock = 0;
  const h = await setup(() => clock);
  try {
    h.call(h.video, "attachCamera", h.camera);
    const events = h.opens[0].events;
    events.state("granted");
    let reads = 0;
    const picture: CameraPicture = {
      time: 0,
      width: 2,
      height: 1,
      image: {} as CameraPicture["image"],
      readPixels: () => new Uint8Array(8),
      motion: () => {
        reads++;
        return new Uint8Array([reads & 1 ? 0 : 8]);
      },
    };
    for (let i = 0; i < 20; i++) {
      clock = picture.time = i * 100;
      events.frame(picture);
    }
    assert.equal(reads, 0);
    assert.equal(h.get(h.camera, "activityLevel"), -1);
    assert.equal(h.get(h.camera, "currentFPS"), 10);
    const remove = h.listen(h.camera, "activity", () => {});
    clock = picture.time = 2000;
    events.frame(picture);
    clock = picture.time = 2100;
    events.frame(picture);
    assert.ok(Number(h.get(h.camera, "activityLevel")) >= 50);
    assert.equal(reads, 2);
    h.call(h.camera, "setMotionLevel", 100);
    events.frame(picture);
    assert.equal(reads, 2);
    h.call(h.camera, "setMotionLevel", 50);
    remove();
    events.frame(picture);
    assert.equal(reads, 2);
    clock += 1500;
    assert.equal(h.get(h.camera, "currentFPS"), 0);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("AS3 video copies use Video.smoothing, independent of draw's smoothing argument", async () => {
  const h = await setup();
  try {
    h.call(h.video, "attachCamera", h.camera);
    h.opens[0].events.state("granted");
    h.frame(0, 0);
    const matrix = h.rt.construct(h.rt.classNamed("flash.geom::Matrix"), 2.5, 0, 0, 1);
    const pixels = (videoSmooth: boolean, drawSmooth: boolean) => {
      h.rt.setProperty(h.video, h.rt.publicName("smoothing"), videoSmooth);
      const bitmap = h.rt.construct(h.rt.classNamed("flash.display::BitmapData"), 5, 1, true, 0);
      h.call(bitmap, "draw", h.video, matrix, null, null, null, drawSmooth);
      return [...bitmap.$store.pixels];
    };
    assert.deepEqual(pixels(false, false), pixels(false, true));
    assert.deepEqual(pixels(true, false), pixels(true, true));
    assert.notDeepEqual(pixels(false, false), pixels(true, false));
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Stop tells only a camera that was opened or told of a decision", async () => {
  const h = await setup();
  try {
    const statuses: avm2.Value[] = [];
    h.listen(h.camera, "status", (e) => statuses.push(h.get(e, "code")));
    h.s.captureLifetime.abort();
    for (let i = 0; i < 3; i++) {
      h.player.tick();
    }

    assert.deepEqual(statuses, []);
    assert.equal(h.get(h.camera, "muted"), true);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});
