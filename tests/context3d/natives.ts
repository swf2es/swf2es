// Test-only native installation, before playerglobal binds. This is not a
// public Context3D implementation: unsupported states and Flash error numbers
// still need their own oracle coverage before promotion into the player.
import { premultiply } from "../../packages/player/dist/bitmap/bitmap.js";
import { storeOf } from "../../packages/player/dist/playerglobal/flash/display/BitmapData.js";
import { dispatchEvent } from "../../packages/player/dist/scripting/events.js";
import type { Scripting } from "../../packages/player/dist/scripting.js";
import { avm2 } from "../../packages/runtime/dist/index.js";
import type { Buffer3D, Context3D, Program3D, Stage3DHost } from "./backend.ts";

type AsObject = avm2.AsObject;

interface Resource<T> {
  value: T;
  owner: AsObject;
  disposed: boolean;
}

const FLOAT_FORMATS = ["float1", "float2", "float3", "float4"];

/** Returns the host teardown; it also cancels creation queued before teardown. */
export function install(s: Scripting, host: Stage3DHost): () => void {
  const natives: avm2.Natives = {};
  const slots = new WeakMap<AsObject, AsObject>();
  const pending = new WeakSet<AsObject>();
  const contexts = new Map<AsObject, { backend: Context3D; slot: AsObject }>();
  const buffers = new WeakMap<AsObject, Resource<Buffer3D>>();
  const programs = new WeakMap<AsObject, Resource<Program3D>>();
  const indices = new WeakMap<AsObject, number>();
  let closed = false;

  function unsupported(): never {
    throw new Error("Unsupported operation in Context3D triangle experiment");
  }

  const indexOf = (slot: AsObject): number => {
    let index = indices.get(slot);
    if (index === undefined) {
      const vector = s.rt.getProperty(s.stage?.object, s.rt.publicName("stage3Ds")) as AsObject;
      index = (vector.$a as AsObject[]).indexOf(slot);
      if (index < 0) {
        unsupported();
      }

      indices.set(slot, index);
    }

    return index;
  };
  const place = (slot: AsObject): void => {
    if (!closed && slots.has(slot)) {
      host.place(indexOf(slot), slot.$x ?? 0, slot.$y ?? 0, slot.$visible ?? true);
    }
  };

  const context = (o: AsObject): Context3D => {
    const entry = contexts.get(o);
    if (!entry || entry.backend.disposed) {
      throw s.rt.error("Error", 3694);
    }

    return entry.backend;
  };
  const buffer = (o: AsObject): Buffer3D => {
    const value = buffers.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid buffer");
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const program = (o: AsObject): Program3D => {
    const value = programs.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid program");
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const construct = (name: string): AsObject =>
    s.rt.construct(s.rt.classNamed(`flash.display3D::${name}`)) as AsObject;
  const bytes = (o: AsObject): Uint8Array => {
    const storage = avm2.bytesOf(s.rt, o);
    return storage.buffer.subarray(0, storage.length);
  };

  const request = (slot: AsObject): void => {
    pending.add(slot);
    s.loads.deferHostEvent(() => {
      pending.delete(slot);
      if (closed || s.destroyed) {
        return;
      }

      const index = indexOf(slot);
      const backend = host.create(index);
      let object: AsObject;
      try {
        object = construct("Context3D");
      } catch (error) {
        backend.dispose();
        host.remove(index);
        throw error;
      }

      contexts.set(object, { backend, slot });
      slots.set(slot, object);
      place(slot);
      dispatchEvent(
        s,
        slot,
        s.rt.construct(s.rt.classNamed("flash.events::Event"), "context3DCreate") as AsObject,
      );
    });
  };

  const dispose = (object: AsObject): AsObject | null => {
    const entry = contexts.get(object);
    if (!entry) {
      return null;
    }

    contexts.delete(object);
    slots.delete(entry.slot);
    entry.backend.dispose();
    host.remove(indexOf(entry.slot));
    return entry.slot;
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

      request(slot);
    }
  }

  class ContextNatives {
    get driverInfo(): string {
      return contexts.has(this as unknown as AsObject) ? "swf2es experimental WebGL2" : "Disposed";
    }

    get profile(): string | null {
      return contexts.has(this as unknown as AsObject) ? "baseline" : null;
    }

    declare $checking: boolean;

    get enableErrorChecking(): boolean {
      return this.$checking ?? false;
    }

    set enableErrorChecking(value: boolean) {
      this.$checking = value;
    }

    get backBufferWidth(): number {
      return contexts.get(this as unknown as AsObject)?.backend.width ?? 0;
    }

    get backBufferHeight(): number {
      return contexts.get(this as unknown as AsObject)?.backend.height ?? 0;
    }

    configureBackBuffer(
      width: number,
      height: number,
      aa: number,
      depth = true,
      best = false,
      zoom = false,
    ): void {
      const backend = context(this as unknown as AsObject);
      if (width < 32) {
        throw s.rt.error("Error", 3780, 32, 2048);
      }
      if (height < 32) {
        throw s.rt.error("Error", 3781, 32, 2048);
      }

      if (aa !== 0 || depth || best || zoom) {
        unsupported();
      }

      backend.configure(width, height);
    }

    clear(r = 0, g = 0, b = 0, a = 1, depth = 1, stencil = 0, mask = 0xffffffff): void {
      const backend = context(this as unknown as AsObject);
      if (backend.width === 0) {
        throw s.rt.error("Error", 3698);
      }

      if (depth !== 1 || stencil !== 0 || (mask !== 0xffffffff && mask !== 1)) {
        unsupported();
      }

      backend.clear(r, g, b, a);
    }

    createVertexBuffer(count: number, stride: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw" || stride === 0) {
        unsupported();
      }

      const resource = context(this as unknown as AsObject).createBuffer(count, stride);
      const object = construct("VertexBuffer3D");
      buffers.set(object, { value: resource, owner: this as unknown as AsObject, disposed: false });

      return object;
    }

    createIndexBuffer(count: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw") {
        unsupported();
      }

      const resource = context(this as unknown as AsObject).createBuffer(count, 0);
      const object = construct("IndexBuffer3D");
      buffers.set(object, { value: resource, owner: this as unknown as AsObject, disposed: false });

      return object;
    }

    createProgram(): AsObject {
      const resource = context(this as unknown as AsObject).createProgram();
      const object = construct("Program3D");
      programs.set(object, {
        value: resource,
        owner: this as unknown as AsObject,
        disposed: false,
      });

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
      const slot = dispose(this as unknown as AsObject);
      if (slot && recreate && !closed && !s.destroyed) {
        request(slot);
      }
    }
  }

  class BufferNatives {
    uploadFromVector(values: AsObject, start: number, count: number): void {
      buffer(this as unknown as AsObject).upload(values.$a, start, count);
    }

    dispose(): void {
      const entry = buffers.get(this as unknown as AsObject);
      if (entry && !entry.disposed) {
        entry.value.dispose();
        entry.disposed = true;
      }
    }
  }

  class ProgramNatives {
    upload(vertex: AsObject, fragment: AsObject): void {
      program(this as unknown as AsObject).upload(bytes(vertex), bytes(fragment));
    }

    dispose(): void {
      const entry = programs.get(this as unknown as AsObject);
      if (entry && !entry.disposed) {
        entry.value.dispose();
        entry.disposed = true;
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage3D", StageNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Context3D", ContextNatives);
  avm2.registerNativeClass(natives, "flash.display3D::VertexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::IndexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Program3D", ProgramNatives);
  // Keep the existing Flash-tested position validation and property storage.
  for (const property of ["x", "y", "visible"]) {
    const key = `flash.display::Stage3D#set:${property}`;
    const original = s.rt.natives[key];
    natives[key] = (rt) => {
      const setter = original(rt);
      return function (this: AsObject, value: avm2.Value) {
        setter.call(this, value);
        place(this);
      };
    };
  }

  Object.assign(s.rt.natives, natives);

  return () => {
    closed = true;
    for (const object of contexts.keys()) {
      dispose(object);
    }
  };
}
