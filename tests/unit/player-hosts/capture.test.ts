// The browser capture host's device lists: never an empty name, as Flash
// never gives one, though a browser hides labels until consent; and the
// real labels once consent comes, by getUserMedia, a device change or a
// permission's change.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { lazyBrowserCaptureHost } from "../../../packages/player-hosts/dist/capture.js";

interface FakeDevice {
  kind: "audioinput" | "audiooutput" | "videoinput";
  deviceId: string;
  label: string;
}

/** navigator.mediaDevices with `devices` to list, and a grant that labels them. */
class FakeMedia extends EventTarget {
  devices: FakeDevice[] = [];
  enumerations = 0;

  async enumerateDevices(): Promise<FakeDevice[]> {
    this.enumerations++;
    return this.devices.map((device) => ({ ...device }));
  }

  async getUserMedia(): Promise<{ getTracks(): { stop(): void }[] }> {
    return { getTracks: () => [{ stop() {} }] };
  }
}

const permissionStates = new Map<string, EventTarget & { state: string }>();
let media: FakeMedia;
const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedWorklet = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");

beforeEach(() => {
  media = new FakeMedia();
  permissionStates.clear();
  const permissions = {
    async query({ name }: { name: string }) {
      const status = Object.assign(new EventTarget(), { state: "prompt" });
      permissionStates.set(name, status);
      return status;
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: media, permissions },
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    writable: true,
    value: class {},
  });
});

afterEach(() => {
  for (const [name, descriptor] of [
    ["navigator", saved],
    ["AudioWorkletNode", savedWorklet],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

const names = (devices: readonly { name: string }[] | undefined) =>
  (devices ?? []).map((device) => device.name);

/** Lets the readings a device or permission change starts end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function hidden(): FakeDevice[] {
  return [
    { kind: "videoinput", deviceId: "", label: "" },
    { kind: "audioinput", deviceId: "", label: "" },
    { kind: "audiooutput", deviceId: "", label: "" },
  ];
}

function labelled(): FakeDevice[] {
  return [
    { kind: "videoinput", deviceId: "front", label: "Front Camera" },
    { kind: "videoinput", deviceId: "usb", label: "USB Webcam" },
    { kind: "audioinput", deviceId: "mic", label: "Headset Microphone" },
  ];
}

test("devices without labels are named by kind and position, never empty", async () => {
  media.devices = [
    { kind: "videoinput", deviceId: "a", label: "" },
    { kind: "audioinput", deviceId: "b", label: " " },
    { kind: "videoinput", deviceId: "c", label: "" },
    { kind: "audiooutput", deviceId: "d", label: "" },
    { kind: "videoinput", deviceId: "e", label: "Named" },
    { kind: "audioinput", deviceId: "f", label: "" },
  ];
  const host = lazyBrowserCaptureHost();
  assert.ok(host);
  assert.deepEqual(names(host.cameras), [], "nothing read before prepare");

  assert.equal(await host.prepare?.(), true);

  assert.deepEqual(names(host.cameras), ["Camera", "Camera 2", "Named"]);
  assert.deepEqual(names(host.microphones), ["Microphone", "Microphone 2"]);
  assert.deepEqual(
    host.cameras.map((device) => device.id),
    ["a", "c", "e"],
  );
});

test("no devices give empty lists", async () => {
  const host = lazyBrowserCaptureHost();
  assert.ok(host);
  assert.equal(await host.prepare?.(), true);

  assert.deepEqual(names(host.cameras), []);
  assert.deepEqual(names(host.microphones), []);
});

test("a granted request replaces the placeholders with the labels", async () => {
  media.devices = hidden();
  const host = lazyBrowserCaptureHost();
  assert.ok(host?.requestPermission);
  await host.prepare?.();
  assert.deepEqual(names(host.cameras), ["Camera"]);
  assert.deepEqual(names(host.microphones), ["Microphone"]);

  media.devices = labelled();
  assert.equal(await host.requestPermission("camera", new AbortController().signal), "granted");

  assert.deepEqual(names(host.cameras), ["Front Camera", "USB Webcam"]);
  assert.deepEqual(names(host.microphones), ["Headset Microphone"]);
});

test("a device change or a permission change reads the devices again", async () => {
  media.devices = hidden();
  const host = lazyBrowserCaptureHost();
  assert.ok(host);
  await host.prepare?.();

  media.devices = labelled();
  media.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.deepEqual(names(host.cameras), ["Front Camera", "USB Webcam"]);

  media.devices = hidden();
  const camera = permissionStates.get("camera");
  assert.ok(camera);
  camera.state = "denied";
  camera.dispatchEvent(new Event("change"));
  await settle();
  assert.deepEqual(names(host.cameras), ["Camera"]);
  assert.equal(host.permissionStatus?.("camera"), "denied");
});

test("refresh reads the devices again, and a late older reading is dropped", async () => {
  media.devices = hidden();
  const host = lazyBrowserCaptureHost();
  assert.ok(host);
  await host.prepare?.();

  let release: () => void = () => {};
  const enumerate = media.enumerateDevices.bind(media);
  media.enumerateDevices = async () => {
    const devices = await enumerate();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return devices;
  };
  const older = host.refresh();
  media.enumerateDevices = enumerate;
  media.devices = labelled();
  await host.refresh();
  assert.deepEqual(names(host.cameras), ["Front Camera", "USB Webcam"]);

  await settle();
  release();
  await older;
  assert.deepEqual(names(host.cameras), ["Front Camera", "USB Webcam"]);
});
