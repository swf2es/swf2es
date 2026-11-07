// A ZIP archive's files, as an AIR package (`.air`) and any zip of an
// application's folder hold them: the central directory read from the
// archive's end, each file stored or deflated. Enough for what packagers
// write; ZIP64, encryption and the other methods are refused.
import { zlibUncompress } from "./compression.js";
import { utf8 } from "./display.js";

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record's size without its comment, and the most its comment may add. */
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {
  override name = "ZipError";
}

/** One file of an archive; a directory's name ends in "/". */
export interface ZipEntry {
  /** Its path in the archive, "/"-separated. */
  name: string;
  /** Its uncompressed size in bytes. */
  size: number;
  /** When it was last changed, in ms since 1970, read as local time as DOS's fields are. */
  modified: number;
  /** Its bytes, inflated on each call. */
  bytes(): Uint8Array;
}

/** The files of the archive `zip`, in its central directory's order. */
export function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = findEnd(zip, view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError("the central directory is cut short");
    }

    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8(zip.subarray(at + 46, at + 46 + nameLength));
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new ZipError(`${name}: ZIP64 archives are not read`);
    }

    if ((view.getUint16(at + 8, true) & 1) !== 0) {
      throw new ZipError(`${name}: encrypted`);
    }

    if (method !== STORED && method !== DEFLATED) {
      throw new ZipError(`${name}: compression method ${method} is not read`);
    }

    entries.push({
      name,
      size,
      modified: dosTime(date, time),
      bytes: () => entryBytes(zip, view, name, local, method, compressed, size),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Where the end of central directory record starts: the last signature with room for its comment. */
function findEnd(zip: Uint8Array, view: DataView): number {
  const last = zip.length - END_SIZE;
  for (let at = last; at >= 0 && at >= last - MAX_COMMENT; at--) {
    if (
      view.getUint32(at, true) === END_SIGNATURE &&
      at + END_SIZE + view.getUint16(at + 20, true) === zip.length
    ) {
      return at;
    }
  }

  throw new ZipError("not a ZIP archive: no end of central directory");
}

function entryBytes(
  zip: Uint8Array,
  view: DataView,
  name: string,
  local: number,
  method: number,
  compressed: number,
  size: number,
): Uint8Array {
  if (local + 30 > zip.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw new ZipError(`${name}: no local header where the directory says`);
  }

  // The local header's own name and extra lengths, which may differ from the directory's.
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + compressed > zip.length) {
    throw new ZipError(`${name}: cut short`);
  }

  const data = zip.subarray(start, start + compressed);
  const bytes = method === STORED ? data.slice() : zlibUncompress(data, true);
  if (bytes.length !== size) {
    throw new ZipError(`${name}: ${bytes.length} bytes where the directory says ${size}`);
  }

  return bytes;
}

/** A DOS date and time (2-second steps) as ms since 1970, read as local time. */
function dosTime(date: number, time: number): number {
  return new Date(
    1980 + (date >> 9),
    ((date >> 5) & 15) - 1,
    date & 31,
    time >> 11,
    (time >> 5) & 63,
    (time & 31) * 2,
  ).getTime();
}
