// Authored AVM1 movies for an AS3 Loader's lifecycle tests
// (tests/unit/player/scripting/avm1-movie.test.ts): what a loaded movie's
// sounds, unload, stage and SharedObjects do with the AS3 player around it.
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

/**
 * A movie that logs each frame, holds the LocalConnection "lifecycle",
 * fills the 32 channels in its second frame, and, unless `handlers` is
 * false, has onUnload on its root and on a clip in it; with `interval`, an
 * interval logs while it runs.
 */
export function unloadMovie(interval: boolean, handlers = true): Uint8Array {
  return movie(`${prelude}
this.createEmptyMovieClip("kid", 1);
${
  handlers
    ? `this.onUnload = function () { log("onUnload " + ef); };
kid.onUnload = function () { log("kid onUnload"); };`
    : ""
}
var lc = new LocalConnection();
lc.connect("lifecycle");
${interval ? 'setInterval(function () { log("interval"); }, 10);' : ""}
onEnterFrame = function () {
  ef++;
  log("ef " + ef);
  if (ef == 2) { startAll(); }
};
stop();`);
}

/**
 * A movie whose onUnload sends "pong" to the host's LocalConnection
 * "hostlc", and logs the send's onStatus.
 */
export function sendingMovie(): Uint8Array {
  return movie(`${prelude}
var back = new LocalConnection();
back.onStatus = function (info) { log("status " + info.level); };
this.onUnload = function () { log("onUnload"); back.send("hostlc", "pong", 99); };
onEnterFrame = function () { ef++; log("ef " + ef); };
stop();`);
}

/** Stage and the quality as the movie reads them, its own changes to them, and onResize. */
export function stageMovie(): Uint8Array {
  return movie(`${prelude}
function st() {
  return Stage.width + "x" + Stage.height + " " + Stage.scaleMode + " " + Stage.align + " " +
    Stage.showMenu + " " + _quality + " " + _highquality;
}
var listener = {};
listener.onResize = function () { log("onResize " + st()); };
Stage.addListener(listener);
onEnterFrame = function () {
  ef++;
  if (ef == 1) { log("stage " + st()); }
  if (ef == 2) { _quality = "LOW"; log("_quality LOW " + st()); }
  if (ef == 4) { log("stage " + st()); _highquality = 2; log("_highquality 2 " + st()); }
  if (ef == 6) { log("stage " + st()); _highquality = 0; log("_highquality 0 " + st()); }
  if (ef == 8) { Stage.align = "BR"; Stage.showMenu = false; log("align " + st()); }
  if (ef == 10) { Stage.scaleMode = "noScale"; log("noScale " + st()); }
  if (ef == 12) { log("stage " + st()); }
};
stop();`);
}

/**
 * SharedObjects: x, its default path's, written and flushed; y the same
 * and z at "/" written and left to be written as the movie goes.
 */
export function sharedMovie(): Uint8Array {
  return movie(`${prelude}
function d(o) { var r = ""; for (var k in o.data) { r += k + "=" + o.data[k] + ";"; } return r; }
log("url " + _url);
var x = SharedObject.getLocal("x");
var y = SharedObject.getLocal("y");
var z = SharedObject.getLocal("z", "/");
log("read x " + d(x) + " y " + d(y) + " z " + d(z));
if (x.data.v == undefined) {
  x.data.v = "avm1";
  log("flush " + x.flush());
  y.data.v = "avm1";
  z.data.v = "avm1";
}
stop();`);
}
