import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { DecodedImage } from "../../../../packages/player/dist/bitmap/images.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../player/libraries.ts";

let skip: string | false = false;
try {
  containerEngine();
} catch (error) {
  skip = (error as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const signatures = {
  png: Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
  jpeg: Uint8Array.of(0xff, 0xd8, 0xff),
  gif: Uint8Array.of(0x47, 0x49, 0x46, 0x38),
};
const decoded: DecodedImage = {
  width: 2,
  height: 1,
  rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
};

function loaderOf(s: Scripting, listener?: (type: string, event: avm2.AsObject) => void) {
  const rt = s.rt;
  const get = (o: avm2.AsObject, name: string) => rt.getProperty(o, rt.publicName(name));
  const loader = rt.construct(rt.classNamed("flash.display::Loader"));
  const info = get(loader, "contentLoaderInfo");
  const events: string[] = [];
  info.$listeners = new Map(
    ["open", "progress", "init", "httpStatus", "complete", "ioError", "unload"].map((type) => [
      type,
      [
        {
          fn: {
            $f: (e: avm2.AsObject) => {
              events.push(type);
              listener?.(type, e);
            },
          },
          capture: false,
          priority: 0,
        },
      ],
    ]),
  );
  return { loader, info, get, events };
}

async function deliver(s: Scripting): Promise<void> {
  await s.settled();
  const ends = s.loads.completeLoads();
  for (let i = 0; i < ends.length; i++) {
    ends[i]();
  }
}

test("image URL loads sniff bytes and publish Bitmap metadata after progress", {
  skip,
}, async (t) => {
  let bytes = signatures.png;
  const formats: string[] = [];
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: () => {},
    onUncaught: (error) => errors.push(error),
    url: "https://example.test/main.swf",
    fetch: async () => ({
      bytes,
      status: 200,
      headers: [["Content-Type", "text/plain"]],
      url: "https://example.test/redirected.bin",
    }),
    decodeImage: async (_data, format) => {
      formats.push(format);
      return decoded;
    },
  });
  t.after(() => s.destroy());
  await s.loadLibraries(libraryAbcs());

  for (const format of ["png", "jpeg", "gif"] as const) {
    bytes = signatures[format];
    const { loader, info, get, events } = loaderOf(s, (type) => {
      if (type === "open" || type === "progress") {
        assert.equal(get(info, "contentType"), null);
        assert.equal(get(loader, "content"), null);
      }
    });
    s.loads.requestLoadUrl(loader, "wrong.swf");
    assert.equal(get(info, "applicationDomain"), null);
    await deliver(s);
    assert.deepEqual(events, ["open", "progress", "progress", "init", "httpStatus", "complete"]);
    const bitmap = get(loader, "content");
    assert.equal(s.rt.traitsOf(bitmap).name, "flash.display::Bitmap");
    assert.equal(get(bitmap, "root"), bitmap);
    assert.equal(get(bitmap, "loaderInfo"), info);
    assert.equal(get(bitmap, "parent"), loader);
    assert.equal(get(info, "contentType"), `image/${format}`);
    assert.equal(get(info, "width"), 2);
    assert.equal(get(info, "height"), 1);
    assert.equal(get(info, "url"), "https://example.test/redirected.bin");
    assert.ok(get(info, "applicationDomain"));
    assert.equal(get(get(bitmap, "bitmapData"), "transparent"), format !== "jpeg");
    for (const name of ["swfVersion", "actionScriptVersion", "frameRate"]) {
      assert.throws(
        () => get(info, name),
        (error: unknown) => get(error as avm2.AsObject, "errorID") === 2098,
      );
    }

    s.loads.unload(loader);
    assert.equal(get(info, "applicationDomain"), null);
    assert.equal(get(info, "contentType"), null);
    assert.equal(get(bitmap, "parent"), null);
    assert.equal(get(get(bitmap, "bitmapData"), "width"), 2);
  }

  assert.deepEqual(formats, ["png", "jpeg", "gif"]);
  assert.deepEqual(errors, []);
});

test("closing an image during decode cannot replace newer content or overtake queued loads", {
  skip,
}, async (t) => {
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let finishDecode: (image: DecodedImage) => void = () => {};
  const decoding = new Promise<DecodedImage>((resolve) => {
    finishDecode = resolve;
  });
  const formats: string[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: () => {},
    decodeImage: async (_data, format) => {
      formats.push(format);
      if (format === "png") {
        signalStarted();
        return decoding;
      }

      return decoded;
    },
  });
  t.after(() => s.destroy());
  await s.loadLibraries(libraryAbcs());
  const first = loaderOf(s);
  const second = loaderOf(s);
  s.loads.requestLoad(first.loader, signatures.png);
  await started;
  s.loads.requestLoad(second.loader, signatures.gif);
  assert.deepEqual(s.loads.completeLoads(), []);
  assert.deepEqual(formats, ["png"]);
  s.loads.unload(first.loader);
  s.loads.requestLoad(first.loader, signatures.jpeg);
  first.events.length = 0;
  second.events.length = 0;
  finishDecode(decoded);
  await deliver(s);
  assert.deepEqual(formats, ["png", "gif", "jpeg"]);
  assert.deepEqual(first.events, ["init", "complete"]);
  assert.deepEqual(second.events, ["init", "complete"]);
  assert.equal(first.get(first.info, "contentType"), "image/jpeg");
  assert.equal(second.get(second.info, "contentType"), "image/gif");
  assert.equal(first.get(first.loader, "numChildren"), 1);
});

test("image loads can be cancelled from progress or INIT without a stale COMPLETE", {
  skip,
}, async (t) => {
  const errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: () => {},
    onUncaught: (error) => errors.push(error),
    fetch: async () => ({ bytes: signatures.png, status: 200, headers: [] }),
    decodeImage: async () => decoded,
  });
  t.after(() => s.destroy());
  await s.loadLibraries(libraryAbcs());
  for (const url of [false, true]) {
    for (const cancelAt of ["progress", "init"]) {
      const { loader, info, get, events } = loaderOf(s, (type) => {
        if (type === cancelAt) {
          s.loads.unload(loader);
        }
      });
      if (url) {
        s.loads.requestLoadUrl(loader, "image.png");
      } else {
        s.loads.requestLoad(loader, signatures.png);
      }

      await deliver(s);
      assert.equal(events.includes("complete"), false);
      assert.equal(events.includes("init"), cancelAt === "init");
      assert.equal(get(loader, "content"), null);
      assert.equal(get(loader, "numChildren"), 0);
      assert.equal(get(info, "contentType"), null);
      assert.equal(get(info, "bytesLoaded"), 0);
    }
  }

  assert.deepEqual(errors, []);
});

test("failed image decoding delivers IOError 2124 and leaves the queue usable", {
  skip,
}, async (t) => {
  let attempt = 0;
  const errors: number[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    print: () => {},
    decodeImage: async () => {
      switch (attempt++) {
        case 0:
          return null;
        case 1:
          throw new Error("decoder failed");
        case 2:
          return { width: 0, height: 0, rgba: new Uint8Array(0) };
        default:
          return decoded;
      }
    },
  });
  t.after(() => s.destroy());
  await s.loadLibraries(libraryAbcs());
  const { loader, info, get, events } = loaderOf(s, (type, event) => {
    if (type === "ioError") {
      assert.match(get(event, "text"), /^Error #2124:/);
      errors.push(2124);
    }
  });
  for (let i = 0; i < 4; i++) {
    s.loads.requestLoad(loader, signatures.png);
    await deliver(s);
    assert.deepEqual(events.splice(0), [
      "progress",
      "progress",
      ...(i < 3 ? ["ioError"] : ["init", "complete"]),
    ]);
    assert.equal(get(info, "contentType"), i < 3 ? null : "image/png");
  }

  assert.equal(errors.length, 3);
});
