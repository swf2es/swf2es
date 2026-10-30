// flash.display.ShaderJob: a kernel run over a BitmapData, a ByteArray or
// a Vector.<Number> (bitmap/pixel-bender.ts), as adl runs one. A job runs
// once; start() checks everything and runs the kernel then, its
// parameters and inputs read as they stand, and an asynchronous job's
// result reaches the target, with ShaderEvent.COMPLETE, after the frame's
// EXIT_FRAME (Scripting.afterExitFrame).
// adl runs those jobs on a thread of its own and drops some, one started
// while another runs among them; here each job completes.
import { avm2 } from "@swf2es/runtime";
import type { BitmapStore } from "../../../bitmap/bitmap.js";
import { outputByte, type ShaderImage } from "../../../bitmap/pixel-bender.js";
import { dispatchEvent } from "../../../scripting/events.js";
import type { Scripting } from "../../../scripting.js";
import { programOf } from "./ShaderData.js";
import { isShaderImage, shaderClasses } from "./ShaderInput.js";
import { inputImage, kernelValues } from "./shaders.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

const IDLE = 0;
const RUNNING = 1;
const DONE = 2;

export function shaderJobNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  const classes = () => shaderClasses(s);
  const isBitmapData = (v: Value) => s.rt.isInstance(v, classes().bitmapData);
  const isVector = (v: Value) => s.rt.isInstance(v, classes().vector);
  const refuse = (id: number, ...args: Value[]): never => {
    throw s.rt.error("ArgumentError", id, ...args);
  };

  /** Write the output, `channels` floats a pixel, to the target. */
  const deliver = (target: AsObject, out: Float32Array, channels: number): void => {
    if (isBitmapData(target)) {
      const store: BitmapStore = target.$store;
      if (store.disposed) {
        return;
      }

      // Premultiplied as they come, each colour at most its alpha; three channels are opaque.
      const pixels = new Uint32Array(store.width * store.height);
      for (let i = 0, at = 0; i < pixels.length; i++, at += channels) {
        const a = channels > 3 ? outputByte(out[at + 3]) : 255;
        const r = Math.min(a, outputByte(out[at]));
        const g = Math.min(a, channels > 1 ? outputByte(out[at + 1]) : 0);
        const b = Math.min(a, channels > 2 ? outputByte(out[at + 2]) : 0);
        pixels[i] = (((store.transparent ? a : 255) << 24) | (r << 16) | (g << 8) | b) >>> 0;
      }

      store.pixels = pixels;
      store.changed();
      return;
    }

    if (isVector(target)) {
      // A Vector made fixed since start, at another length: adl crashes; refused here.
      if (target.$fixed && target.$a.length !== out.length) {
        throw s.rt.error("RangeError", 1126);
      }

      target.$a = Array.from(out);
      return;
    }

    const bytes = avm2.bytesOf(s.rt, target);
    const data = new Uint8Array(out.length * 4);
    const view = new DataView(data.buffer);
    for (let i = 0; i < out.length; i++) {
      view.setFloat32(i * 4, out[i], bytes.littleEndian);
    }

    bytes.setLength(0);
    bytes.position = 0;
    bytes.write(data);
  };

  class ShaderJobNatives {
    declare $jobShader: Value | undefined;
    declare $jobTarget: Value | undefined;
    declare $jobWidth: number | undefined;
    declare $jobHeight: number | undefined;
    declare $jobState: number | undefined;
    declare $jobProgress: number | undefined;

    get shader(): Value {
      return this.$jobShader ?? null;
    }

    set shader(v: Value) {
      this.$jobShader = v ?? null;
    }

    get target(): Value {
      return this.$jobTarget ?? null;
    }

    set target(v: Value) {
      this.$jobTarget = v ?? null;
    }

    get width(): number {
      return this.$jobWidth ?? 0;
    }

    set width(v: Value) {
      this.$jobWidth = s.rt.toInt(v);
    }

    get height(): number {
      return this.$jobHeight ?? 0;
    }

    set height(v: Value) {
      this.$jobHeight = s.rt.toInt(v);
    }

    get progress(): number {
      return this.$jobProgress ?? Number.NaN;
    }

    start(waitForCompletion: Value): void {
      if ((this.$jobState ?? IDLE) !== IDLE) {
        refuse(2172);
      }

      const shader: Value = this.$jobShader ?? null;
      if (shader === null) {
        throw s.rt.error("TypeError", 2007, "shader");
      }

      const data: AsObject | null = (shader as AsObject).$data ?? null;
      if (data === null || !data.$kernel) {
        refuse(2171);
      }

      const program = programOf((data as AsObject).$kernel);
      const target: Value = this.$jobTarget ?? null;
      let width = this.$jobWidth ?? 0;
      let height = this.$jobHeight ?? 0;
      if (isBitmapData(target)) {
        // A BitmapData is written whole, whatever the job's size; a disposed one is
        // an output adl cannot write.
        const store: BitmapStore | null = (target as AsObject).$store;
        const type = program.output.type;
        if (!store || store.disposed || (type !== 0x3 && type !== 0x4)) {
          refuse(2162);
        }

        width = (store as BitmapStore).width;
        height = (store as BitmapStore).height;
      } else if (!isShaderImage(s, target) || width <= 0 || height <= 0) {
        refuse(2004);
      }

      const kernel = program.kernel;
      const images = new Map<number, ShaderImage>();
      const read: (() => void)[] = [];
      for (const input of kernel.inputs) {
        images.set(input.index, inputImage(s, data as AsObject, input.name, input.channels, read));
      }

      for (const texture of program.sampled) {
        if (!images.has(texture)) {
          refuse(2167);
        }
      }

      const values = kernelValues(s, data as AsObject, kernel);

      // Read: adl moves the positions before it refuses a fixed Vector (1126).
      for (const move of read) {
        move();
      }

      // A ByteArray or a Vector the browser cannot allocate is refused, not the player ended.
      let out: Float32Array;
      try {
        out = new Float32Array(width * height * program.channels);
      } catch (e) {
        if (e instanceof RangeError) {
          refuse(2004);
        }

        throw e;
      }

      const vector = isVector(target) ? (target as AsObject) : null;
      if (vector?.$fixed && vector.$a.length !== out.length) {
        throw s.rt.error("RangeError", 1126);
      }

      program.run(values, images, width, height, out);
      if (waitForCompletion) {
        deliver(target as AsObject, out, program.channels);
        this.$jobState = DONE;
        this.$jobProgress = 1;
        return;
      }

      // Done already, as adl's thread nearly is by the time start returns; the target waits.
      this.$jobState = RUNNING;
      this.$jobProgress = 1;
      s.afterExitFrame.push(() => {
        if (this.$jobState !== RUNNING) {
          return;
        }

        this.$jobState = DONE;
        deliver(target as AsObject, out, program.channels);
        const o = target as AsObject;
        const event = s.rt.construct(
          classes().shaderEvent,
          "complete",
          false,
          false,
          isBitmapData(o) ? o : null,
          s.rt.isInstance(o, classes().byteArray) ? o : null,
          vector,
        ) as AsObject;
        dispatchEvent(s, this as unknown as AsObject, event);
      });
    }

    /** A running job's result is dropped, its progress 0 again; before start, or after, nothing happens. */
    cancel(): void {
      if (this.$jobState === RUNNING) {
        this.$jobState = DONE;
        this.$jobProgress = 0;
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::ShaderJob", ShaderJobNatives);
  return natives;
}
