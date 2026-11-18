// loadMovie and unloadMovie in node: a SWF loaded into a clip or a level
// plays its own actions with its own `_url` and `_root`, the clip keeps its
// place and name, and what it showed unloads; an image shows as a bitmap;
// an ActionScript 3 SWF plays with none of its code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type FetchRequest, platformCapabilities } from "../../../../packages/player/dist/hosts.js";
import { resolve } from "../../../../packages/player/dist/scripting/loads.js";
import { files, movie, play, take } from "./network.ts";

test("the main SWF's URL query and flashvars are its root's variables before its first frame, the flashvars' names winning", async () => {
  const played = await play(
    `trace(_root.q + "|" + _root.shared + "|" + lang + "|" + typeof _root.empty + "|" + typeof _root.n);`,
    {
      url: "http://example.test/t/test.swf?q=a+b&shared=query&empty#frag",
      parameters: { shared: "flashvars", lang: "en", n: "3" },
    },
  );

  assert.deepEqual(take(played), ["a b|flashvars|en|string|string"]);
});

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

test("a loaded SWF's class keeps working after its clip is removed, its methods' calls returning", async () => {
  const played = await play(
    `var a = createEmptyMovieClip("a", 1);
a.loadMovie("lib.swf");
var frames = 0;
this.onEnterFrame = function () {
  frames++;
  if (frames == 2) {
    a.removeMovieClip();
  }
  if (frames == 4) {
    var f = new _global.Foo(7);
    trace(f.twice() + " " + f.x);
    delete this.onEnterFrame;
  }
};`,
    {
      url: "http://example.test/t/test.swf",
      fetch: files({
        "lib.swf": movie(
          `if (!_global.Foo) {
  _global.Foo = function (x) { this.x = this.half(x * 2); };
  _global.Foo.prototype.half = function (n) { return n / 2; };
  _global.Foo.prototype.twice = function () { return this.half(this.x * 4); };
}`,
          9,
        ),
      }),
    },
    9,
  );

  for (let i = 0; i < 6; i++) {
    await played.deliver();
    played.player.tick();
  }

  assert.deepEqual(take(played), ["14 7"]);
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

test("a SWF loaded into a level has the player's version, level 0's replacement afresh, as Flash's plug-in defines it", async () => {
  const played = await play(
    `$version = "changed";
var mcl = new MovieClipLoader();
mcl.loadClip("level.swf", 1);
createEmptyMovieClip("clip", 1).loadMovie("clip.swf");
var frames = 0;
this.onEnterFrame = function () {
  frames++;
  if (frames == 2) { _level0.loadMovie("replacement.swf"); }
};`,
    {
      fetch: files({
        "level.swf": movie(`trace("level " + $version + " " + getVersion());`),
        "clip.swf": movie(`trace("clip " + $version + " " + getVersion());`),
        "replacement.swf": movie(`trace("replacement " + $version + " " + getVersion());`),
      }),
    },
  );

  for (let i = 0; i < 4; i++) {
    await played.deliver();
    played.player.tick();
  }

  const version = platformCapabilities().version;
  assert.deepEqual(take(played).sort(), [
    "clip undefined changed",
    `level ${version} ${version}`,
    `replacement ${version} ${version}`,
  ]);
});

test("relative loads resolve against base, the children's too, and what loads has as its _url the URL it came from", async () => {
  const asked: string[] = [];
  const child = (name: string) =>
    movie(`trace("${name} " + _url);
createEmptyMovieClip("g", 1).loadMovie("grandchild.swf");
createEmptyMovieClip("s", 2).loadMovie(_url.substring(0, _url.lastIndexOf("/") + 1) + "sibling.swf");`);
  const bytes: Record<string, Uint8Array> = {
    "/page/child.swf": child("child"),
    "/page/sub/child.swf": child("sub child"),
    "/page/grandchild.swf": movie(`trace("grandchild " + _url);`),
    "/page/sibling.swf": movie(`trace("sibling " + _url);`),
    "/page/sub/sibling.swf": movie(`trace("sub sibling " + _url);`),
  };
  const played = await play(
    `createEmptyMovieClip("a", 1).loadMovie("child.swf?q=1");
createEmptyMovieClip("b", 2).loadMovie("sub/child.swf");`,
    {
      url: "http://example.test/swf/main.swf",
      base: "http://example.test/page/index.html",
      fetch: async (request) => {
        const url = new URL(request.url);
        asked.push(url.pathname + url.search);
        const found = bytes[url.pathname];
        return found
          ? { bytes: found, status: 0, headers: [] }
          : { bytes: null, status: 404, headers: [] };
      },
    },
  );

  for (let i = 0; i < 4; i++) {
    await played.deliver();
    played.player.tick();
  }

  assert.deepEqual(take(played).sort(), [
    "child http://example.test/page/child.swf?q=1",
    "grandchild http://example.test/page/grandchild.swf",
    "grandchild http://example.test/page/grandchild.swf",
    "sibling http://example.test/page/sibling.swf",
    "sub child http://example.test/page/sub/child.swf",
    "sub sibling http://example.test/page/sub/sibling.swf",
  ]);
  assert.deepEqual(asked.sort(), [
    "/page/child.swf?q=1",
    "/page/grandchild.swf",
    "/page/grandchild.swf",
    "/page/sibling.swf",
    "/page/sub/child.swf",
    "/page/sub/sibling.swf",
  ]);
});

test("a base's query and fragment are no directory: a relative URL replaces its path's last segment", () => {
  assert.equal(
    resolve("https://site.test/play.php?file=/games/a.swf", "child.swf"),
    "https://site.test/child.swf",
  );
  assert.equal(
    resolve("https://site.test/app/#/game/5", "child.swf"),
    "https://site.test/app/child.swf",
  );
  assert.equal(
    resolve("https://site.test/app/?a=1#b/c", "/root.swf"),
    "https://site.test/root.swf",
  );
  assert.equal(resolve("file:///test.swf", "sub/child.swf"), "file:///sub/child.swf");
});

test("getURL opens what the movie's base names, as its loads load it", async () => {
  const g = globalThis as { open?: unknown; document?: unknown };
  const opened: string[] = [];
  g.open = (url: string) => opened.push(url);
  g.document = {};
  try {
    const played = await play(`this.getURL("next.html?a=1", "_blank");`, {
      url: "http://example.test/swf/main.swf",
      base: "http://example.test/page/index.php?id=2#top",
    });
    played.player.tick();
    assert.deepEqual(opened, ["http://example.test/page/next.html?a=1"]);
  } finally {
    delete g.open;
    delete g.document;
  }
});
