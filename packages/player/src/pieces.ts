// What a load hears of its response as it comes, from a host's
// FetchProgress: reads of at most Flash's read size, each told as it comes,
// with a total that never stays below what came, and a last word once the
// response has all come where what was told did not end with all of it.
import type { FetchProgress, FetchResult } from "./hosts.js";

/**
 * Flash told a load's progress at each read from the network, of 8 KB at
 * most: adl and Flash Player 32's projector alike, a 64 KB piece as 8
 * PROGRESS events in the same millisecond.
 */
export const READ_SIZE = 8192;

/** What a load hears: the response's head, then each read with the bytes so far and in all. */
export interface Pieces {
  open(head: Omit<FetchResult, "bytes">, total: number): void;
  /**
   * `chunk`, `loaded` in all so far, of `total`: the length the head told,
   * 0 where it told none or once more came than it told (a body decoded
   * from another length, as from a server compressing unasked). `last`
   * marks the word once all has come, an empty chunk, told only where the
   * last read's total was not what came: its total is then what came.
   */
  data(chunk: Uint8Array, loaded: number, total: number, last: boolean): void;
}

const NONE = new Uint8Array(0);

/**
 * `pieces` as a host's FetchProgress, and `end`, called once the response
 * has all come (`whole`) or failed. Reads are told at once, so a response
 * that stays open, as a server pushing messages keeps one, is heard as each
 * comes.
 */
export function piecesOf(pieces: Pieces): { progress: FetchProgress; end(whole: boolean): void } {
  let told = 0;
  let loaded = 0;
  return {
    progress: {
      open: (head, total) => {
        told = total;
        pieces.open(head, total);
      },
      data: (chunk) => {
        for (let at = 0; at < chunk.length; at += READ_SIZE) {
          const read = chunk.subarray(at, at + READ_SIZE);
          loaded += read.length;
          if (loaded > told) {
            told = 0;
          }

          pieces.data(read, loaded, told, false);
        }
      },
    },
    end: (whole) => {
      if (whole && told !== loaded) {
        pieces.data(NONE, loaded, loaded, true);
      }
    },
  };
}
