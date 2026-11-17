import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<number>(`(async () => {
  const { createCodegen } = await import('@swf2es/codegen');
  const { Scripting, builtinLibrary, playerglobalLibrary } = await import('@swf2es/player');
  const { RenderView } = await import('@swf2es/player/scene');
  const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
  const tracks = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args); tracks.push(...stream.getTracks()); return stream;
  };
  const host = await browserCaptureHost();
  let checks = 0;
  const check = (ok, why) => { if (!ok) throw new Error(why); checks++; };
  check(host && host.cameras.length > 0, 'fake camera missing');
  check(tracks.length === 0, 'enumeration requested capture');
  const codegen = await createCodegen(await WebAssembly.compileStreaming(fetch('/codegen/codegen.wasm')));
  const errors = [];
  const s = new Scripting(codegen, { capture: host, audio: null, onUncaught: e => errors.push(String(e)) });
  await s.loadLibraries([builtinLibrary, playerglobalLibrary]);
  const rt = s.rt;
  const get = (o, key) => rt.getProperty(o, rt.publicName(key));
  const call = (o, key, ...args) => rt.callProperty(o, rt.publicName(key), ...args);
  const camera = call(rt.classNamed('flash.media::Camera'), 'getCamera');
  const video = rt.construct(rt.classNamed('flash.media::Video'), 64, 48);
  const status = [];
  camera.$listeners = new Map([['status', [{ fn: {$f: e => status.push(get(e, 'code'))}, capture: false, priority: 0 }]]]);
  const view = new RenderView({ width: 64, height: 48, preserveDrawingBuffer: true });
  const wait = async (condition, label) => {
    const until = performance.now() + 8000;
    while (!condition()) {
      if (performance.now() > until) throw new Error(label + ' timed out: ' + errors.join(';'));
      await new Promise(r => setTimeout(r, 25)); s.loads.completeLoads();
    }
    s.loads.completeLoads();
  };
  try {
    check(get(camera, 'muted') === true, 'camera began unmuted');
    call(camera, 'setMode', 320, 240, 10, true);
    call(camera, 'setMotionLevel', 0, 100);
    check(tracks.length === 0, 'settings opened camera');
    call(video, 'attachCamera', camera);
    await wait(() => get(video, 'videoWidth') > 0 && get(camera, 'currentFPS') > 0, 'camera frames');
    check(status.includes('Camera.Unmuted'), 'missing permission status');
    check(get(camera, 'muted') === false, 'granted camera remains muted');
    check(get(video, 'videoWidth') === 320 && get(video, 'videoHeight') === 240, 'setMode dimensions: ' + get(video, 'videoWidth') + 'x' + get(video, 'videoHeight'));
    await wait(() => get(camera, 'name').length > 0, 'device label');
    check(get(camera, 'activityLevel') >= 0, 'activity not measured');
    view.render(video.$display);
    const pixels = new Uint8Array(64 * 48 * 4);
    view.gl.readPixels(0, 0, 64, 48, view.gl.RGBA, view.gl.UNSIGNED_BYTE, pixels);
    check(pixels.some((p, i) => i % 4 === 0 && p !== pixels[i + 1]), 'camera pattern not rendered');
    const bitmap = rt.construct(rt.classNamed('flash.display::BitmapData'), 64, 48, true, 0);
    const read = view.gl.readPixels;
    view.gl.readPixels = () => { throw new Error('camera copy used GPU readback'); };
    try { call(bitmap, 'draw', video); } finally { view.gl.readPixels = read; }
    check(bitmap.$store.pixels.some(p => p !== 0 && p !== 0xffffffff), 'CPU snapshot empty');
    call(camera, 'setMode', 640, 480, 15, true);
    await wait(() => get(video, 'videoWidth') === 640 && get(video, 'videoHeight') === 480, 'mode change');
    check(get(camera, 'width') === 640 && get(camera, 'height') === 480, 'camera settings stale');
    call(video, 'attachCamera', null);
    check(tracks.every(t => t.readyState === 'ended'), 'detach kept capture alive');
    call(video, 'attachCamera', camera);
    await wait(() => tracks.length === 2 && get(video, 'videoWidth') > 0, 'reopen');
    s.destroy();
    check(tracks.every(t => t.readyState === 'ended'), 'destroy kept capture alive');
    check(errors.length === 0, errors.join(';'));

    // A real Chromium denial follows the same host state path as a refused prompt.
    const denied = await browserCaptureHost();
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    const deniedStates = [];
    const handle = denied.openCamera(denied.cameras[0], {width:64,height:48,fps:10,favorArea:true},
      { state: v => deniedStates.push(v), settings() {}, frame() { throw new Error('denied camera frame'); } },
      new AbortController().signal);
    await wait(() => deniedStates.length > 0, 'denial'); handle.close();
    check(deniedStates.join(',') === 'denied', 'denial state wrong');

    // The browser can answer a prompt after the player that asked has gone away.
    let release;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
    const pending = new AbortController();
    const lateStates = [];
    host.openCamera(host.cameras[0], {width:64,height:48,fps:10,favorArea:true},
      { state: v => lateStates.push(v), settings() {}, frame() {} }, pending.signal);
    pending.abort();
    const late = await original({ video: true }); release(late);
    await wait(() => late.getTracks().every(t => t.readyState === 'ended'), 'late capture cleanup');
    check(lateStates.length === 0, 'late grant delivered after abort');
    return checks;
  } finally { s.destroy(); view.destroy(); navigator.mediaDevices.getUserMedia = original; }
})()`),
  false,
  {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    timeout: 30000,
  },
);
assert.equal(exception, null, exception ?? "browser exception");
assert.ok(typeof value === "number" && value >= 15);
console.log(`camera: ${value} checks passed`);

const denial = await withPage(
  "runSwf",
  async (evaluate, send) => {
    await send("Browser.setPermission", { permission: { name: "camera" }, setting: "denied" });
    return evaluate<string>(`(async () => {
    const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
    const host = await browserCaptureHost();
    if (!host) throw new Error('capture API unavailable');
    const lifetime = new AbortController();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('denial timed out')), 5000);
        host.openCamera({ id: '', name: '' }, {width:64,height:48,fps:10,favorArea:true}, {
          state(value) { clearTimeout(timer); resolve(value); }, settings() {},
          frame() { reject(new Error('denied camera delivered a frame')); }
        }, lifetime.signal);
      });
    } finally { lifetime.abort(); }
  })()`);
  },
  false,
  { args: ["--use-fake-device-for-media-stream"], timeout: 10000 },
);
assert.equal(denial.exception, null, denial.exception ?? "denial exception");
assert.equal(denial.value, "denied");
console.log("camera: Chromium permission denial passed");
