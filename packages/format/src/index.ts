/**
 * Parsers for the SWF container, its tags, ABC (DoABC) and AVM1 action records.
 * The compiler and the player both use this package, so it must stay free of
 * DOM and node APIs.
 */

export type SwfCompression = "none" | "zlib" | "lzma";

export interface SwfHeader {
  compression: SwfCompression;
  /** SWF version byte (e.g. 10 for Flash Player 10). */
  version: number;
  /** Uncompressed length of the whole file, header included. */
  fileLength: number;
}

const SIGNATURES: Record<string, SwfCompression> = { FWS: "none", CWS: "zlib", ZWS: "lzma" };

/** Read the 8-byte header every SWF starts with. */
export function readSwfHeader(bytes: Uint8Array): SwfHeader {
  if (bytes.length < 8) throw new RangeError("SWF header needs 8 bytes, got " + bytes.length);
  const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!);
  const compression = SIGNATURES[signature];
  if (!compression) throw new TypeError("Not a SWF file (signature " + JSON.stringify(signature) + ")");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { compression, version: bytes[3]!, fileLength: view.getUint32(4, true) };
}
