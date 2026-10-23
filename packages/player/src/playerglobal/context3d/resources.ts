import { SamplerBiasError } from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../scripting.js";
import { storeOf } from "../flash/display/BitmapData.js";

import { type AsObject, type Bindings, unsupported } from "./lifecycle.js";

export function registerResources(natives: avm2.Natives, s: Scripting, bindings: Bindings): void {
  const { buffers, programs, textures, disposeResource, context, buffer, program, texture, bytes } =
    bindings;

  class BufferNatives {
    uploadFromByteArray(data: AsObject | null, offset: number, start: number, count: number): void {
      if (!data) {
        throw s.rt.error("TypeError", 2007, "data");
      }

      const entry = buffers.get(this as unknown as AsObject);
      if (!entry) {
        throw new Error("Context3D experiment: invalid buffer");
      }

      // Unlike vector uploads, AIR ignores byte uploads after explicit disposal.
      if (entry.disposed) {
        return;
      }

      context(entry.owner);

      const storage = avm2.bytesOf(s.rt, data);
      const value = entry.value;
      const length = count * (value.stride === 0 ? 2 : value.stride * 4);
      if (
        offset < 0 ||
        offset >= storage.length ||
        start < 0 ||
        count < 0 ||
        start > value.count - count ||
        length > storage.length - offset
      ) {
        throw s.rt.error("RangeError", 3669);
      }

      value.uploadBytes(storage.buffer, offset, start, count);
    }

    uploadFromVector(values: AsObject, start: number, count: number): void {
      buffer(this as unknown as AsObject).upload(values.$a, start, count);
    }

    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, buffers.get(object));
    }
  }

  class ProgramNatives {
    upload(vertex: AsObject, fragment: AsObject): void {
      try {
        program(this as unknown as AsObject).upload(bytes(vertex), bytes(fragment));
      } catch (error) {
        if (error instanceof SamplerBiasError) {
          throw s.rt.error("Error", 3696);
        }

        throw error;
      }
    }

    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, programs.get(object));
    }
  }

  function uploadTexture(object: AsObject, source: AsObject, level: number, face: number): void {
    const value = texture(object);
    // AIR accepts this call after explicit texture disposal without reviving
    // the resource. A disposed owner context is still rejected above.
    if (textures.get(object)?.disposed) {
      return;
    }

    if (face >= (value.cube ? 6 : 1)) {
      throw s.rt.error("ArgumentError", 3673);
    }
    if (level >= value.levels) {
      throw s.rt.error("ArgumentError", 3674);
    }
    if (!source) {
      throw s.rt.error("TypeError", 2007, "source");
    }

    const bitmap = storeOf(s, source);
    if (
      !value.rectangle &&
      (bitmap.width !== Math.max(1, value.width >> level) ||
        bitmap.height !== Math.max(1, value.height >> level))
    ) {
      unsupported();
    }

    value.upload(bitmap.readable, level, face, bitmap.width, bitmap.height);
    const entry = textures.get(object);
    if (entry && level === 0 && !value.cube) {
      entry.initialized = true;
    }
  }

  function uploadTextureBytes(
    object: AsObject,
    data: AsObject,
    offset: number,
    level: number,
    face: number,
  ): void {
    if (!data) {
      throw s.rt.error("TypeError", 2007, "data");
    }

    // Unlike bitmap uploads, explicit disposal wins over owner disposal.
    if (textures.get(object)?.disposed) {
      return;
    }

    const value = texture(object);
    if (face >= (value.cube ? 6 : 1)) {
      throw s.rt.error("ArgumentError", 3673);
    }
    if (level >= value.levels) {
      throw s.rt.error("ArgumentError", 3674);
    }

    const storage = avm2.bytesOf(s.rt, data);
    const length = Math.max(1, value.width >> level) * Math.max(1, value.height >> level) * 4;
    if (offset > storage.length - length) {
      throw s.rt.error("RangeError", 3669);
    }

    value.uploadBytes(storage.buffer, offset, level, face);
    const entry = textures.get(object);
    if (entry && level === 0 && !value.cube) {
      entry.initialized = true;
    }
  }

  class TextureNatives {
    uploadFromByteArray(data: AsObject, offset: number, level = 0): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, level, 0);
    }

    uploadFromBitmapData(source: AsObject, level = 0): void {
      uploadTexture(this as unknown as AsObject, source, level, 0);
    }
  }

  class RectangleTextureNatives {
    uploadFromByteArray(data: AsObject, offset: number): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, 0, 0);
    }

    uploadFromBitmapData(source: AsObject): void {
      if (!source) {
        throw s.rt.error("TypeError", 2007, "source");
      }

      if (textures.get(this as unknown as AsObject)?.disposed) {
        return;
      }

      uploadTexture(this as unknown as AsObject, source, 0, 0);
    }
  }

  class CubeTextureNatives {
    uploadFromByteArray(data: AsObject, offset: number, face: number, level = 0): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, level, face);
    }

    uploadFromBitmapData(source: AsObject, face: number, level = 0): void {
      uploadTexture(this as unknown as AsObject, source, level, face);
    }
  }

  class TextureBaseNatives {
    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, textures.get(object));
    }
  }

  avm2.registerNativeClass(natives, "flash.display3D::VertexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::IndexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Program3D", ProgramNatives);
  avm2.registerNativeClass(natives, "flash.display3D.textures::Texture", TextureNatives);
  avm2.registerNativeClass(natives, "flash.display3D.textures::CubeTexture", CubeTextureNatives);
  avm2.registerNativeClass(
    natives,
    "flash.display3D.textures::RectangleTexture",
    RectangleTextureNatives,
  );
  avm2.registerNativeClass(natives, "flash.display3D.textures::TextureBase", TextureBaseNatives);
}
