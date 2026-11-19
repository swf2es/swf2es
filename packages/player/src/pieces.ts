// What a load hears of its response as it comes, from a host's
// FetchProgress: pieces of at most Flash's read size, each told once the
// next has come or the response has, so that the last is known as the
// last, with a total that never ends below what came.
import type { FetchProgress, FetchResult } from "./hosts.js";

/**
 * Flash told a load's progress at each read from the network, of 8 KB at
 * most: adl and Flash Player 32's projector alike, a 64 KB piece as 8
 * PROGRESS events in the same millisecond.
 */
export const READ_SIZE = 8192;

/** What a load hears: the response's head, then each piece with the bytes so far and in all. */
export interface Pieces {
  open(head: Omit<FetchResult, "bytes">, total: number): void;
  /**
   * `chunk`, `loaded` in all so far, of `total`: the length the head told,
   * 0 where it told none or once more came than it told (a body decoded
   * from another length, as from a server compressing unasked), and what
   * came, with the last piece, whatever was told.
   */
  data(chunk: Uint8Array, loaded: number, total: number, last: boolean): void;
}

/**
 * `pieces` as a host's FetchProgress, and `end`, called once the response
 * has all come (`whole`) or failed, which tells the piece held back.
 */
export function piecesOf(pieces: Pieces): { progress: FetchProgress; end(whole: boolean): void } {
  let told = 0;
  let loaded = 0;
  let held: Uint8Array | null = null;
  const tell = (last: boolean) => {
    if (held === null) {
      return;
    }

    const chunk = held;
    held = null;
    loaded += chunk.length;
    if (loaded > told) {
      told = 0;
    }

    pieces.data(chunk, loaded, last ? loaded : told, last);
  };
  return {
    progress: {
      open: (head, total) => {
        told = total;
        pieces.open(head, total);
      },
      data: (chunk) => {
        for (let at = 0; at < chunk.length; at += READ_SIZE) {
          tell(false);
          held = chunk.subarray(at, at + READ_SIZE);
        }
      },
    },
    end: (whole) => tell(whole),
  };
}
