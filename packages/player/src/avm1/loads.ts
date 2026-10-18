// What an AVM1 load brings, made ready before the frame that delivers it:
// a SWF read, its library's images decoded, or an image file's pixels,
// sniffed by their bytes and not by the URL, as Ruffle's
// (https://github.com/ruffle-rs/ruffle) core/src/loader.rs
// (ContentType::sniff, movie_loader_data) has it: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
//
// AVM1 plays what it loads as AVM1, an ActionScript 3 SWF too: its
// timeline plays and none of its code runs, as Ruffle forces such a SWF
// to AVM1 (docs/avm1.md, "Loading movies").
import { readSwf, type Swf } from "@swf2es/format";
import { decodeImageFile, decodeImages, type ImageDecode, imageFormat } from "../bitmap/images.js";
import { type BitmapPixels, type Library, readLibrary } from "../display/timeline.js";
import type { FetchResult } from "../hosts.js";

/** What a load brought, by what its bytes are. */
export type Arrival =
  /** Nothing came: the URL was not found, or the request failed. */
  | { type: "failed"; status: number }
  /** A SWF, read, its images decoded. */
  | { type: "swf"; swf: Swf; library: Library; size: number; status: number }
  /** A JPEG, PNG or GIF, decoded: null pixels for one the decoder could not read. */
  | { type: "image"; pixels: BitmapPixels | null; size: number; status: number }
  /** Bytes that are neither, which leave the clip empty, as Flash's error state. */
  | { type: "unknown"; status: number };

/** What `result`'s bytes are, read and decoded as far as a frame needs them. */
export async function arrive(result: FetchResult, decode: ImageDecode | null): Promise<Arrival> {
  const bytes = result.bytes;
  const status = result.status;
  if (bytes === null) {
    return { type: "failed", status };
  }

  const format = imageFormat(bytes);
  if (format !== null) {
    const pixels = await decodeImageFile(bytes, format, decode);
    return { type: "image", pixels, size: bytes.length, status };
  }

  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS") {
    return { type: "unknown", status };
  }

  let swf: Swf;
  let library: Library;
  try {
    swf = readSwf(bytes);
    library = readLibrary(swf);
  } catch {
    return { type: "unknown", status };
  }

  await decodeImages(library, decode);
  return { type: "swf", swf, library, size: bytes.length, status };
}

/**
 * A URL's query as a loaded SWF's root gets it, each name a variable, as
 * Ruffle's movie_loader_complete defines a movie's parameters: decoded,
 * `+` a space, a name without `=` an empty value.
 */
export function queryVariables(url: string): [name: string, value: string][] {
  const path = url.split("#", 1)[0];
  const at = path.indexOf("?");
  if (at < 0) {
    return [];
  }

  return [...new URLSearchParams(path.slice(at + 1))];
}
