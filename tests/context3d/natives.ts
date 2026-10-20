// Test-only native installation, before playerglobal binds. This is not a
// public Context3D implementation: unsupported states and Flash error numbers
// still need their own oracle coverage before promotion into the player.
import { premultiply } from "../../packages/player/dist/bitmap/bitmap.js";
import { storeOf } from "../../packages/player/dist/playerglobal/flash/display/BitmapData.js";
import { dispatchEvent } from "../../packages/player/dist/scripting/events.js";
import type { Scripting } from "../../packages/player/dist/scripting.js";
import { avm2 } from "../../packages/runtime/dist/index.js";
import type { Buffer3D, Context3D, Program3D } from "./backend.ts";

type AsObject = avm2.AsObject;
const FLOAT_FORMATS = ["float1", "float2", "float3", "float4"];

/** Returns the host teardown; it also cancels creation queued before teardown. */
export function install(s: Scripting, create: () => Context3D): () => void {
  const natives: avm2.Natives = {};
  const slots = new WeakMap<AsObject, AsObject>();
  const pending = new WeakSet<AsObject>();
  const contexts = new Map<AsObject, { backend: Context3D; slot: AsObject }>();
  const buffers = new WeakMap<AsObject, Buffer3D>();
  const programs = new WeakMap<AsObject, Program3D>();
  let closed = false;

  function unsupported(): never {
    throw new Error("Unsupported operation in Context3D triangle experiment");
  }

  const context = (o: AsObject): Context3D => {
    const entry = contexts.get(o);
    if (!entry || entry.backend.disposed) {
      throw new Error("Context3D experiment: context disposed");
    }

    return entry.backend;
  };
  const buffer = (o: AsObject): Buffer3D => {
    const value = buffers.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid buffer");
    }

    return value;
  };
  const program = (o: AsObject): Program3D => {
    const value = programs.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid program");
    }

    return value;
  };
  const construct = (name: string): AsObject =>
    s.rt.construct(s.rt.classNamed(`flash.display3D::${name}`)) as AsObject;
  const bytes = (o: AsObject): Uint8Array => {
    const storage = avm2.bytesOf(s.rt, o);
    return storage.buffer.subarray(0, storage.length);
  };

  class StageNatives {
    get context3D(): AsObject | null {
      return slots.get(this as unknown as AsObject) ?? null;
    }

    requestContext3D(mode = "auto", profile = "baseline"): void {
      const slot = this as unknown as AsObject;
      if (
        closed ||
        mode !== "auto" ||
        profile !== "baseline" ||
        slots.has(slot) ||
        pending.has(slot)
      ) {
        unsupported();
      }

      pending.add(slot);
      s.loads.deferHostEvent(() => {
        pending.delete(slot);
        if (closed || s.destroyed) {
          return;
        }

        const backend = create();
        let object: AsObject;
        try {
          object = construct("Context3D");
        } catch (error) {
          backend.dispose();
          throw error;
        }

        contexts.set(object, { backend, slot });
        slots.set(slot, object);
        dispatchEvent(
          s,
          slot,
          s.rt.construct(s.rt.classNamed("flash.events::Event"), "context3DCreate") as AsObject,
        );
      });
    }
  }

  class ContextNatives {
    get driverInfo(): string {
      return "swf2es experimental WebGL2";
    }

    get profile(): string {
      return "baseline";
    }

    declare $checking: boolean;

    get enableErrorChecking(): boolean {
      return this.$checking ?? false;
    }

    set enableErrorChecking(value: boolean) {
      this.$checking = value;
    }

    get backBufferWidth(): number {
      return context(this as unknown as AsObject).width;
    }

    get backBufferHeight(): number {
      return context(this as unknown as AsObject).height;
    }

    configureBackBuffer(
      width: number,
      height: number,
      aa: number,
      depth = true,
      best = false,
      zoom = false,
    ): void {
      if (aa !== 0 || depth || best || zoom) {
        unsupported();
      }

      context(this as unknown as AsObject).configure(width, height);
    }

    clear(r = 0, g = 0, b = 0, a = 1, depth = 1, stencil = 0, mask = 0xffffffff): void {
      if (depth !== 1 || stencil !== 0 || (mask !== 0xffffffff && mask !== 1)) {
        unsupported();
      }

      context(this as unknown as AsObject).clear(r, g, b, a);
    }

    createVertexBuffer(count: number, stride: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw" || stride === 0) {
        unsupported();
      }

      const resource = context(this as unknown as AsObject).createBuffer(count, stride);
      const object = construct("VertexBuffer3D");
      buffers.set(object, resource);

      return object;
    }

    createIndexBuffer(count: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw") {
        unsupported();
      }

      const resource = context(this as unknown as AsObject).createBuffer(count, 0);
      const object = construct("IndexBuffer3D");
      buffers.set(object, resource);

      return object;
    }

    createProgram(): AsObject {
      const resource = context(this as unknown as AsObject).createProgram();
      const object = construct("Program3D");
      programs.set(object, resource);

      return object;
    }

    setProgram(object: AsObject): void {
      context(this as unknown as AsObject).setProgram(program(object));
    }

    setVertexBufferAt(index: number, object: AsObject | null, offset = 0, format = "float4"): void {
      const size = FLOAT_FORMATS.indexOf(format) + 1;
      if (!size) {
        unsupported();
      }

      context(this as unknown as AsObject).setVertex(index, object && buffer(object), offset, size);
    }

    setProgramConstantsFromVector(type: string, first: number, values: AsObject, count = -1): void {
      if (type !== "vertex" && type !== "fragment") {
        unsupported();
      }

      const data: number[] = values.$a;
      context(this as unknown as AsObject).setConstants(
        type,
        first,
        data,
        count === -1 ? Math.floor(data.length / 4) : count,
      );
    }

    setCulling(face: string): void {
      if (face !== "none") {
        unsupported();
      }
    }

    drawTriangles(object: AsObject, first = 0, count = -1): void {
      context(this as unknown as AsObject).draw(buffer(object), first, count);
    }

    drawToBitmapData(destination: AsObject): void {
      const backend = context(this as unknown as AsObject);
      const store = storeOf(s, destination);
      // Different-sized targets and clipping require a separate Flash probe.
      if (store.width !== backend.width || store.height !== backend.height) {
        unsupported();
      }

      const rgba = backend.read();
      const pixels = store.pixels;
      for (let i = 0; i < pixels.length; i++) {
        const at = i * 4;
        const color = (rgba[at + 3] << 24) | (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
        pixels[i] = store.transparent ? premultiply(color) : color | 0xff000000;
      }

      store.changed();
    }

    present(): void {
      context(this as unknown as AsObject).present();
    }

    dispose(recreate = true): void {
      if (recreate) {
        unsupported();
      }

      const object = this as unknown as AsObject;
      const entry = contexts.get(object);
      if (entry) {
        entry.backend.dispose();
        contexts.delete(object);
        slots.delete(entry.slot);
      }
    }
  }

  class BufferNatives {
    uploadFromVector(values: AsObject, start: number, count: number): void {
      buffer(this as unknown as AsObject).upload(values.$a, start, count);
    }

    dispose(): void {
      buffer(this as unknown as AsObject).dispose();
    }
  }

  class ProgramNatives {
    upload(vertex: AsObject, fragment: AsObject): void {
      program(this as unknown as AsObject).upload(bytes(vertex), bytes(fragment));
    }

    dispose(): void {
      program(this as unknown as AsObject).dispose();
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage3D", StageNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Context3D", ContextNatives);
  avm2.registerNativeClass(natives, "flash.display3D::VertexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::IndexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Program3D", ProgramNatives);
  Object.assign(s.rt.natives, natives);

  return () => {
    closed = true;
    for (const entry of contexts.values()) {
      entry.backend.dispose();
      slots.delete(entry.slot);
    }

    contexts.clear();
  };
}
