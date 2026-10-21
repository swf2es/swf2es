import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import type { AudioHost, SoundMix } from "../../../../../../packages/player/dist/media/audio.js";
import { liveSounds, mixOf } from "../../../../../../packages/player/dist/media/sounds.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

const out = fileURLToPath(new URL("../../../../out/dynamic-sound/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

function device(earlyRefill = false) {
  let now = 0;
  let finished = false;
  let stopped = false;
  let refill = () => {};
  const blocks: Float32Array[][] = [];
  const mixes: SoundMix[] = [];
  const audio: AudioHost = {
    decode: async () => {
      throw new Error("dynamic samples must not be decoded as a file");
    },
    stream(mix, request) {
      refill = request;
      if (earlyRefill) {
        request();
      }
      mixes.push(mix);
      return {
        append: (samples) => {
          blocks.push(samples);
        },
        finish: () => {
          finished = true;
        },
        stop: () => {
          stopped = true;
        },
        setMix: (next) => {
          mixes.push(next);
        },
        get ended() {
          return stopped || (finished && now >= blocks.reduce((n, b) => n + b[0].length, 0) / 44.1);
        },
        get positionMs() {
          return now;
        },
      };
    },
  };
  return {
    audio,
    blocks,
    mixes,
    refill: () => refill(),
    advance: (ms: number) => {
      now = ms;
    },
    stopped: () => stopped,
    finished: () => finished,
  };
}

async function setup(audio: AudioHost | null = null) {
  const abc = compiler(out)(
    "DynamicRoot",
    "package { import flash.display.Sprite; public class DynamicRoot extends Sprite {} }",
  );
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    audio,
    onUncaught: (error) => errors.push(error),
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "DynamicRoot"), s);
  await player.start();
  const rt = s.rt;
  const get = (o: avm2.AsObject, name: string) => rt.getProperty(o, rt.publicName(name));
  const call = (o: avm2.AsObject, name: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(name), ...args);
  const listen = (o: avm2.AsObject, type: string, fn: (event: avm2.AsObject) => void) => {
    o.$listeners ??= new Map();
    o.$listeners.set(type, [{ fn: { $f: fn }, capture: false, priority: 0 }]);
  };
  const sound = rt.construct(rt.classNamed("flash.media::Sound"));
  return { s, player, rt, sound, get, call, listen, errors };
}

test("a first MP3 extract supplies samples synchronously without an audio device", async () => {
  const { s, player, rt, sound, call, errors } = await setup();
  try {
    const source = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    const bytes = avm2.bytesOf(rt, source);
    bytes.write(
      new Uint8Array(
        await readFile(new URL("../../../../../player/sounds/tone.mp3", import.meta.url)),
      ),
    );
    bytes.position = 0;
    call(sound, "loadCompressedDataFromByteArray", source, bytes.length);
    const target = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    assert.equal(call(sound, "extract", target, 100000), 12672);
    assert.equal(avm2.bytesOf(rt, target).length, 12672 * 8);
    assert.deepEqual(errors, []);
  } finally {
    player.destroy();
    s.destroy();
  }
});

function samples(rt: avm2.Runtime, event: avm2.AsObject, count: number, little = false) {
  const bytes = avm2.bytesOf(rt, rt.getProperty(event, rt.publicName("data")));
  assert.equal(bytes.position, 0);
  bytes.littleEndian = little;
  bytes.setLength(count * 8);
  bytes.position = count * 8;
  for (let i = 0; i < count; i++) {
    bytes.view.setFloat32(i * 8, 0.123456, little);
    bytes.view.setFloat32(i * 8 + 4, -0.25, little);
  }
}

test("dynamic Sound requests stereo float buffers and completes after the device drains", async () => {
  const d = device();
  const h = await setup(d.audio);
  try {
    const positions: number[] = [];
    let previous: avm2.AsObject | null = null;
    h.listen(h.sound, "sampleData", (event) => {
      const data = h.get(event, "data");
      if (previous) {
        assert.equal(data, previous);
      }
      previous = data;
      positions.push(h.get(event, "position"));
      samples(h.rt, event, [4096, 2048, 1][positions.length - 1], positions.length === 2);
    });
    const channel = h.call(h.sound, "play");
    assert.ok(channel);
    assert.deepEqual(positions, [0]);
    assert.equal(h.get(h.sound, "length"), 0);
    assert.equal(liveSounds(h.s), 1);
    let complete = 0;
    h.listen(channel, "soundComplete", () => complete++);
    d.advance(50);
    d.refill();
    d.advance(100);
    d.refill();
    assert.deepEqual(positions, [0, 4096, 6144]);
    assert.equal(d.finished(), true);
    assert.equal(complete, 0);
    for (const block of d.blocks) {
      assert.equal(block[0][0], Math.fround(0.123456));
      assert.equal(block[1][0], -0.25);
    }
    assert.equal(h.get(channel, "position"), 100);
    h.player.tick();
    assert.equal(complete, 0);
    d.advance(6145 / 44.1);
    h.player.tick();
    assert.equal(complete, 1);
    assert.equal(liveSounds(h.s), 0);
    d.advance(500);
    assert.equal(h.get(channel, "position"), 6145 / 44.1);
    h.player.tick();
    assert.equal(complete, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
  }
});

test("stopping or destroying a dynamic channel stops requests and preserves its position", async () => {
  for (const action of ["stop", "stopAll", "destroy"] as const) {
    const d = device();
    const h = await setup(d.audio);
    try {
      let requests = 0;
      h.listen(h.sound, "sampleData", (event) => {
        requests++;
        samples(h.rt, event, 8000);
      });
      const channel = h.call(h.sound, "play");
      d.advance(25);
      switch (action) {
        case "stop":
          h.call(channel, "stop");
          break;
        case "stopAll":
          h.call(h.rt.classNamed("flash.media::SoundMixer"), "stopAll");
          break;
        case "destroy":
          h.player.destroy();
          break;
      }
      d.advance(500);
      d.refill();
      assert.equal(requests, 1);
      assert.equal(d.stopped(), true);
      assert.equal(h.get(channel, "position"), 25);
    } finally {
      h.player.destroy();
    }
  }
});

test("stopAll from the initial sample callback cannot leave audio playing", async () => {
  const d = device();
  const h = await setup(d.audio);
  try {
    h.listen(h.sound, "sampleData", (event) => {
      samples(h.rt, event, 4096);
      h.call(h.rt.classNamed("flash.media::SoundMixer"), "stopAll");
    });
    assert.ok(h.call(h.sound, "play"));
    assert.equal(d.stopped(), true);
    assert.equal(d.blocks.length, 0);
    assert.equal(liveSounds(h.s), 0);
  } finally {
    h.player.destroy();
  }
});

test("empty and oversized initial buffers return channels; oversized data reports AIR's error", async () => {
  for (const count of [0, 8193]) {
    const h = await setup();
    try {
      h.listen(h.sound, "sampleData", (event) => samples(h.rt, event, count));
      const channel = h.call(h.sound, "play");
      assert.ok(channel);
      let completed = false;
      h.listen(channel, "soundComplete", () => {
        completed = true;
      });
      h.player.tick();
      assert.equal(completed, true);
      assert.deepEqual(
        h.errors.map((e) => h.rt.toString(e)),
        count ? ["RangeError: Error #2004"] : [],
      );
    } finally {
      h.player.destroy();
    }
  }
});

test("dynamic channels share Flash's 32-channel limit and mixer transforms", async () => {
  const d = device();
  const h = await setup(d.audio);
  try {
    h.listen(h.sound, "sampleData", (event) => samples(h.rt, event, 4096));
    const channel = h.call(h.sound, "play");
    const transform = h.rt.construct(h.rt.classNamed("flash.media::SoundTransform"), 0.5);
    h.rt.setProperty(channel, h.rt.publicName("soundTransform"), transform);
    assert.deepEqual(d.mixes.at(-1), { ...mixOf(null), volume: 0.5 });
    for (let i = 1; i < 32; i++) {
      assert.ok(h.call(h.sound, "play"));
    }
    assert.equal(liveSounds(h.s), 32);
    assert.equal(h.call(h.sound, "play"), null);
  } finally {
    h.player.destroy();
  }
});

test("AIR reuses the sample ByteArray and counts writes, not its retained length", async () => {
  const d = device();
  const h = await setup(d.audio);
  try {
    let calls = 0;
    let retained: avm2.AsObject | undefined;
    h.listen(h.sound, "sampleData", (event) => {
      const data = h.get(event, "data");
      const bytes = avm2.bytesOf(h.rt, data);
      if (calls++ === 0) {
        retained = data;
        samples(h.rt, event, 2048, true);
      } else {
        assert.equal(data, retained);
        assert.equal(bytes.length, 2048 * 8);
        assert.equal(bytes.position, 0);
        assert.equal(bytes.littleEndian, true);
      }
    });
    h.call(h.sound, "play");
    d.refill();
    assert.equal(calls, 2);
    assert.equal(d.finished(), true);
    assert.equal(d.blocks.length, 1);
  } finally {
    h.player.destroy();
  }
});

test("dynamic startTime offsets later sample requests and channel position; loops do not repeat PCM", async () => {
  const d = device();
  const h = await setup(d.audio);
  try {
    const positions: number[] = [];
    h.listen(h.sound, "sampleData", (event) => {
      positions.push(h.get(event, "position"));
      if (positions.length === 1) {
        samples(h.rt, event, 2048);
      }
    });
    const channel = h.call(h.sound, "play", 100, 3);
    assert.equal(h.get(channel, "position"), 100);
    d.refill();
    assert.deepEqual(positions, [0, 6458]);
    assert.equal(d.blocks.length, 1);
    d.advance(2048 / 44.1);
    h.player.tick();
    assert.equal(h.get(channel, "position"), 100 + 2048 / 44.1);
    assert.equal(liveSounds(h.s), 0);
  } finally {
    h.player.destroy();
  }
});

test("a host's synchronous setup refill cannot discard the initial samples", async () => {
  const d = device(true);
  const h = await setup(d.audio);
  try {
    let requests = 0;
    h.listen(h.sound, "sampleData", (event) => {
      requests++;
      samples(h.rt, event, 4096);
    });
    assert.ok(h.call(h.sound, "play"));
    assert.equal(requests, 1);
    assert.equal(d.blocks.length, 1);
  } finally {
    h.player.destroy();
  }
});

for (const allocated of [false, true]) {
  test(`a sample cursor beyond logical data ends safely (${allocated ? "retained capacity" : "empty buffer"})`, async () => {
    const d = device();
    const h = await setup(d.audio);
    try {
      let requests = 0;
      h.listen(h.sound, "sampleData", (event) => {
        requests++;
        const bytes = avm2.bytesOf(h.rt, h.get(event, "data"));
        if (allocated) {
          bytes.setLength(32768);
          bytes.setLength(0);
        }
        bytes.position = 16384;
      });
      const channel = h.call(h.sound, "play");
      assert.ok(channel);
      assert.equal(d.blocks.length, 0);
      assert.equal(d.finished(), true);
      assert.equal(h.errors.length, 1);
      assert.equal(h.rt.traitsOf(h.errors[0]).name, "flash.errors::EOFError");
      assert.equal(h.get(h.errors[0], "errorID"), 2030);
      d.refill();
      h.player.tick();
      d.refill();
      assert.equal(requests, 1);
      assert.equal(h.errors.length, 1);
      assert.equal(liveSounds(h.s), 0);
    } finally {
      h.player.destroy();
    }
  });
}

test("failed stream creation cannot consume channel slots, and a recovered host can play", async () => {
  const d = device();
  const create = d.audio.stream;
  const failure = new Error("audio device unavailable");
  d.audio.stream = () => {
    throw failure;
  };
  const h = await setup(d.audio);
  try {
    h.listen(h.sound, "sampleData", (event) => samples(h.rt, event, 4096));
    for (let i = 0; i < 40; i++) {
      assert.throws(
        () => h.call(h.sound, "play"),
        (error) => error === failure,
      );
      assert.equal(liveSounds(h.s), 0);
    }
    d.audio.stream = create;
    assert.ok(h.call(h.sound, "play"));
    assert.equal(d.blocks.length, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    h.player.destroy();
  }
});

for (const when of ["initial", "prefill", "refill", "finish", "position"] as const) {
  test(`a host failure during ${when} stops the stream and cannot repeat`, async () => {
    const d = device();
    const create = d.audio.stream;
    assert.ok(create);
    const failure = new Error(`host ${when} failure`);
    let later = false;
    let appended = 0;
    d.audio.stream = (mix, refill) => {
      const stream = create(mix, refill);
      return {
        ...stream,
        append(data) {
          appended++;
          if (
            when === "initial" ||
            (when === "prefill" && appended === 2) ||
            (when === "refill" && later)
          ) {
            throw failure;
          }
          stream.append(data);
        },
        finish() {
          if (when === "finish") {
            throw failure;
          }
          stream.finish();
        },
        get positionMs() {
          if (when === "position" && later) {
            throw failure;
          }
          return stream.positionMs;
        },
        get ended() {
          return stream.ended;
        },
      };
    };
    const h = await setup(d.audio);
    try {
      let requests = 0;
      h.listen(h.sound, "sampleData", (event) => {
        requests++;
        samples(h.rt, event, when === "prefill" ? 8192 : when === "finish" && later ? 0 : 4096);
      });
      if (when === "initial" || when === "prefill") {
        assert.throws(
          () => h.call(h.sound, "play"),
          (error) => error === failure,
        );
        assert.deepEqual(h.errors, []);
      } else {
        const channel = h.call(h.sound, "play");
        let completed = false;
        h.listen(channel, "soundComplete", () => {
          completed = true;
        });
        d.advance(25);
        later = true;
        d.refill();
        assert.equal(completed, false);
        assert.deepEqual(h.errors, [failure]);
      }
      const before = requests;
      assert.equal(d.stopped(), true);
      assert.equal(liveSounds(h.s), 0);
      d.refill();
      h.player.tick();
      assert.equal(requests, before);
      assert.equal(h.errors.length, when === "initial" || when === "prefill" ? 0 : 1);
    } finally {
      h.player.destroy();
    }
  });
}
