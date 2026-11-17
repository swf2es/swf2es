import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

const { value, exception } = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<number>(`(async () => {
  const { createCodegen } = await import('@swf2es/codegen');
  const { Scripting, builtinLibrary, playerglobalLibrary } = await import('@swf2es/player');
  const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const tracks = [];
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args); tracks.push(...stream.getTracks()); return stream;
  };
  const host = await browserCaptureHost();
  let checks = 0;
  const check = (ok, why) => { if (!ok) throw new Error(why); checks++; };
  check(host && host.microphones.length > 0, 'fake microphone missing');
  check(tracks.length === 0, 'enumeration opened microphone');
  let inputCount = 0, inputRate = 0;
  const open = host.openMicrophone.bind(host);
  host.openMicrophone = (device, mode, events, signal) => open(device, mode, {
    ...events, samples(samples, rate) { inputCount += samples.length; inputRate = rate; events.samples(samples, rate); }
  }, signal);
  const errors = [];
  const s = new Scripting(await createCodegen(await WebAssembly.compileStreaming(fetch('/codegen/codegen.wasm'))), { capture: host, audio: null, onUncaught: error => errors.push(String(error)) });
  await s.loadLibraries([builtinLibrary, playerglobalLibrary]);
  const rt = s.rt;
  const get = (o, key) => rt.getProperty(o, rt.publicName(key));
  const set = (o, key, value) => rt.setProperty(o, rt.publicName(key), value);
  const call = (o, key, ...args) => rt.callProperty(o, rt.publicName(key), ...args);
  const listen = (o, type, fn) => { const listener = {$f: fn}; call(o, 'addEventListener', type, listener); return () => call(o, 'removeEventListener', type, listener); };
  const mic = call(rt.classNamed('flash.media::Microphone'), 'getMicrophone');
  const status = [];
  listen(mic, 'status', e => status.push(get(e, 'code')));
  const wait = async (condition, label) => {
    const until = performance.now() + 8000;
    while (!condition()) {
      if (errors.length) throw new Error(errors.join('; '));
      if (performance.now() > until) throw new Error(label + ' timed out');
      await new Promise(r => setTimeout(r, 15)); s.loads.completeLoads();
    }
    s.loads.completeLoads();
    if (errors.length) throw new Error(errors.join('; '));
  };
  try {
    for (const [rate, hz] of [[5,5512.5],[8,8000],[11,11025],[16,16000],[22,22050],[44,44100]]) {
      set(mic, 'rate', rate); set(mic, 'gain', 50);
      inputCount = 0;
      let count = 0, energy = 0, next = 0;
      const remove = listen(mic, 'sampleData', e => {
        check(get(e, 'position') === next, 'sample position discontinuity');
        const data = get(e, 'data');
        check(get(data, 'position') === 0, 'sample cursor not at start');
        while (get(data, 'bytesAvailable')) {
          const sample = call(data, 'readFloat');
          if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error('invalid PCM');
          energy += sample * sample; count++; next++;
        }
      });
      await wait(() => count >= hz / 5 && energy / count > 0.00001, 'sampleData rate ' + rate);
      check(count === Math.ceil(inputCount * hz / inputRate), 'wrong sample count at rate ' + rate + ': ' + count + '/' + inputCount + '@' + inputRate);
      check(energy / count > 0.00001, 'fake tone missing at rate ' + rate);
      check(get(mic, 'activityLevel') > 0, 'activity not measured');
      remove();
      check(tracks.every(t => t.readyState === 'ended'), 'listener removal kept track');
    }
    check(status.includes('Microphone.Unmuted'), 'missing unmuted status');
    check(get(mic, 'name').length > 0, 'label not refreshed');
    set(mic, 'gain', 0);
    let silent = 0;
    const remove = listen(mic, 'sampleData', e => {
      const data = get(e, 'data');
      while (get(data, 'bytesAvailable')) { check(call(data, 'readFloat') === 0, 'zero gain captured sound'); silent++; }
    });
    // The fake input begins with silence; observe beyond that startup interval.
    await wait(() => silent >= 88200, 'silent gain');
    s.destroy();
    check(tracks.every(t => t.readyState === 'ended'), 'destroy kept microphone');
    remove();

    // A consumer may revoke consent inside the synchronous granted callback.
    const added = new Set();
    const add = globalThis.addEventListener;
    const removeEvent = globalThis.removeEventListener;
    globalThis.addEventListener = function(type, fn, options) {
      if (type === 'pointerdown' || type === 'keydown') added.add(fn);
      return add.call(this, type, fn, options);
    };
    globalThis.removeEventListener = function(type, fn, options) {
      if (type === 'pointerdown' || type === 'keydown') added.delete(fn);
      return removeEvent.call(this, type, fn, options);
    };
    try {
      const revoked = new AbortController();
      let granted = false;
      host.openMicrophone(host.microphones[0], {gain:50,echoCancellation:false,noiseSuppression:false}, {
        state(value) { if (value !== 'granted') throw new Error('unexpected host state'); granted = true; revoked.abort(); },
        samples() { throw new Error('revoked capture delivered samples'); }
      }, revoked.signal);
      await wait(() => granted, 'synchronous revocation');
      check(added.size === 0 && tracks.every(t => t.readyState === 'ended'), 'revocation retained listeners or tracks');
    } finally { globalThis.addEventListener = add; globalThis.removeEventListener = removeEvent; }

    const loadModule = Worklet.prototype.addModule;
    let moduleReady;
    Worklet.prototype.addModule = () => new Promise(resolve => { moduleReady = resolve; });
    try {
      const loading = new AbortController();
      let states = 0;
      host.openMicrophone(host.microphones[0], {gain:50,echoCancellation:false,noiseSuppression:false}, {
        state() { states++; }, samples() { throw new Error('aborted module delivered samples'); }
      }, loading.signal);
      await wait(() => moduleReady, 'worklet loading');
      loading.abort(); moduleReady();
      await new Promise(r => setTimeout(r, 25));
      check(states === 0 && tracks.every(t => t.readyState === 'ended'), 'worklet setup survived abort');
    } finally { Worklet.prototype.addModule = loadModule; }

    let release;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
    const late = new AbortController();
    host.openMicrophone(host.microphones[0], {gain:50,echoCancellation:false,noiseSuppression:false}, {
      state() { throw new Error('late grant delivered'); }, samples() { throw new Error('late samples'); }
    }, late.signal);
    late.abort();
    const stream = await original({audio:true}); release(stream);
    await wait(() => stream.getTracks().every(t => t.readyState === 'ended'), 'late permission cleanup');
    check(true, 'late permission cleanup');
    return checks;
  } finally { s.destroy(); navigator.mediaDevices.getUserMedia = original; }
})()`),
  false,
  {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
    timeout: 60000,
  },
);
assert.equal(exception, null, exception ?? "microphone exception");
assert.ok(typeof value === "number" && value > 50);
console.log(`microphone: ${value} checks passed at all six rates`);

const denial = await withPage(
  "runSwf",
  async (evaluate, send) => {
    await send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied" });
    return evaluate<string>(`(async () => {
    const { browserCaptureHost } = await import('@swf2es/player-hosts/capture');
    const host = await browserCaptureHost();
    const lifetime = new AbortController();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('denial timed out')), 5000);
        host.openMicrophone({id:'',name:''}, {gain:50,echoCancellation:false,noiseSuppression:false}, {
          state(value) { clearTimeout(timer); resolve(value); }, samples() { reject(new Error('denied samples')); }
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
console.log("microphone: Chromium permission denial passed");
