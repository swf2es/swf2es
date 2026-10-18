// MovieClipLoader in node: what loadClip, getProgress and unloadClip take
// and return, as the corpus's mcl_* tests have Flash's, and the events its
// listeners hear, in Flash's order.
import assert from "node:assert/strict";
import { test } from "node:test";
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
