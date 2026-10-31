import assert from "node:assert/strict";
import { test } from "node:test";
import { Context3DError } from "../../../../../packages/context3d/dist/index.js";
import { translateErrors } from "../../../../../packages/player/dist/playerglobal/context3d/errors.js";
import type { Scripting } from "../../../../../packages/player/dist/scripting.js";
import type { avm2 } from "../../../../../packages/runtime/dist/index.js";

test("a refused Context3D call is Flash's bare error to the SWF, and named once in the console", () => {
  const thrown: [string, number][] = [];
  const s = {
    rt: {
      error: (kind: string, id: number) => {
        thrown.push([kind, id]);
        return new Error(`${kind} #${id}`);
      },
    },
  } as unknown as Scripting;
  const natives = {
    "flash.display3D::Context3D#configureBackBuffer": () => () => {
      throw new Context3DError("unsupported", "Context3D does not support best resolution yet");
    },
  } as unknown as avm2.Natives;
  translateErrors(natives, s);
  const call = natives["flash.display3D::Context3D#configureBackBuffer"](
    {} as avm2.Runtime,
  ) as () => void;

  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => warned.push(line);
  try {
    for (let i = 0; i < 3; i++) {
      assert.throws(() => call.call(null), /Error #3708/);
    }
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(thrown, [
    ["Error", 3708],
    ["Error", 3708],
    ["Error", 3708],
  ]);
  assert.deepEqual(warned, [
    "swf2es: flash.display3D::Context3D#configureBackBuffer: Context3D does not support best resolution yet (Error #3708)",
  ]);
});
