// MovieClipLoader in node: what loadClip, getProgress and unloadClip take
// and return, as the corpus's mcl_* tests have Flash's, and the events its
// listeners hear, in Flash's order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";
import { files, movie, play, take } from "../network.ts";

test("loadClip takes a string URL and a target that names a display object or a level", async () => {
  const played = await play(`var mcl = new MovieClipLoader();
createEmptyMovieClip("mc1", 1);
trace(mcl.loadClip());
trace(mcl.loadClip("x.swf"));
trace(mcl.loadClip(0, 0));
trace(mcl.loadClip("x.swf", "doesNotExist"));
trace(mcl.loadClip("x.swf", {}));
trace(mcl.loadClip("x.swf", null));
trace(mcl.loadClip("x.swf", "mc1"));
trace(mcl.loadClip("x.swf", 2.9) + " " + typeof _level2);
trace(mcl.getProgress() + " " + mcl.getProgress({}) + " " + mcl.getProgress(null));
var p = mcl.getProgress(3);
trace(p.bytesLoaded + " " + p.bytesTotal);
p = mcl.getProgress(0);
trace(p.bytesLoaded + " " + p.bytesTotal);
trace(mcl.unloadClip() + " " + mcl.unloadClip(7) + " " + mcl.unloadClip(mc1));
var keys = []; for (var k in mcl) { keys.push(k); } trace(keys.length);
trace(mcl._listeners.length + " " + (mcl._listeners[0] == mcl));`);

  const size = played.player.bytes.length;
  assert.deepEqual(take(played), [
    "undefined",
    "undefined",
    "false",
    "false",
    "false",
    "false",
    "true",
    "true movieclip",
    "undefined undefined undefined",
    "undefined undefined",
    `${size} ${size}`,
    "undefined false true",
    "0",
    "1 true",
  ]);
});

test("a listener hears onLoadStart, onLoadProgress and onLoadComplete as the load arrives, and onLoadInit after its first frame's actions", async () => {
  const child = movie(`trace("child frame " + this.message);`);
  const played = await play(
    `var mcl = new MovieClipLoader();
var mc = createEmptyMovieClip("mc", 1);
mc.message = "original";
var o = {};
o.onLoadStart = function (t) { trace("start " + t + " " + t.message); t.message = "from start"; };
o.onLoadProgress = function (t, loaded, total) { trace("progress " + t + " " + loaded + " " + total); };
o.onLoadComplete = function (t, status) { trace("complete " + t + " " + status + " " + t.message); };
o.onLoadInit = function (t) { trace("init " + t + " " + t.message); };
o.onLoadError = function (t, code, status) { trace("error " + t + " " + code + " " + status + " " + arguments.length); };
mcl.addListener(o);
mcl.loadClip("child.swf", mc);
mcl.loadClip("missing.swf", createEmptyMovieClip("other", 2));`,
    { fetch: files({ "child.swf": child }) },
  );

  assert.deepEqual(take(played), []);
  await played.deliver();
  assert.deepEqual(take(played), [
    "start _level0.mc undefined",
    `progress _level0.mc ${child.length} ${child.length}`,
    "complete _level0.mc 0 from start",
    "start _level0.other undefined",
    "error _level0.other URLNotFound 404 3",
  ]);
  played.player.tick();
  assert.deepEqual(take(played), ["child frame from start", "init _level0.mc from start"]);
  played.player.tick();
  assert.deepEqual(take(played), []);
});

test("onLoadInit comes after the frames the first frame's gotos entered have run their actions", async () => {
  // The loaded movie's first frame sends its clip to a frame that stops it; onLoadInit sends it
  // back to play, and it plays on. adl's order: "mc f3" before "init", and the clip playing.
  const actions = (source: string) =>
    w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]);
  const child = w.swf({
    version: 8,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [
      w.sprite(1, 3, [
        w.showFrame(),
        actions(`trace("mc f2");`),
        w.showFrame(),
        actions(`trace("mc f3"); stop();`),
        w.showFrame(),
        w.end(),
      ]),
      w.place({ depth: 1, character: 1, name: "mc" }),
      actions(`trace("child f1 " + mc._currentframe);
mc.gotoAndPlay(3);
trace("child after goto " + mc._currentframe);
stop();`),
      w.showFrame(),
      w.end(),
    ],
  });
  const played = await play(
    `var mcl = new MovieClipLoader();
var l = {};
l.onLoadComplete = function (t) { trace("complete " + t.mc._currentframe); };
l.onLoadInit = function (t) {
  trace("init " + t.mc._currentframe);
  t.mc.gotoAndPlay(1);
  trace("init after goto " + t.mc._currentframe);
};
mcl.addListener(l);
createEmptyMovieClip("holder", 1);
mcl.loadClip("child.swf", holder);
var n = 0;
onEnterFrame = function () { n++; trace("frame " + n + " mc " + holder.mc._currentframe); };`,
    { fetch: files({ "child.swf": child }) },
  );

  await played.deliver();
  for (let i = 0; i < 4; i++) {
    played.player.tick();
  }

  assert.deepEqual(take(played), [
    "complete undefined",
    "child f1 1",
    "child after goto 3",
    "frame 1 mc 3",
    "mc f3",
    "init 3",
    "init after goto 1",
    "mc f2",
    "frame 2 mc 2",
    "mc f3",
    "frame 3 mc 3",
    "frame 4 mc 3",
  ]);
});

test("unloadClip of a load under way cancels it: it starts as it arrives, and no more", async () => {
  const played = await play(
    `var mcl = new MovieClipLoader();
var mc = createEmptyMovieClip("mc", 1);
mcl.onLoadStart = function (t) { trace("start " + t); };
mcl.onLoadInit = function (t) { trace("init " + t); };
mcl.loadClip("child.swf", mc);
mcl.unloadClip(mc);`,
    { fetch: files({ "child.swf": movie(`trace("child ran");`) }) },
  );

  await played.deliver();
  played.player.tick();
  played.player.tick();
  assert.deepEqual(take(played), ["start _level0.mc"]);
});

test("loadClip into what is no clip, a text field, loads nothing and returns false", async () => {
  const asked: string[] = [];
  const played = await play(
    `var mcl = new MovieClipLoader();
var tf = createTextField("tf", 1, 0, 0, 10, 10);
trace(mcl.loadClip("child.swf", tf));`,
    {
      fetch: async (request) => {
        asked.push(request.url);
        return { bytes: null, status: 404, headers: [] };
      },
    },
  );

  assert.deepEqual(take(played), ["false"]);
  assert.deepEqual(asked, []);
});

test("a second load into a clip replaces the first, which is never told of nor read", async () => {
  const played = await play(
    `var mcl = new MovieClipLoader();
var mc = createEmptyMovieClip("mc", 1);
mcl.onLoadStart = function (t) { trace("start " + t); };
mcl.onLoadComplete = function (t) { trace("complete " + t); };
mcl.onLoadInit = function (t) { trace("init " + t); };
mcl.loadClip("first.swf", mc);
mcl.loadClip("second.swf", mc);`,
    {
      fetch: files({
        "first.swf": movie(`trace("first ran");`),
        "second.swf": movie(`trace("second ran");`),
      }),
    },
  );

  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), [
    "start _level0.mc",
    "complete _level0.mc",
    "second ran",
    "init _level0.mc",
  ]);
});

test("a listener that removes the clip in onLoadProgress hears no onLoadComplete nor onLoadInit", async () => {
  const played = await play(
    `var mcl = new MovieClipLoader();
var mc = createEmptyMovieClip("mc", 1);
mcl.onLoadStart = function (t) { trace("start"); };
mcl.onLoadProgress = function (t) { trace("progress"); t.removeMovieClip(); };
mcl.onLoadComplete = function (t) { trace("complete"); };
mcl.onLoadInit = function (t) { trace("init"); };
mcl.loadClip("child.swf", mc);`,
    { fetch: files({ "child.swf": movie(`trace("child ran");`) }) },
  );

  await played.deliver();
  played.player.tick();
  played.player.tick();
  assert.deepEqual(take(played), ["start", "progress"]);
});
