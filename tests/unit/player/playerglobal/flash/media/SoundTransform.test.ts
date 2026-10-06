import assert from "node:assert/strict";
import { test } from "node:test";
import { soundTransformNatives } from "../../../../../../packages/player/dist/playerglobal/flash/media/SoundTransform.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";

test("SoundTransform keeps each channel and volume on its own AVM object", () => {
  const scripting = { rt: { toNumber: Number } } as unknown as Scripting;
  const natives = soundTransformNatives(scripting);
  const prefix = "flash.media::SoundTransform#";
  const get = (o: object, name: string): number =>
    natives[`${prefix}get:${name}`](scripting.rt).call(o);
  const set = (o: object, name: string, value: unknown): void => {
    natives[`${prefix}set:${name}`](scripting.rt).call(o, value);
  };
  const first = {};
  const second = {};

  assert.deepEqual(
    ["volume", "leftToLeft", "leftToRight", "rightToRight", "rightToLeft"].map((name) =>
      get(first, name),
    ),
    [1, 1, 0, 1, 0],
  );
  set(first, "volume", "0.25");
  set(first, "leftToLeft", -123);
  set(first, "rightToLeft", Number.NaN);

  assert.equal(get(first, "volume"), 0.25);
  assert.equal(get(first, "leftToLeft"), -123);
  assert.ok(Number.isNaN(get(first, "rightToLeft")));
  assert.equal(get(second, "volume"), 1);
  assert.equal(get(second, "leftToLeft"), 1);
});
