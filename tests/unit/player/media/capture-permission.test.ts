import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import type { CaptureHost, CapturePermission } from "../../../../packages/player/dist/hosts.js";
import {
  airLibrary,
  builtinLibrary,
  playerglobalLibrary,
  Scripting,
} from "../../../../packages/player/dist/index.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
test("AIR capture permission follows the host and answers denial after revocation", async () => {
  let permission: CapturePermission = "unknown";
  let answer: (value: CapturePermission) => void = () => {};
  const host: CaptureHost = {
    cameras: [],
    permissionStatus: () => permission,
    requestPermission: () =>
      new Promise((resolve) => {
        answer = (value) => {
          permission = value;
          resolve(value);
        };
      }),
    openCamera() {
      throw new Error("permission should not attach capture");
    },
  };
  const s = new Scripting(await createCodegen(wasm), { air: true, capture: host, audio: null });
  await s.loadLibraries([builtinLibrary, playerglobalLibrary, airLibrary]);
  const rt = s.rt;
  const get = (o: avm2.AsObject, key: string) => rt.getProperty(o, rt.publicName(key));
  const call = (o: avm2.AsObject, key: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(key), ...args);
  try {
    for (const name of ["Camera", "Microphone"]) {
      permission = "unknown";
      const klass = rt.classNamed(`flash.media::${name}`);
      const object = rt.construct(klass);
      const received: avm2.Value[] = [];
      call(object, "addEventListener", "permissionStatus", {
        $f: (event: avm2.AsObject) => received.push(get(event, "status")),
      });
      assert.equal(rt.in("permissionStatus", klass), true);
      assert.equal(rt.in("requestPermission", object), true);
      assert.equal(get(klass, "permissionStatus"), "unknown");
      call(object, "requestPermission");
      answer("granted");
      await Promise.resolve();
      assert.deepEqual(received, []);
      s.loads.completeLoads();
      assert.deepEqual(received, ["granted"]);
      assert.equal(get(klass, "permissionStatus"), "granted");
      call(object, "requestPermission");
      answer("denied");
      await Promise.resolve();
      s.loads.completeLoads();
      assert.deepEqual(received, ["granted", "denied"]);
    }
    const camera = rt.construct(rt.classNamed("flash.media::Camera"));
    const late: avm2.Value[] = [];
    call(camera, "addEventListener", "permissionStatus", {
      $f: (event: avm2.AsObject) => late.push(get(event, "status")),
    });
    call(camera, "requestPermission");
    s.captureLifetime.abort();
    answer("granted");
    await Promise.resolve();
    s.loads.completeLoads();
    assert.deepEqual(late, ["denied"]);
    call(camera, "requestPermission");
    s.loads.completeLoads();
    assert.deepEqual(late, ["denied", "denied"]);
    call(camera, "requestPermission");
    s.destroy();
    s.loads.completeLoads();
    assert.deepEqual(late, ["denied", "denied"]);
  } finally {
    s.destroy();
  }
});

test("capture permission members are hidden outside AIR", async () => {
  const s = new Scripting(await createCodegen(wasm));
  await s.loadLibraries([builtinLibrary, playerglobalLibrary]);
  try {
    for (const name of ["Camera", "Microphone"]) {
      const klass = s.rt.classNamed(`flash.media::${name}`);
      assert.equal(s.rt.in("permissionStatus", klass), false);
      const object = s.rt.construct(klass);
      assert.equal(s.rt.in("requestPermission", object), false);
    }
  } finally {
    s.destroy();
  }
});
