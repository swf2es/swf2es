import { BitmapStore, premultiply } from "../bitmap/bitmap.js";

/** A host-owned frame, valid until the next publish, including after a lost GL context. */
export interface VideoPicture {
  width: number;
  height: number;
  /** A canvas, video element or VideoFrame; ImageBitmaps must already be premultiplied. */
  image: TexImageSource;
  /** Camera frames are opaque; other sources must preserve alpha. */
  opaque?: boolean;
  /** Keep an independent image for detach; without this hook, detach clears the Video. */
  retain?(): VideoPicture;
  /** Straight RGBA, top row first, read on the CPU without a WebGL readback. */
  readPixels(): Uint8Array | Uint8ClampedArray;
}

export interface VideoView {
  pixelsChanged(disposed: boolean): void;
}

/** Shared by every Video attached to a capture or, later, a playing stream. */
export class VideoSource {
  private current: VideoPicture | null = null;
  private serial = 0;
  private cpu: BitmapStore | null = null;
  private cpuVersion = -1;
  readonly views = new Set<WeakRef<VideoView>>();

  get picture(): VideoPicture | null {
    return this.current;
  }

  get version(): number {
    return this.serial;
  }

  /** Publish only when the image changes; null clears it when the source ends. */
  publish(picture: VideoPicture | null): void {
    if (
      picture &&
      (!Number.isInteger(picture.width) ||
        !Number.isInteger(picture.height) ||
        picture.width <= 0 ||
        picture.height <= 0)
    ) {
      throw new RangeError("Invalid video frame dimensions");
    }

    this.current = picture;
    this.serial++;
    if (!picture) {
      this.cpu = null;
    }
    for (const ref of this.views) {
      const view = ref.deref();
      if (view) {
        view.pixelsChanged(false);
      } else {
        this.views.delete(ref);
      }
    }
  }

  /** A detached Video owns a still image while its former source can be reused. */
  snapshot(): VideoSource | null {
    const picture = this.current;
    if (!picture) {
      return null;
    }

    if (!picture.retain) {
      return null;
    }

    const source = new VideoSource();
    source.publish(picture.retain());

    return source;
  }

  /** Read at most once per published frame, only when a script asks for pixels. */
  bitmap(): BitmapStore | null {
    const picture = this.current;
    if (!picture) {
      return null;
    }
    if (this.cpuVersion === this.serial) {
      return this.cpu;
    }

    const bytes = picture.readPixels();
    if (bytes.length !== picture.width * picture.height * 4) {
      throw new RangeError("Invalid video frame pixels");
    }

    if (!this.cpu || this.cpu.width !== picture.width || this.cpu.height !== picture.height) {
      this.cpu = new BitmapStore(picture.width, picture.height, true, 0);
    }

    const store = this.cpu;
    const pixels = store.pixels;
    for (let i = 0; i < pixels.length; i++) {
      const at = i * 4;
      const pixel =
        (bytes[at + 3] << 24) | (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
      pixels[i] = picture.opaque ? pixel : premultiply(pixel);
    }

    store.changed();
    this.cpuVersion = this.serial;
    return store;
  }
}
