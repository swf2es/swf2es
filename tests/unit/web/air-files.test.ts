// The files an AIR application in a page writes (packages/web/src/air-files.ts),
// held in memory: written into, cut and grown, directories made as files
// go into them, removed and moved with what is in them, and what is in the
// way of each. That IndexedDB keeps them for the next play, tests/web
// checks in Chrome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AirFiles } from "../../../packages/web/dist/air-files.js";

test("an application's files: written, made, removed and moved", () => {
  const files = new AirFiles("test", ["app-storage", "user/Documents"], null);
  assert.deepEqual(files.list(""), ["app-storage", "user"]);
  assert.equal(files.stat("user")?.directory, true);

  assert.ok(files.write("app-storage/a/b.bin", Uint8Array.of(1, 2, 3), 0, 3));
  assert.deepEqual(files.list("app-storage"), ["a"]);
  assert.deepEqual(
    [files.stat("app-storage/a/b.bin")?.size, files.stat("app-storage/a")?.directory],
    [3, true],
  );
  // Into the middle, past the end with zeros between, then cut.
  assert.ok(files.write("app-storage/a/b.bin", Uint8Array.of(9), 1, 3));
  assert.ok(files.write("app-storage/a/b.bin", Uint8Array.of(8), 5, 6));
  assert.deepEqual([...(files.read("app-storage/a/b.bin") ?? [])], [1, 9, 3, 0, 0, 8]);
  const before = files.read("app-storage/a/b.bin");
  assert.ok(files.write("app-storage/a/b.bin", new Uint8Array(0), 2, 2));
  assert.deepEqual([...(files.read("app-storage/a/b.bin") ?? [])], [1, 9]);
  // What was read before stays as it was.
  assert.deepEqual([...(before ?? [])], [1, 9, 3, 0, 0, 8]);

  // A file in the way of a directory, a directory in the way of a file.
  assert.equal(files.write("app-storage/a/b.bin/c", Uint8Array.of(1), 0, 1), false);
  assert.equal(files.createDirectory("app-storage/a/b.bin/c"), false);
  assert.equal(files.write("app-storage/a", Uint8Array.of(1), 0, 1), false);
  assert.equal(files.read("app-storage/a"), null);
  assert.equal(files.list("app-storage/a/b.bin"), null);

  assert.ok(files.createDirectory("user/Documents/x/y"));
  assert.deepEqual(files.list("user/Documents/x"), ["y"]);
  assert.ok(files.move("app-storage/a", "user/Documents/x/y/a"));
  assert.equal(files.stat("app-storage/a"), null);
  assert.deepEqual([...(files.read("user/Documents/x/y/a/b.bin") ?? [])], [1, 9]);
  // Not onto something there, nor into itself.
  assert.ok(files.write("app-storage/c.bin", Uint8Array.of(1), 0, 1));
  assert.equal(files.move("app-storage/c.bin", "user/Documents/x/y/a/b.bin"), false);
  assert.equal(files.move("user/Documents/x", "user/Documents/x/z"), false);
  assert.equal(files.move("nope", "app-storage/d"), false);

  assert.ok(files.remove("user/Documents/x"));
  assert.equal(files.stat("user/Documents/x/y/a/b.bin"), null);
  assert.deepEqual(files.list("user/Documents"), []);
  assert.equal(files.remove("user/Documents/x"), false);
  assert.equal(files.remove(""), false);
});
