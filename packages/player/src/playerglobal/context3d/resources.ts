import { Context3DError, SamplerBiasError, type Texture3D } from "@swf2es/context3d";
import {
  AtfError,
  type AtfHeader,
  type AtfImage,
  atfKind,
  decodeAtf,
  readAtfHeader,
} from "@swf2es/native/atf";
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../scripting/events.js";
import type { Scripting } from "../../scripting.js";
import { storeOf } from "../flash/display/BitmapData.js";

import { flashError } from "./errors.js";
import type { AsObject, Bindings } from "./lifecycle.js";

export function registerResources(natives: avm2.Natives, s: Scripting, bindings: Bindings): void {
  const {
    buffers,
    programs,
    textures,
    contexts,
    disposeResource,
    context,
    buffer,
    program,
    texture,
    bytes,
  } = bindings;

  class BufferNatives {
    uploadFromByteArray(data: AsObject | null, offset: number, start: number, count: number): void {
      if (!data) {
        throw s.rt.error("TypeError", 2007, "data");
      }

      const entry = buffers.get(this as unknown as AsObject);
      if (!entry) {
        throw s.rt.error("Error", 3694);
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

  /** AIR's errors for an ATF it refuses, their classes, and an ErrorEvent's whole text. */
  const ATF_IDS = { size: 3669, decode: 3677, format: 3675 } as const;
  const ATF_TEXTS: Record<number, string> = {
    3675: "Error #3675: Texture format mismatch.",
    3677: "Error #3677: Texture decoding failed. Internal error.",
    3679: "Error #3679: Texture size does not match.",
  };
  const ATF_ERRORS: Record<number, string> = {
    3669: "RangeError",
    3675: "ArgumentError",
    3677: "ArgumentError",
    3679: "ArgumentError",
  };

  /**
   * The ATF's levels uploaded to `value`, checked as AIR checks them after
   * its header: a format AIR knows (#3677), the texture's (#3675), levels
   * that decode (#3677), then the texture's size (#3679). 0 where it is
   * uploaded, else the error's ID, and nothing uploaded.
   */
  function applyAtf(
    object: AsObject,
    value: Texture3D,
    data: Uint8Array,
    header: AtfHeader,
  ): number {
    // AIR reads the new header and CompressedAlpha for content from SWF 17,
    // and version 3, with ETC2's blocks, from SWF 29: before, they are corrupt.
    const kind = atfKind(header.format);
    const swf = s.rt.swfVersion;
    if (
      kind === undefined ||
      (swf < 17 && (!header.old || kind === "compressedAlpha")) ||
      (swf < 29 && header.version >= 3)
    ) {
      return ATF_IDS.decode;
    }
    if (kind !== value.format || header.cube !== value.cube) {
      return ATF_IDS.format;
    }

    let images: AtfImage[];
    try {
      images = decodeAtf(data, header);
    } catch (error) {
      if (error instanceof AtfError) {
        return ATF_IDS[error.reason];
      }

      throw error;
    }

    if (header.width !== value.width || header.height !== value.height) {
      return 3679;
    }

    for (const image of images) {
      // ATF's faces go -X, +X, -Y, +Y, -Z, +Z; CubeTexture's sides +X, -X, and so on.
      const face = value.cube ? image.face ^ 1 : 0;
      if (kind === "bgra") {
        value.uploadBytes(image.bytes, 0, image.level, face);
      } else {
        value.uploadCompressed(image.bytes, image.level, face);
      }
    }

    const entry = textures.get(object);
    if (entry && !value.cube && images.some((image) => image.level === 0)) {
      entry.initialized = true;
    }

    return 0;
  }

  /**
   * uploadCompressedTextureFromByteArray. AIR checks the signature and the
   * length before returning, even for an asynchronous upload; the rest of
   * an asynchronous one it reports as an ErrorEvent on the texture, or
   * textureReady once it is uploaded, at the next frame before its
   * enterFrame. The bytes are read when it is called.
   */
  function uploadAtf(
    object: AsObject,
    data: AsObject | null,
    offset: number,
    async: boolean,
  ): void {
    if (!data) {
      throw s.rt.error("TypeError", 2007, "data");
    }

    // As for byte uploads, explicit disposal wins over the owner's.
    if (textures.get(object)?.disposed) {
      return;
    }

    const value = texture(object);
    const storage = avm2.bytesOf(s.rt, data);
    const bytes = storage.buffer.subarray(0, storage.length);
    let header: AtfHeader;
    try {
      header = readAtfHeader(bytes, offset);
    } catch (error) {
      if (error instanceof AtfError) {
        throw s.rt.error(ATF_ERRORS[ATF_IDS[error.reason]], ATF_IDS[error.reason]);
      }

      throw error;
    }

    if (!async) {
      const id = applyAtf(object, value, bytes, header);
      if (id) {
        throw s.rt.error(ATF_ERRORS[id], id);
      }

      return;
    }

    // AIR reads on past the length, as far as the data goes.
    const copy = bytes.slice(offset);
    s.loads.deferHostEvent(() => {
      // A texture whose context is gone hears nothing; one disposed meanwhile, #3677, as in AIR.
      const entry = textures.get(object);
      if (!entry || !contexts.has(entry.owner) || s.destroyed) {
        return;
      }

      let id: number = ATF_IDS.decode;
      try {
        id = entry.disposed ? id : applyAtf(object, value, copy, readAtfHeader(copy, 0));
      } catch (error) {
        // The backend's own failure, which a synchronous upload throws translated, as an event.
        if (!(error instanceof Context3DError)) {
          throw error;
        }

        id = flashError(error).id;
      }

      const event = id
        ? (s.rt.construct(
            s.rt.classNamed("flash.events::ErrorEvent"),
            "error",
            false,
            false,
            ATF_TEXTS[id] ?? s.rt.errorMessage(id),
            id,
          ) as AsObject)
        : s.event("textureReady");
      dispatchEvent(s, object, event);
    });
  }

  class TextureNatives {
    uploadCompressedTextureFromByteArray(
      data: AsObject | null,
      offset: number,
      async = false,
    ): void {
      uploadAtf(this as unknown as AsObject, data, offset, async);
    }

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
    uploadCompressedTextureFromByteArray(
      data: AsObject | null,
      offset: number,
      async = false,
    ): void {
      uploadAtf(this as unknown as AsObject, data, offset, async);
    }

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
