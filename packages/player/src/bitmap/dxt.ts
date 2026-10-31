import { DxtEncoder } from "@swf2es/native/render";

let encoder: DxtEncoder | null = null;

/** The realm's native encoder, made only when a compressed texture takes pixels. */
export function encodeDxt(
  rgba: Uint8Array,
  dxt5: boolean,
  width: number,
  height: number,
): Uint8Array | null {
  encoder ??= new DxtEncoder();

  return encoder.encode(rgba, dxt5, width, height);
}

/** The last player's textures went with it; their encoder's memory can go too. */
export function releaseDxtEncoder(): void {
  encoder?.release();
}
