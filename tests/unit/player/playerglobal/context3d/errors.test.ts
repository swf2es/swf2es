import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Context3DError,
  context3DErrorKind,
  isContext3DError,
} from "../../../../../packages/context3d/dist/index.js";
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

test("an error of another copy of the backend's package is Flash's error too, by its brand", () => {
  // As the backend's own copy brands its errors (packages/context3d/src/errors.ts): a page's
  // bundle has classes of its own, which instanceof against the player's would not know.
  class ForeignContext3DError extends Error {
    readonly reason = "limit";
  }
  Object.defineProperty(ForeignContext3DError.prototype, Symbol.for("swf2es.context3d.error"), {
    value: "context3d",
  });
  assert.equal(isContext3DError(new ForeignContext3DError("too many")), true);
  assert.equal(context3DErrorKind(new Context3DError("limit", "too many")), "context3d");
  assert.equal(context3DErrorKind(new Error("plain")), null);

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
    "flash.display3D::Context3D#createVertexBuffer": () => () => {
      throw new ForeignContext3DError("Too many vertex buffers");
    },
  } as unknown as avm2.Natives;
  translateErrors(natives, s);
  const call = natives["flash.display3D::Context3D#createVertexBuffer"](
    {} as avm2.Runtime,
  ) as () => void;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.throws(() => call.call(null), /Error #3691/);
  } finally {
    console.warn = warn;
  }

  assert.deepEqual(thrown, [["Error", 3691]]);
});
