import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bare } from "../player/cases.ts";
import { withPage } from "../player/chrome.ts";
import { compiler } from "../player/scripts.ts";

const tonePath = fileURLToPath(new URL("out/capture-audio/tone.wav", import.meta.url));
mkdirSync(fileURLToPath(new URL("out/capture-audio/", import.meta.url)), { recursive: true });
const tone = Buffer.alloc(44 + 48000 * 2 * 2);
tone.write("RIFF", 0);
tone.writeUInt32LE(tone.length - 8, 4);
tone.write("WAVEfmt ", 8);
tone.writeUInt32LE(16, 16);
tone.writeUInt16LE(1, 20);
tone.writeUInt16LE(1, 22);
tone.writeUInt32LE(48000, 24);
tone.writeUInt32LE(96000, 28);
tone.writeUInt16LE(2, 32);
tone.writeUInt16LE(16, 34);
tone.write("data", 36);
tone.writeUInt32LE(tone.length - 44, 40);
for (let i = 0; i < 96000; i++) {
  tone.writeInt16LE(Math.round(8192 * Math.sin((2 * Math.PI * 440 * i) / 48000)), 44 + i * 2);
}
writeFileSync(tonePath, tone);

const abc = compiler(fileURLToPath(new URL("out/capture-audio/", import.meta.url)))(
  "CaptureAudio",
  readFileSync(new URL("scripts/CaptureAudio.as", import.meta.url), "utf8"),
);
const swf = [...bare(abc, 1, "CaptureAudio")];
const result = await withPage(
  "runSwf",
  (evaluate) =>
    evaluate<string[]>(`(async () => {
  const { configure } = await import('@swf2es/web');
  configure({ cache: false });
  const traces = [], errors = [], tracks = [];
  const { log, error } = console;
  let activityAt = 0;
  console.log = (...args) => {
    const line = args.join(' ');
    if (line.startsWith('audio: activity true ')) activityAt = performance.now();
    traces.push(line.startsWith('audio: silence ') ? line + ' ' + (performance.now() - activityAt) : line);
  };
  console.error = (...args) => errors.push(args.join(' '));
  let constraints = 0;
  const apply = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function(...args) { constraints++; return apply.apply(this, args); };
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args); tracks.push(...stream.getTracks()); return stream;
  };
  globalThis.captureBusy = () => { const end = performance.now() + 250; while(performance.now() < end) {} };
  const p = document.createElement('swf2es-player');
  p.setAttribute('allowscriptaccess', 'always'); document.body.append(p);
  const wait = async (condition, why) => {
    const end = performance.now() + 12000;
    while (!condition()) {
      if (performance.now() >= end) throw new Error(why + ': ' + traces.join('; ') + ' / ' + errors.join('; '));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    await p.load(Uint8Array.from(${JSON.stringify(swf)}));
    await wait(() => traces.includes('audio: ready -1'), 'initial activity');
    // First, on a microphone that has told the script nothing yet.
    p.audioOrder();
    await wait(() => traces.some(t => t.startsWith('audio: order')), 'status and samples');
    await wait(() => tracks.every(t => t.readyState === 'ended'), 'order stop');
    for (const busy of [false, true]) {
      for (const rate of [5, 8, 11, 16, 22, 44]) {
        const at = traces.length;
        p.audioBegin(rate, busy, false);
        await wait(() => traces.slice(at).some(t => t.startsWith('audio: count')), 'sample count');
        await wait(() => tracks.every(t => t.readyState === 'ended'), 'sample stop');
      }
    }
    const at = traces.length;
    p.audioBegin(44, false, true);
    await wait(() => traces.slice(at).some(t => t.startsWith('audio: count')), 'one-fps sample count');
    for (const timeout of [500, 2000]) {
      const at = traces.length;
      p.audioActivity(timeout);
      await wait(() => traces.slice(at).some(t => t.startsWith('audio: silence')), 'activity timeout');
      await wait(() => tracks.every(t => t.readyState === 'ended'), 'activity stop');
    }
    const before = traces.length;
    p.audioActivity(100);
    await new Promise(resolve => setTimeout(resolve, 700));
    p.audioActivityEnd();
    if (traces.slice(before).join('|') !== 'audio: activity end 0') throw new Error('level 100 emitted activity');
    if (errors.length) throw new Error(errors.join('; '));
    if (constraints) throw new Error('gain/rate setters or initial open reapplied constraints: ' + constraints);
    return traces;
  } finally { p.destroy(); p.remove(); console.log = log; console.error = error; }
})()`),
  false,
  {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${tonePath}`,
    ],
    timeout: 120000,
  },
);
assert.equal(result.exception, null, result.exception ?? "browser exception");
const lines = result.value ?? [];
const rates = new Map([
  [5, 5512.5],
  [8, 8000],
  [11, 11025],
  [16, 16000],
  [22, 22050],
  [44, 44100],
]);
assert.ok(lines.includes("audio: order Microphone.Unmuted,samples"), lines.join("\n"));
const counts = lines.filter((line) => line.startsWith("audio: count"));
let largest = 0;
assert.equal(counts.length, 13);
for (const line of counts) {
  const [, , rate, count, elapsed, continuous, endian, , list] = line.split(" ");
  const hz = rates.get(Number(rate)) as number;
  const expected = (hz * Number(elapsed)) / 1000;
  // A sanity bound only: delivery times jitter by up to a block and a frame at each end.
  assert.ok(Math.abs(Number(count) - expected) / expected < 0.15, line);
  assert.equal(continuous, "true", line);
  assert.equal(endian, "true", line);
  // How late each event's last sample arrives, against the samples' own clock. Its least value
  // early and late in the window stays put unless samples are lost (or the rate is wrong): a lost
  // block of about 43 ms, or a 250 ms stall with one credit, moves it by that much.
  const points = list.split(",").map((point) => point.split(":").map(Number));
  const late = (from: number, to: number) => {
    const window = points.filter(([time]) => time >= from && time <= to);
    assert.ok(window.length > 0, `${line.slice(0, 60)}: no events from ${from} to ${to}`);
    return Math.min(...window.map(([time, end]) => time - (end * 1000) / hz));
  };
  const start = points[0][0];
  const end = (points.at(-1) as number[])[0];
  const drift = late(end - 600, end) - late(start, start + 600);
  assert.ok(Math.abs(drift) < 100, `${line.slice(0, 60)} drift ${drift}`);
  largest = Math.max(largest, Math.abs(drift));
}
for (const line of lines.filter((line) => line.startsWith("audio: silence"))) {
  const [, , timeout, _elapsed, events, wall] = line.split(" ");
  // Activity is told on frames and audio comes in blocks: early by those, late by the audio
  // already on its way when the gain fell. Still far from the other timeout.
  const off = Number(wall) - Number(timeout);
  assert.ok(off > -150 && off < 450, line);
  assert.equal(events, "2", line);
}
assert.equal(lines.filter((line) => line === "audio: activity true true true").length, 2);
assert.equal(lines.filter((line) => line === "audio: activity false true true").length, 2);
console.log(`AS3 microphone: largest delivery drift ${largest.toFixed(1)} ms`);
console.log(
  "AS3 microphone: status first, six rates, busy frame, one-fps delivery, activity and silence passed",
);

// Chrome permits autoplay while capturing (developer.chrome.com/blog/web-audio-autoplay).
// Exercise loopback with a real audio host after a trusted input, without inventing a second gate.
const loopback = await withPage(
  "runSwf",
  async (evaluate, send) => {
    const prepared = await evaluate<boolean>(`(async () => {
    await import('@swf2es/web');
    globalThis.loopTracks = []; globalThis.loopBuffers = []; globalThis.loopErrors = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args); loopTracks.push(...stream.getTracks()); return stream;
    };
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function() {
      const node = create.call(this), start = node.start.bind(node);
      node.start = (...args) => {
        loopBuffers.push({ audible: node.buffer?.getChannelData(0).some(v => Math.abs(v) > 0.001), context: this });
        return start(...args);
      };
      return node;
    };
    console.error = (...args) => loopErrors.push(args.join(' '));
    const p = document.createElement('swf2es-player'); p.id = 'loopback';
    p.setAttribute('allowscriptaccess', 'always'); document.body.append(p);
    await p.load(Uint8Array.from(${JSON.stringify(swf)}));
    document.addEventListener('pointerdown', () => p.audioLoopback(true), {once:true});
    return loopTracks.length === 0;
  })()`);
    assert.equal(prepared.exception, null);
    assert.equal(prepared.value, true);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 10,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 10,
      y: 10,
      button: "left",
      clickCount: 1,
    });
    return evaluate<boolean>(`(async () => {
    const p = document.getElementById('loopback');
    const wait = async predicate => {
      const end = performance.now() + 8000;
      while (!predicate()) {
        if (performance.now() > end) throw new Error('loopback timed out: ' + loopErrors.join('; '));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    try {
      await wait(() => loopBuffers.some(b => b.audible && b.context.state === 'running'));
      if (loopTracks.length !== 1) throw new Error('loopback did not open exactly one microphone');
      p.audioLoopback(false);
      await wait(() => loopTracks.every(t => t.readyState === 'ended'));
      const count = loopBuffers.length;
      await new Promise(resolve => setTimeout(resolve, 200));
      if (loopBuffers.length !== count || loopErrors.length) throw new Error('loopback continued after stop: ' + loopErrors.join('; '));
      return true;
    } finally { p.destroy(); p.remove(); }
  })()`);
  },
  false,
  {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${tonePath}`,
    ],
    timeout: 30000,
  },
);
assert.equal(loopback.exception, null, loopback.exception ?? "browser exception");
assert.equal(loopback.value, true);
console.log("AS3 microphone: real audio loopback and stop passed");
