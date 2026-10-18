// loadMovie and unloadMovie in node: a SWF loaded into a clip or a level
// plays its own actions with its own `_url` and `_root`, the clip keeps its
// place and name, and what it showed unloads; an image shows as a bitmap;
// an ActionScript 3 SWF plays with none of its code.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchRequest } from "../../../../packages/player/dist/hosts.js";
import { files, movie, play, take } from "./network.ts";

test("loadMovie fills the clip between frames: it keeps its name and depth, its variables go, the query's come, and the SWF's actions run with its own _url", async () => {
  const asked: FetchRequest[] = [];
  const played = await play(
    `var mc = createEmptyMovieClip("holder", 5);
mc.v = 1;
mc.loadMovie("child.swf?q=a+b");
trace(mc.v + " " + mc._url);`,
    {
      url: "http://example.test/t/test.swf",
      fetch: files(
        {
          "child.swf": movie(
            `trace("child " + this + " " + _url + " " + _root + " " + this.getDepth() + " " + this.v + " " + this.q);`,
          ),
        },
        asked,
      ),
    },
  );

  assert.deepEqual(take(played), ["1 http://example.test/t/test.swf"]);
  assert.deepEqual(
    asked.map((r) => [r.url, r.purpose]),
    [["http://example.test/t/child.swf?q=a+b", "content"]],
  );
  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), [
    "child _level0.holder http://example.test/t/child.swf?q=a+b _level0 5 undefined a b",
  ]);
});

test("a load into a level makes it, its _root and _target its own, and unloading it unloads what it shows a frame on", async () => {
  const played = await play(
    `trace(typeof _level1);
var mcl = new MovieClipLoader();
trace(mcl.loadClip("child.swf", 1.9));
trace(typeof _level1);
var frames = 0;
this.onEnterFrame = function () {
  frames++;
  if (frames == 1) { mcl.unloadClip(1); trace("unloading " + _level1); }
  if (frames == 3) { trace(_level1 + " " + _level1._framesloaded + " " + _level1._url); }
};`,
    {
      fetch: files({
        "child.swf":
          movie(`trace(this + " " + _root + " " + _target + " " + _parent + " " + _level0.getDepth() + " " + this.getDepth());
this.onUnload = function () { trace("unload " + this); };`),
      }),
    },
  );

  assert.deepEqual(take(played), ["undefined", "true", "movieclip"]);
  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), [
    "_level1 _level1 / undefined -16384 -16383",
    "unloading _level1",
  ]);
  await played.deliver();
  assert.deepEqual(take(played), ["unload _level1"]);
  played.player.tick();
  played.player.tick();
  assert.deepEqual(take(played), ["_level1 0 "]);
});

test("a failed load, bytes that are no SWF, and an image leave the clip as Flash's states have them", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const played = await play(
    `createEmptyMovieClip("a", 1).loadMovie("missing.swf");
createEmptyMovieClip("b", 2).loadMovie("text.txt");
createEmptyMovieClip("c", 3).loadMovie("image.png");
this.onEnterFrame = function () {
  var names = ["a", "b", "c"];
  for (var n = 0; n < 3; n++) {
    var c = this[names[n]];
    trace(c._name + " " + c._framesloaded + " " + c._totalframes + " " + c.getBytesLoaded() + " " +
      c.getBytesTotal() + " " + c.getSWFVersion() + " " + c._width + "x" + c._height);
  }
  delete this.onEnterFrame;
};`,
    {
      fetch: files({ "text.txt": new TextEncoder().encode("not a movie"), "image.png": png }),
      decodeImage: async () => ({ width: 2, height: 3, rgba: new Uint8Array(24).fill(255) }),
    },
  );

  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), ["a -1 0 0 -1 -1 0x0", "b -1 0 0 -1 -1 0x0", "c 1 1 8 8 -1 2x3"]);
});

test("a clip's _lockroot makes it the _root of the SWF loaded into it, and an ActionScript 3 SWF plays none of its code", async () => {
  const played = await play(
    `var a = createEmptyMovieClip("a", 1);
a._lockroot = "yes";
trace(a._lockroot);
a.loadMovie("child.swf");
createEmptyMovieClip("b", 2).loadMovie("as3.swf");`,
    {
      fetch: files({
        "child.swf": movie(`trace(_root + " " + this._lockroot + " " + _level0);`),
        "as3.swf": movie(`trace("as3 code ran");`, 10, true),
      }),
    },
  );

  assert.deepEqual(take(played), ["true"]);
  await played.deliver();
  played.player.tick();
  assert.deepEqual(take(played), ["_level0.a true _level0"]);
});

test("a load into one clip arrives without waiting for one into another whose answer has not come", async () => {
  const child = movie(`trace("fast ran");`);
  const played = await play(
    `createEmptyMovieClip("a", 1).loadMovie("slow.swf");
createEmptyMovieClip("b", 2).loadMovie("fast.swf");`,
    {
      // The slow file never answers.
      fetch: (request) =>
        request.url.endsWith("fast.swf")
          ? Promise.resolve({ bytes: child, status: 0, headers: [] })
          : new Promise(() => {}),
    },
  );

  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  played.avm1.network();
  played.player.tick();
  assert.deepEqual(take(played), ["fast ran"]);
});
