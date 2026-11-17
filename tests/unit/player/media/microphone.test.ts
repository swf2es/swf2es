import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import type {
  CaptureHost,
  MicrophoneEvents,
  MicrophoneMode,
} from "../../../../packages/player/dist/hosts.js";
import type { AudioHost, SoundMix } from "../../../../packages/player/dist/media/audio.js";
import {
  microphoneStates,
  stopMicrophones,
} from "../../../../packages/player/dist/media/microphone.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../out/microphone/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
async function setup(audioEnabled = true, realTime: (() => number) | null = null) {
  const opens: {
    events: MicrophoneEvents;
    modes: MicrophoneMode[];
    closed: number;
    signal: AbortSignal;
  }[] = [];
  const host: CaptureHost = {
    cameras: [],
    microphones: [{ id: "test", name: "Generated microphone" }],
    openCamera() {
      throw new Error("unexpected camera");
    },
    openMicrophone(_device, mode, events, signal) {
      const opened = { events, modes: [mode], closed: 0, signal };
      opens.push(opened);
      return {
        setMode: (mode) => opened.modes.push(mode),
        close: () => {
          opened.closed++;
        },
      };
    },
  };
  const output: { blocks: Float32Array[][]; mix: SoundMix; stopped: boolean }[] = [];
  const audio: AudioHost = {
    decode() {
      throw new Error("unexpected decode");
    },
    stream(mix) {
      const played = { blocks: [] as Float32Array[][], mix, stopped: false };
      output.push(played);
      return {
        positionMs: 0,
        append(channels) {
          played.blocks.push(channels);
        },
        finish() {},
        stop() {
          played.stopped = true;
        },
        setMix(next) {
          played.mix = next;
        },
      };
    },
  };
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    capture: host,
    audio: audioEnabled ? audio : null,
    realTime,
    onUncaught: (e) => errors.push(e),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compiler(out)(
    "MicrophoneRoot",
    "package { import flash.display.Sprite; public class MicrophoneRoot extends Sprite {} }",
  );
  const player = new Player(bare(abc, 1, "MicrophoneRoot"), s);
  await player.start();
  const rt = s.rt;
  const get = (o: avm2.AsObject, key: string) => rt.getProperty(o, rt.publicName(key));
  const set = (o: avm2.AsObject, key: string, value: avm2.Value) =>
    rt.setProperty(o, rt.publicName(key), value);
  const call = (o: avm2.AsObject, key: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(key), ...args);
  const listen = (o: avm2.AsObject, type: string, fn: (event: avm2.AsObject) => void) => {
    const listener = { $f: fn };
    call(o, "addEventListener", type, listener);
    return () => call(o, "removeEventListener", type, listener);
  };
  const klass = rt.classNamed("flash.media::Microphone");
  const mic = call(klass, "getMicrophone") as avm2.AsObject;
  return { s, player, rt, get, set, call, listen, klass, mic, opens, output, errors };
}

test("Microphone listener starts capture, queues mono floats on frames, and stops on removal", async () => {
  const h = await setup();
  try {
    assert.equal(h.call(h.klass, "getMicrophone", 0), h.mic);
    assert.equal(h.get(h.mic, "gain"), 50);
    assert.equal(h.get(h.mic, "activityLevel"), -1);
    assert.equal(h.opens.length, 0);
    const statuses: avm2.Value[] = [];
    h.listen(h.mic, "status", (e) => statuses.push(h.get(e, "code")));
    const data: { position: avm2.Value; values: number[] }[] = [];
    const remove = h.listen(h.mic, "sampleData", (e) => {
      const bytes = avm2.bytesOf(h.rt, h.get(e, "data") as avm2.AsObject);
      assert.equal(bytes.position, 0);
      const values: number[] = [];
      for (let at = 0; at < bytes.length; at += 4) {
        values.push(bytes.view.getFloat32(at, bytes.littleEndian));
      }
      data.push({ position: h.get(e, "position"), values });
    });
    assert.equal(h.opens.length, 1);
    h.opens[0].events.state("granted");
    h.opens[0].events.samples(new Float32Array(4800).fill(0.25), 48000);
    assert.equal(data.length, 0);
    h.player.tick();
    assert.deepEqual(statuses, ["Microphone.Unmuted"]);
    assert.equal(data[0].position, 0);
    assert.equal(data[0].values.length, 800);
    assert.ok(Math.abs(data[0].values[799] - 0.25) < 1e-6);
    assert.equal(h.get(h.mic, "activityLevel"), 25);
    h.set(h.mic, "rate", 44);
    h.set(h.mic, "gain", 75);
    assert.equal(h.opens[0].modes.at(-1)?.gain, 75);
    h.opens[0].events.samples(new Float32Array(4800).fill(-0.5), 48000);
    h.player.tick();
    assert.equal(data[1].position, 800);
    assert.equal(data[1].values.length, 4410);
    remove();
    assert.equal(h.opens[0].closed, 1);
    h.opens[0].events.samples(new Float32Array(4800), 48000);
    h.player.tick();
    assert.equal(data.length, 2);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Microphone activity, denial, loopback mixing and teardown stay bounded", async () => {
  const h = await setup();
  try {
    const activity: avm2.Value[] = [];
    h.listen(h.mic, "activity", (e) => activity.push(h.get(e, "activating")));
    assert.equal(h.opens.length, 0);
    h.call(h.mic, "setSilenceLevel", 10, 100);
    h.call(h.mic, "setLoopBack", true);
    h.opens[0].events.state("denied");
    h.player.tick();
    assert.equal(h.get(h.mic, "muted"), true);
    h.call(h.mic, "setLoopBack", true);
    h.opens[1].events.state("granted");
    h.opens[1].events.samples(new Float32Array(4800).fill(0.5), 48000);
    h.player.tick();
    assert.deepEqual(activity, [true]);
    h.opens[1].events.samples(new Float32Array(4800), 48000);
    h.player.tick();
    assert.deepEqual(activity, [true, false]);
    const transform = h.rt.construct(h.rt.classNamed("flash.media::SoundTransform"), 0.3);
    h.set(h.mic, "soundTransform", transform);
    assert.equal(h.output[0].mix.volume, 0.3);
    for (let i = 0; i < 20; i++) {
      h.opens[1].events.samples(new Float32Array(4800).fill(0.5), 48000);
    }
    assert.equal(h.output[0].blocks.length, 2);
    assert.equal(h.output[0].blocks[0][0].length, 4410);
    h.s.captureLifetime.abort();
    assert.equal(h.opens[1].closed, 1);
    assert.equal(h.output[0].stopped, true);
    h.call(h.mic, "setLoopBack", true);
    assert.equal(h.opens.length, 2);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("rate changes discard pending old-rate PCM and delayed frames keep bounded events", async () => {
  const h = await setup();
  try {
    assert.equal(h.get(h.mic, "framesPerPacket"), 2);
    h.call(h.mic, "setSilenceLevel", 10, 100);
    h.call(h.mic, "setSilenceLevel", 10);
    assert.equal(h.get(h.mic, "silenceTimeout"), 2000);
    const sizes: number[] = [];
    h.listen(h.mic, "sampleData", (e) =>
      sizes.push(Number(h.get(h.get(e, "data") as avm2.AsObject, "length")) / 4),
    );
    h.opens[0].events.state("granted");
    h.opens[0].events.samples(new Float32Array(4800).fill(0.5), 48000);
    h.set(h.mic, "rate", 44);
    h.opens[0].events.samples(new Float32Array(4800).fill(0.5), 48000);
    h.player.tick();
    assert.deepEqual(sizes, [4410]);
    const defer = h.s.loads.deferHostEvent.bind(h.s.loads);
    let queued = 0;
    h.s.loads.deferHostEvent = (event) => {
      queued++;
      defer(event);
    };
    h.call(h.mic, "setSilenceLevel", 10, 0);
    for (let i = 0; i < 1000; i++) {
      h.opens[0].events.samples(new Float32Array(128).fill(i % 2 ? 0.5 : 0), 48000);
    }
    assert.equal(queued, 1);
    h.player.tick();
    assert.ok(sizes[1] <= 16384);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("enhanced capture applies echo settings and excludes other microphones", async () => {
  const h = await setup();
  try {
    const devices = h.s.capture?.microphones as { id: string; name: string }[];
    devices.push({ id: "second", name: "Second microphone" });
    devices.push({ id: "third", name: "Idle microphone" });
    const second = h.call(h.klass, "getMicrophone", 1) as avm2.AsObject;
    const idle = h.call(h.klass, "getMicrophone", 2) as avm2.AsObject;
    h.call(second, "setLoopBack", true);
    h.opens[0].events.state("granted");
    const statuses: avm2.Value[] = [];
    const idleStatuses: avm2.Value[] = [];
    h.listen(second, "status", (e) => statuses.push(`${h.get(e, "code")} ${h.get(e, "level")}`));
    h.listen(idle, "status", (e) => idleStatuses.push(h.get(e, "code")));
    assert.equal(h.call(h.klass, "getEnhancedMicrophone"), h.mic);
    assert.equal(h.call(h.klass, "getEnhancedMicrophone"), h.mic);
    assert.equal(h.opens[0].closed, 1);
    h.call(second, "setLoopBack", true);
    assert.equal(h.opens.length, 1);
    h.call(h.mic, "setLoopBack", true);
    assert.deepEqual(h.opens[1].modes[0], {
      gain: 50,
      echoCancellation: true,
      noiseSuppression: true,
    });
    h.player.tick();
    assert.deepEqual(statuses, ["Microphone.Unmuted status", "Microphone.Unavailable status"]);
    assert.deepEqual(idleStatuses, []);
    assert.equal(h.get(second, "muted"), false);
    const options = h.rt.construct(h.rt.classNamed("flash.media::MicrophoneEnhancedOptions"));
    h.set(options, "mode", "off");
    h.set(h.mic, "enhancedOptions", options);
    assert.equal(h.opens[1].modes.at(-1)?.echoCancellation, false);
    h.set(h.mic, "codec", "Speex");
    assert.equal(h.get(h.mic, "rate"), 16);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Microphone reopening does not repeat consent and revoke reports Muted", async () => {
  const h = await setup();
  try {
    const statuses: avm2.Value[] = [];
    const activity: avm2.Value[] = [];
    h.listen(h.mic, "status", (e) => statuses.push(h.get(e, "code")));
    h.listen(h.mic, "activity", (e) => activity.push(h.get(e, "activating")));
    const remove = h.listen(h.mic, "sampleData", () => {});
    h.opens[0].events.state("granted");
    h.player.tick();
    remove();
    h.listen(h.mic, "sampleData", () => {});
    h.opens[1].events.state("granted");
    h.call(h.mic, "setSilenceLevel", 10, 0);
    h.opens[1].events.samples(new Float32Array(480).fill(0.5), 48000);
    h.opens[1].events.samples(new Float32Array(480), 48000);
    h.player.tick();
    assert.deepEqual(activity, []);
    assert.deepEqual(statuses, ["Microphone.Unmuted"]);
    h.s.captureLifetime.abort();
    h.player.tick();
    assert.deepEqual(statuses, ["Microphone.Unmuted", "Microphone.Muted"]);
    assert.equal(h.get(h.mic, "muted"), true);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("loopback without an audio host opens no device", async () => {
  const h = await setup(false);
  try {
    h.call(h.mic, "setLoopBack", true);
    assert.equal(h.opens.length, 0);
    h.listen(h.mic, "sampleData", () => {});
    assert.equal(h.opens.length, 1);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("real-time sample delivery waits for Unmuted, then survives stalled frames", async () => {
  const h = await setup(true, () => performance.now());
  try {
    const positions: number[] = [];
    const order: string[] = [];
    let count = 0;
    h.set(h.mic, "rate", 44);
    h.listen(h.mic, "status", (event) => order.push(String(h.get(event, "code"))));
    h.listen(h.mic, "sampleData", (event) => {
      order.push("samples");
      positions.push(Number(h.get(event, "position")));
      assert.equal(positions.at(-1), count);
      const bytes = avm2.bytesOf(h.rt, h.get(event, "data") as avm2.AsObject);
      assert.equal(bytes.littleEndian, false);
      count += bytes.length / 4;
    });
    h.opens[0].events.state("granted");
    const buffer = new Float32Array(2048).fill(0.25);
    for (let i = 0; i < 5; i++) {
      h.opens[0].events.samples(buffer, 48000);
    }

    // The frame that tells the script of the grant has not come: no samples may come before it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(order, []);
    h.player.tick();
    assert.equal(order[0], "Microphone.Unmuted");
    assert.equal(count, Math.ceil((5 * 2048 * 44100) / 48000));
    for (let i = 0; i < 30; i++) {
      h.opens[0].events.samples(buffer, 48000);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(count, Math.ceil((35 * 2048 * 44100) / 48000));
    assert.ok(positions.length > 2);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("unloading an unrelated movie never reopens a denied parent microphone", async () => {
  const h = await setup();
  try {
    h.listen(h.mic, "sampleData", () => {});
    h.opens[0].events.state("denied");
    stopMicrophones(h.s, {} as NonNullable<typeof h.s.library>);
    assert.equal(h.opens.length, 1);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("Stop tells only microphones that were opened or told of a decision", async () => {
  const h = await setup();
  try {
    const devices = h.s.capture?.microphones as { id: string; name: string }[];
    devices.push({ id: "second", name: "Opening microphone" });
    const opening = h.call(h.klass, "getMicrophone", 1) as avm2.AsObject;
    const idle: avm2.Value[] = [];
    const asked: avm2.Value[] = [];
    h.listen(h.mic, "status", (e) => idle.push(h.get(e, "code")));
    h.listen(opening, "status", (e) => asked.push(h.get(e, "code")));
    h.listen(opening, "sampleData", () => {});
    h.s.captureLifetime.abort();
    for (let i = 0; i < 3; i++) {
      h.player.tick();
    }

    assert.deepEqual(idle, []);
    assert.deepEqual(asked, ["Microphone.Muted"]);
    assert.equal(h.get(h.mic, "muted"), true);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});

test("a child's loopback and listeners go with it; the parent's loopback stays", async () => {
  const h = await setup();
  try {
    type Library = NonNullable<typeof h.s.library>;
    const parent = {} as Library;
    const child = {} as Library;
    let running: Library | null = parent;
    h.s.code.runningLibrary = () => running;
    h.call(h.mic, "setLoopBack", true);
    running = child;
    h.call(h.mic, "setLoopBack", true);
    const childListener = { $f: () => {} };
    h.call(h.mic, "addEventListener", "activate", childListener);
    h.s.code.calledLibrary = (fn) => (fn === childListener ? child : null);
    assert.equal(h.opens.length, 1);
    h.opens[0].events.state("granted");
    stopMicrophones(h.s, child);
    assert.equal(microphoneStates.get(h.mic)?.loopback, true);
    assert.equal(h.opens[0].closed, 0);
    assert.equal(h.call(h.mic, "hasEventListener", "activate"), false);
    assert.ok(!h.s.activationTargets("activate").live().includes(h.mic));
    stopMicrophones(h.s, parent);
    assert.equal(microphoneStates.get(h.mic)?.loopback, false);
    assert.equal(h.opens[0].closed, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
    h.s.destroy();
  }
});
