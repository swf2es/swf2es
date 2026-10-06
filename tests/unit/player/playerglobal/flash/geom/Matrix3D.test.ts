import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../../../player/libraries.ts";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test("Matrix3D stores float32 values, returns copies and transfers data in either order", async () => {
  const s = new Scripting(await createCodegen(wasm));
  await s.loadLibraries(libraryAbcs());
  const rt = s.rt;
  const vectorClass = rt.resolve(rt.vector("Number"));
  const matrixClass = rt.classNamed("flash.geom::Matrix3D");
  const vector = (values: number[], fixed = false): avm2.AsObject => {
    const o = vectorClass.$it.instance();
    o.$a = values;
    o.$fixed = fixed;
    return o;
  };
  const get = (o: avm2.AsObject) =>
    (rt.getProperty(o, rt.publicName("rawData")) as avm2.AsObject).$a as number[];
  const call = (o: avm2.AsObject, method: string, ...args: avm2.Value[]) =>
    rt.callProperty(o, rt.publicName(method), ...args);

  const short = rt.construct(matrixClass, vector([2])) as avm2.AsObject;
  assert.deepEqual(get(short), IDENTITY);

  const source = vector([1.0000001, ...Array.from({ length: 15 }, (_, i) => i + 2)]);
  const matrix = rt.construct(matrixClass, source) as avm2.AsObject;
  assert.equal(get(matrix)[0], Math.fround(1.0000001));
  source.$a[0] = 99;
  const result = get(matrix);
  result[0] = 99;
  assert.equal(get(matrix)[0], Math.fround(1.0000001));

  rt.setProperty(matrix, rt.publicName("rawData"), vector([7]));
  assert.equal(get(matrix)[0], Math.fround(1.0000001));
  const clone = call(matrix, "clone") as avm2.AsObject;
  assert.deepEqual(get(clone), get(matrix));

  const transposed = vector(Array.from({ length: 16 }, (_, i) => i + 1));
  call(matrix, "copyRawDataFrom", transposed, 0, true);
  assert.deepEqual(get(matrix), [1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]);
  const dest = vector([-1]);
  call(matrix, "copyRawDataTo", dest, 1, true);
  assert.deepEqual(dest.$a, [-1, ...transposed.$a]);

  const fixed = vector([-1], true);
  assert.throws(
    () => call(matrix, "copyRawDataTo", fixed),
    (e) => rt.toString(e as avm2.Value).includes("#1126"),
  );
  assert.deepEqual(fixed.$a, [-1]);

  // A negative index is a uint of 2^32 - 1: refused, as adl refuses any from 2^28, not padded out to.
  for (const index of [-1, 0x10000000]) {
    const growable = vector([-1]);
    assert.throws(
      () => call(matrix, "copyRawDataTo", growable, index),
      (e) => rt.toString(e as avm2.Value).includes("#2004"),
    );
    assert.deepEqual(growable.$a, [-1]);
  }

  const vector3D = rt.construct(rt.classNamed("flash.geom::Vector3D")) as avm2.AsObject;
  call(matrix, "copyRowTo", 2, vector3D);
  assert.deepEqual(
    ["x", "y", "z", "w"].map((name) => rt.getProperty(vector3D, rt.publicName(name))),
    [9, 10, 11, 12],
  );
  call(matrix, "copyColumnFrom", 3, vector3D);
  assert.deepEqual(get(matrix).slice(12), [9, 10, 11, 12]);
  assert.throws(
    () => call(matrix, "copyRowFrom", 4, vector3D),
    (e) => rt.toString(e as avm2.Value).includes("#2004"),
  );
  assert.throws(
    () => call(matrix, "copyRowFrom", 4, null),
    (e) => rt.toString(e as avm2.Value).includes("#2007"),
  );
});
