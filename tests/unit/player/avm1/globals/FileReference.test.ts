import assert from "node:assert/strict";
import { test } from "node:test";
import { play, take } from "../network.ts";

test("AS2 file references broadcast selection and upload completion with metadata", async () => {
  const played = await play(
    `
var ref = new flash.net.FileReference();
var listener = {};
listener.onSelect = function(file) { trace("selected " + file.name + " " + file.size + " " + file.type + " " + file.creator); file.upload("https://example.test/upload"); };
listener.onComplete = function(file) { trace("complete " + (file == ref)); };
listener.onUploadCompleteData = function(file, data) { trace(data); };
ref.addListener(listener);
trace(ref.name);
trace(ref.browse());`,
    {
      fileHost: {
        browse: async () => [
          { name: "a.txt", size: 2, modificationDate: 1, read: async () => Uint8Array.of(65, 66) },
        ],
        save: async () => null,
      },
      fetch: async () => ({
        bytes: new TextEncoder().encode("uploaded"),
        status: 200,
        headers: [],
      }),
    },
  );
  assert.deepEqual(take(played), ["undefined", "true"]);
  await played.deliver();
  assert.deepEqual(take(played), ["selected a.txt 2 .txt undefined"]);
  await played.deliver();
  assert.deepEqual(take(played), ["complete true", "uploaded"]);
});

test("AS2 list builds independently uploadable references and cancel emits no callback", async () => {
  const played = await play(
    `
var list = new flash.net.FileReferenceList();
var listener = {};
listener.onSelect = function(value) { trace(value.fileList.length + " " + value.fileList[1].name); };
list.addListener(listener);
list.browse();`,
    {
      fileHost: {
        browse: async () =>
          ["a.txt", "b.txt"].map((name) => ({
            name,
            size: 0,
            modificationDate: 0,
            read: async () => new Uint8Array(),
          })),
        save: async () => null,
      },
    },
  );
  await played.deliver();
  assert.deepEqual(take(played), ["2 b.txt"]);
  played.player.destroy();
});
