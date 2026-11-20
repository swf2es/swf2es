// Camera's and Microphone's names never empty, whatever a host gives: a
// blank name is the kind and position, as content tests names[0] and
// sends names on. And the host released when the player is destroyed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import type { CaptureDevice, CaptureHost } from "../../../../packages/player/dist/hosts.js";
import {
  captureDeviceName,
  captureDeviceNames,
} from "../../../../packages/player/dist/media/capture-devices.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../player/libraries.ts";

const out = fileURLToPath(new URL("../../out/capture-devices/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

function host(cameras: CaptureDevice[], microphones: CaptureDevice[]) {
  const unused = () => {
    throw new Error("no capture in this test");
  };
  const counts = { release: 0 };
  const capture: CaptureHost = {
    cameras,
    microphones,
    openCamera: unused,
    openMicrophone: unused,
    release() {
      counts.release++;
    },
  };

  return { capture, counts };
}

async function scripting(capture: CaptureHost) {
  const s = new Scripting(await createCodegen(wasm), { capture, audio: null });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  await s.prepareCapture();
  const rt = s.rt;
  const get = (o: avm2.AsObject, key: string) => rt.getProperty(o, rt.publicName(key));
  const call = (o: avm2.AsObject, key: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(key), ...args);
  const strings = (array: avm2.Value) =>
    String(rt.callProperty(array as avm2.AsObject, rt.publicName("join"), "|")).split("|");

  return { s, rt, get, call, strings };
}

test("captureDeviceName: a blank name is the kind and position, a real one kept", () => {
  const devices = [
    { id: "a", name: "" },
    { id: "b", name: "  " },
    { id: "c", name: "USB Webcam" },
  ];
  assert.deepEqual(captureDeviceNames(devices, "Camera"), ["Camera", "Camera 2", "USB Webcam"]);
  assert.deepEqual(captureDeviceNames([], "Microphone"), []);
  assert.equal(captureDeviceName({ id: "", name: "" }, 3, "Microphone"), "Microphone 4");
});

test("Camera and Microphone name a host's blank devices, in names and in name", async () => {
  const { capture } = host(
    [
      { id: "", name: "" },
      { id: "usb", name: "USB Webcam" },
      { id: "", name: "" },
    ],
    [{ id: "", name: "" }],
  );
  const { rt, get, call, strings } = await scripting(capture);
  const cameraClass = rt.classNamed("flash.media::Camera");
  const microphoneClass = rt.classNamed("flash.media::Microphone");

  assert.deepEqual(strings(get(cameraClass, "names")), ["Camera", "USB Webcam", "Camera 3"]);
  assert.deepEqual(strings(get(microphoneClass, "names")), ["Microphone"]);

  const first = call(cameraClass, "getCamera") as avm2.AsObject;
  const third = call(cameraClass, "getCamera", "2") as avm2.AsObject;
  const microphone = call(microphoneClass, "getMicrophone") as avm2.AsObject;
  assert.equal(get(first, "name"), "Camera");
  assert.equal(get(third, "name"), "Camera 3");
  assert.equal(get(third, "index"), 2);
  assert.equal(get(microphone, "name"), "Microphone");

  // Consent labels the devices in place: the objects got before read their labels.
  capture.cameras[0].name = "Front Camera";
  (capture.microphones ?? [])[0].name = "Headset";
  assert.equal(get(first, "name"), "Front Camera");
  assert.equal(get(microphone, "name"), "Headset");
  assert.equal(call(cameraClass, "getCamera", "0"), first);
});

test("destroy releases the capture host once", async () => {
  const { capture, counts } = host([{ id: "", name: "" }], []);
  const { s } = await scripting(capture);
  assert.equal(counts.release, 0);

  s.destroy();
  s.destroy();
  assert.equal(counts.release, 1);
});

test("destroy releases a host whose prepare refused, which the player dropped", async () => {
  const { capture, counts } = host([], []);
  capture.prepare = async () => false;
  const { s } = await scripting(capture);
  assert.equal(s.capture, null);

  s.destroy();
  assert.equal(counts.release, 1);
});
