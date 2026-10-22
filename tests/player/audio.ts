// Short MP3 slices rendered by the browser's real decoder and Web Audio
// graph: the SWF's seek offset must reach tone rather than encoder silence.
import assert from "node:assert/strict";
import { withPage } from "./chrome.ts";

await withPage("runSwf", async (evaluate) => {
  const result = await evaluate<{
    silent: number[];
    shifted: number[];
    tagged: number[];
    loadedDuration: number;
  }>(`(async () => {
    const { browserAudioHost } = await import('/player/media/audio.js');
    const NativeContext = globalThis.AudioContext;
    const mix = { volume: 1, leftToLeft: 1, leftToRight: 0, rightToLeft: 0, rightToRight: 1 };
    async function render(file, seek, rate, count, loops, endMs, windows) {
      const bytes = new Uint8Array(await (await fetch('/page/sounds/' + file)).arrayBuffer());
      const context = new OfflineAudioContext(2, 24000, 48000);
      globalThis.AudioContext = class { constructor() { return context; } };
      const host = browserAudioHost();
      const sound = await host.decode(seek === null ? bytes : {
        id: 1, format: 2, sampleRate: rate, sampleSize: 16,
        channels: rate === 22050 ? 1 : 2, sampleCount: count, seekSamples: seek, data: bytes
      });
      if (seek === null) return sound.durationMs;
      sound.play(0, loops, mix, { endMs });
      const output = (await context.startRendering()).getChannelData(0);
      return [sound.durationMs, ...windows.map(([start, end]) => {
        let peak = 0;
        for (let i = Math.ceil(start * 48); i < Math.floor(end * 48); i++) {
          peak = Math.max(peak, Math.abs(output[i]));
        }
        return peak;
      })];
    }
    try {
      const silent = await render('tone22.mp3', 0, 22050, 5513, 8, 1000 / 44.1, [[0, 180]]);
      const shifted = await render('tone22.mp3', 1661, 22050, 5513, 8, 1000 / 44.1,
        [[0, 20], [150, 170], [190, 220]]);
      const tagged = await render('tone-tagged.mp3', 2257, 44100, 11025, 1, 250,
        [[0, 20], [230, 245], [260, 300]]);
      const loadedDuration = await render('tone-tagged.mp3', null);
      return { silent, shifted, tagged, loadedDuration };
    } finally {
      globalThis.AudioContext = NativeContext;
    }
  })()`);
  assert.equal(result.exception, null);
  const audio = result.value;
  assert.ok(audio);
  assert.ok(
    audio.silent[1] < 0.001,
    "without the seek offset the short loops contain only encoder silence",
  );
  assert.ok(audio.shifted[1] > 0.005, "the first short loop is audible");
  assert.ok(audio.shifted[2] > 0.005, "later loops are audible");
  assert.equal(audio.shifted[3], 0, "the loops end at the requested out point");
  assert.equal(audio.tagged[0], 250);
  assert.ok(audio.tagged[1] > 0.005);
  assert.ok(audio.tagged[2] > 0.005, "gapless metadata must not trim the SWF twice");
  assert.equal(audio.tagged[3], 0);
  assert.equal(audio.loadedDuration, 250, "external MP3 files keep browser gapless decoding");
});

console.log("browser MP3 seek offsets and short loops: pass");
