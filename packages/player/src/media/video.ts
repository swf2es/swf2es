import { argbOf, BitmapStore, premultiply } from "../bitmap/bitmap.js";

/** A host-owned frame, valid until the next publish, including after a lost GL context. */
export interface VideoPicture {
  width: number;
  height: number;
  /** A canvas, video element or VideoFrame; ImageBitmaps must already be premultiplied. */
  image: TexImageSource;
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
    this.cpu = null;
    for (const ref of this.views) {
      const view = ref.deref();
      if (view) {
        view.pixelsChanged(false);
      } else {
        this.views.delete(ref);
      }
    }
  }

  /** Read at most once per published frame, only when a script asks for pixels. */
  bitmap(): BitmapStore | null {
    const picture = this.current;
    if (!picture || this.cpu) {
      return this.cpu;
    }

    const bytes = picture.readPixels();
    if (bytes.length !== picture.width * picture.height * 4) {
      throw new RangeError("Invalid video frame pixels");
    }

    const store = new BitmapStore(picture.width, picture.height, true, 0);
    const pixels = argbOf(bytes);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = premultiply(pixels[i]);
    }

    store.pixels = pixels;
    this.cpu = store;
    return store;
  }
}
