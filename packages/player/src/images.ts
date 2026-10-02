// The images in a SWF's JPEG tags, decoded when the SWF is linked, before
// its scripts run, so that a bitmap class's constructor finds its pixels
// at hand as Flash's does. The host may give a decoder; the browser's
// serves otherwise, and without either an image is one Flash cannot read.
import {
  type BitmapCharacter,
  type BitmapPixels,
  INVALID_PIXELS,
  type Library,
} from "./timeline.js";

/** A decoded image: straight (not premultiplied) RGBA, row by row. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decodes a JPEG, PNG or GIF; null for one it cannot. */
export type ImageDecode = (
  data: Uint8Array,
  format: "jpeg" | "png" | "gif",
) => Promise<DecodedImage | null>;

/**
 * The browser's decoder. A PNG's or GIF's frame comes from WebCodecs'
 * ImageDecoder as it is, straight alpha (asking `copyTo` for RGBA goes
 * through premultiplied values and loses low alphas' colours); a JPEG,
 * opaque, and anything ImageDecoder will not take, through
 * createImageBitmap and a canvas.
 */
export async function decodeInBrowser(
  data: Uint8Array,
  format: "jpeg" | "png" | "gif",
): Promise<DecodedImage | null> {
  const type = `image/${format}`;
  try {
    if (format !== "jpeg" && typeof ImageDecoder !== "undefined") {
      const decoded = await decodeFrame(data, type);
      if (decoded) {
        return decoded;
      }
    }

    if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") {
      return null;
    }

    const bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>], { type }), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return { width: canvas.width, height: canvas.height, rgba: new Uint8Array(pixels.buffer) };
  } catch {
    return null;
  }
}

/** The first frame's pixels as ImageDecoder gives them, in a format of four bytes a pixel; null for another. */
async function decodeFrame(data: Uint8Array, type: string): Promise<DecodedImage | null> {
  const decoder = new ImageDecoder({ data, type, colorSpaceConversion: "none" });
  try {
    const { image } = await decoder.decode();
    try {
      const order = image.format?.startsWith("BGR") ? 2 : 0;
      const opaque = image.format?.endsWith("X");
      if (!image.format || !/^(RGB|BGR)[AX]$/.test(image.format)) {
        return null;
      }

      const raw = new Uint8Array(image.allocationSize());
      const [plane] = await image.copyTo(raw);
      const width = image.displayWidth;
      const height = image.displayHeight;
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = plane.offset + y * plane.stride + x * 4;
          const to = (y * width + x) * 4;
          rgba[to] = raw[from + order];
          rgba[to + 1] = raw[from + 1];
          rgba[to + 2] = raw[from + 2 - order];
          rgba[to + 3] = opaque ? 255 : raw[from + 3];
        }
      }

      return { width, height, rgba };
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

/** Decode every image of `library` not yet decoded, all at once. */
export async function decodeImages(library: Library, decode: ImageDecode | null): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const character of library.characters.values()) {
    if (character.type === "bitmap" && !character.pixels) {
      pending.push(decodeOne(character, decode));
    }
  }

  await Promise.all(pending);
}

async function decodeOne(character: BitmapCharacter, decode: ImageDecode | null): Promise<void> {
  const definition = character.definition;
  if (definition.type !== "image" || !decode) {
    character.pixels = INVALID_PIXELS;
    return;
  }

  const image = await decode(definition.data, definition.format);
  character.pixels =
    image && image.width > 0 && image.height > 0 ? pixelsOf(definition, image) : INVALID_PIXELS;
}

/** The pixels Flash makes of a decoded image, as adl shows them. */
function pixelsOf(
  definition: Extract<BitmapCharacter["definition"], { type: "image" }>,
  image: DecodedImage,
): BitmapPixels {
  const { width, height, rgba } = image;
  const count = width * height;
  const pixels = new Uint32Array(count);
  if (definition.format !== "jpeg") {
    // A PNG's or GIF's own alpha, premultiplied with the product floored.
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      const a = rgba[p + 3];
      pixels[i] =
        a === 255
          ? (0xff000000 | (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]) >>> 0
          : ((a << 24) |
              (Math.floor((rgba[p] * a) / 255) << 16) |
              (Math.floor((rgba[p + 1] * a) / 255) << 8) |
              Math.floor((rgba[p + 2] * a) / 255)) >>>
            0;
    }

    return { width, height, transparent: true, pixels };
  }

  // DefineBitsJPEG3's colours are taken as premultiplied by its alpha
  // already, not premultiplied again; a colour above its alpha reads back
  // as 255, as it does from a colour clamped to the alpha, which keeps the
  // store a valid premultiplied one. Alpha of the wrong size is none.
  const alpha = definition.alpha && definition.alpha.length >= count ? definition.alpha : null;
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const a = alpha ? alpha[i] : 255;
    pixels[i] =
      ((a << 24) |
        (Math.min(rgba[p], a) << 16) |
        (Math.min(rgba[p + 1], a) << 8) |
        Math.min(rgba[p + 2], a)) >>>
      0;
  }

  return { width, height, transparent: alpha !== null || definition.opaque, pixels };
}
