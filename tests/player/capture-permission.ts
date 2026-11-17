import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const allowed = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate(`(async () => {
    const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const tracks = [];
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await original(options); tracks.push(...stream.getTracks()); return stream;
    };
    try {
      const host = await browserCaptureHost();
      if (tracks.length) throw new Error('enumeration started capture');
      const signal = new AbortController().signal;
      for (const kind of ['camera', 'microphone']) {
        if (await host.requestPermission(kind, signal) !== 'granted') throw new Error('grant missing');
        if (host.permissionStatus(kind) !== 'granted') throw new Error('status missing');
      }
      if (tracks.length !== 2 || tracks.some(t => t.readyState !== 'ended')) throw new Error('permission kept tracks');
      let release;
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
      const lifetime = new AbortController();
      const request = host.requestPermission('camera', lifetime.signal);
      lifetime.abort();
      const late = await original({video:true}); release(late);
      if (await request !== 'denied' || late.getTracks().some(t => t.readyState !== 'ended')) throw new Error('late permission survived');
      return true;
    } finally { navigator.mediaDevices.getUserMedia = original; }
  })()`),
  false,
  { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
);
assert.equal(allowed.exception, null, allowed.exception ?? "browser permission");
assert.equal(allowed.value, true);
const denied = await withPage(
  "runSwf",
  async (evaluate, send) => {
    await send("Browser.setPermission", { permission: { name: "camera" }, setting: "granted" });
    await evaluate(`(async () => {
      const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
      globalThis.permissionHost = await browserCaptureHost();
    })()`);
    assert.equal((await evaluate("permissionHost.permissionStatus('camera')")).value, "granted");
    await send("Browser.setPermission", { permission: { name: "camera" }, setting: "denied" });
    return evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return [permissionHost.permissionStatus('camera'), await permissionHost.requestPermission('camera', new AbortController().signal)];
    })()`);
  },
  false,
  { args: ["--use-fake-device-for-media-stream"] },
);
assert.equal(denied.exception, null, denied.exception ?? "browser revocation");
assert.deepEqual(denied.value, ["denied", "denied"]);
console.log("capture permission: browser grants, revocation and late abort passed");
