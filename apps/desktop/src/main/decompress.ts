// A response body a server sent compressed, unasked, decompressed as it
// streams in, as Chromium decompresses it (network.ts). Without Electron,
// so that node tests it (tests/desktop/network.test.ts).
import type { Transform } from "node:stream";
import { createBrotliDecompress, createInflate, createInflateRaw } from "node:zlib";

/** What a server may send compressed, unasked, that is decompressed; any other goes as it came. */
export const DECODED = new Set(["gzip", "x-gzip", "br", "deflate"]);

/** The longest gzip header read, its name and comment included. */
export const GZIP_HEADER_MAX = 64 * 1024;

/**
 * A gzip header read as its bytes come: kept in an array that doubles as
 * it fills, and parsed on from where the last chunk left off, so that a
 * header sent a byte at a time costs no more than one sent whole. One
 * whose end lies past GZIP_HEADER_MAX is refused, however it is chunked.
 */
export class GzipHeader {
  private bytes = new Uint8Array(64);
  private length = 0;
  /** Where parsing goes on from, and in which part: fixed bytes, extra, name, comment, CRC. */
  private at = 0;
  private part = 0;

  /** What came so far. */
  get buffered(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  /** Add `chunk`: the header's length once whole, 0 while more is needed, -1 if it is none. */
  add(chunk: Uint8Array): number {
    if (this.length + chunk.length > this.bytes.length) {
      let capacity = this.bytes.length * 2;
      while (capacity < this.length + chunk.length) {
        capacity *= 2;
      }

      const grown = new Uint8Array(capacity);
      grown.set(this.buffered);
      this.bytes = grown;
    }

    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    const end = this.parse();
    return end > GZIP_HEADER_MAX || (end === 0 && this.at > GZIP_HEADER_MAX) ? -1 : end;
  }

  private parse(): number {
    const bytes = this.buffered;
    const flags = bytes[3];
    for (;;) {
      switch (this.part) {
        case 0: {
          const magic = [0x1f, 0x8b, 8];
          for (let i = 0; i < Math.min(3, bytes.length); i++) {
            if (bytes[i] !== magic[i]) {
              return -1;
            }
          }

          if (bytes.length < 10) {
            return 0;
          }

          this.at = 10;
          this.part = 1;
          break;
        }
        case 1:
          if (flags & 4) {
            if (bytes.length < this.at + 2) {
              return 0;
            }

            this.at += 2 + (bytes[this.at] | (bytes[this.at + 1] << 8));
          }

          this.part = 2;
          break;
        case 2:
        case 3: {
          // FNAME, then FCOMMENT: each up to its NUL, sought only in what is new.
          if (flags & (this.part === 2 ? 8 : 16)) {
            if (this.at > bytes.length) {
              return 0;
            }

            const nul = bytes.indexOf(0, this.at);
            if (nul < 0) {
              this.at = bytes.length;
              return 0;
            }

            this.at = nul + 1;
          }

          this.part++;
          break;
        }
        default:
          return bytes.length >= this.at + (flags & 2 ? 2 : 0) ? this.at + (flags & 2 ? 2 : 0) : 0;
      }
    }
  }
}

/**
 * Decompresses one body of gzip, deflate or br, choosing its inflater
 * once its first bytes are in: gzip's header is read here and its deflate
 * stream inflated raw, so that what follows the stream (its footer, and
 * whatever a server put after it) is ignored, as Chromium ignores it;
 * deflate is zlib's stream or a raw one, as its first two bytes tell.
 */
export class Decompressor {
  /** The first bytes, while they do not yet tell deflate's kind (no more than two). */
  private head = new Uint8Array(0);
  private gzip: GzipHeader | null = null;
  private inflater: Transform | null = null;
  /** Called once the inflater wants more after a write said to wait. */
  onDrain: () => void = () => {};

  private readonly coding: string;
  private readonly data: (chunk: Buffer) => void;
  private readonly done: () => void;
  private readonly failed: () => void;

  constructor(coding: string, data: (chunk: Buffer) => void, done: () => void, failed: () => void) {
    this.coding = coding;
    this.data = data;
    this.done = done;
    this.failed = failed;
  }

  /** Whether more may be written now. */
  write(chunk: Buffer): boolean {
    if (this.inflater) {
      return this.inflater.write(chunk);
    }

    if (this.coding !== "br" && this.coding !== "deflate") {
      this.gzip ??= new GzipHeader();
      const end = this.gzip.add(chunk);
      if (end === 0) {
        return true;
      }

      if (end < 0) {
        this.failed();
        return false;
      }

      return this.start(createInflateRaw(), this.gzip.buffered.subarray(end));
    }

    const head = new Uint8Array(this.head.length + chunk.length);
    head.set(this.head);
    head.set(chunk, this.head.length);
    this.head = head;
    return this.choose(false);
  }

  end(): void {
    if (!this.inflater && this.gzip) {
      // A gzip header that never ended.
      this.failed();
      return;
    }

    if (!this.inflater && !this.choose(true)) {
      return;
    }

    if (this.inflater) {
      this.inflater.end();
    } else {
      // Nothing came: nothing to undo.
      this.done();
    }
  }

  destroy(): void {
    this.inflater?.destroy();
  }

  /** Make the inflater once the bytes so far tell which (`last`: no more come); false: failed. */
  private choose(last: boolean): boolean {
    const head = this.head;
    if (head.length === 0) {
      return true;
    }

    if (this.coding === "br") {
      return this.start(createBrotliDecompress(), head);
    }

    // Deflate: zlib's stream or a raw one, as its first two bytes tell.
    if (head.length < 2 && !last) {
      return true;
    }

    const zlib =
      head.length >= 2 && (head[0] & 0x0f) === 8 && ((head[0] << 8) | head[1]) % 31 === 0;
    return this.start(zlib ? createInflate() : createInflateRaw(), head);
  }

  /** Inflate with `inflater` from `first` on. */
  private start(inflater: Transform, first: Uint8Array): boolean {
    this.inflater = inflater;
    this.head = new Uint8Array(0);
    this.gzip = null;
    inflater.on("data", this.data);
    inflater.on("end", this.done);
    inflater.on("error", this.failed);
    inflater.on("drain", () => this.onDrain());
    return first.length === 0 || inflater.write(first);
  }
}
