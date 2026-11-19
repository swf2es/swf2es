// Authored AVM1 movies for an AS3 Loader's lifecycle tests
// (tests/unit/player/scripting/avm1-movie.test.ts): what a loaded movie's
// sounds do with the AS3 player around it.
// Each logs "avm1:" lines; `ef` counts its frames from its first.
import { flashAssembler, script } from "./avm1-script.ts";
import * as w from "./swf-writer.ts";

/** A second of 8-bit mono at 5512.5 Hz, quiet, exported as "tone". */
const TONE = 5512;

function movie(source: string): Uint8Array {
  return w.swf({
    version: 8,
    width: 100,
    height: 80,
    frameCount: 1,
    tags: [
      w.defineSound(1, { rate: 0, samples: TONE }, new Uint8Array(TONE).fill(128)),
      w.exportAssets([[1, "tone"]]),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

const prelude = `
function log(s) { trace("avm1:" + s); }
var sounds = [];
function startAll() {
  for (var i = 0; i < 32; i++) {
    var s = new Sound(_root);
    s.attachSound("tone");
    s.start(0, 100);
    sounds.push(s);
  }
}
var ef = 0;`;

/**
 * The global Sound's transforms in its first frames, then the 32 channels
 * filled at frames 8, 12 and 16, and every sound stopped by the global
 * Sound's stop at 10 and stopAllSounds at 14.
 */
export function soundMovie(): Uint8Array {
  return movie(`${prelude}
var g = new Sound();
function t(o) {
  var x = o.getTransform();
  return o.getVolume() + " " + o.getPan() + " " + x.ll + " " + x.lr + " " + x.rl + " " + x.rr;
}
onEnterFrame = function () {
  ef++;
  if (ef == 1) { log("g " + t(g)); }
  if (ef == 2) { g.setVolume(33); log("setVolume " + t(g)); }
  if (ef == 3) { g.setPan(-50); log("setPan " + t(g)); }
  if (ef == 4) { g.setTransform({ ll: 60, lr: 20, rl: 10, rr: 70 }); log("setTransform " + t(g)); }
  if (ef == 5) { g.setVolume(250); log("setVolume " + t(g)); }
  if (ef == 6) { log("g " + t(g)); }
  if (ef == 8 || ef == 12 || ef == 16) { startAll(); log("started"); }
  if (ef == 10) { g.stop(); log("stop"); }
  if (ef == 14) { stopAllSounds(); log("stopAllSounds"); }
};
stop();`);
}
