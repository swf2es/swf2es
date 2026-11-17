// Whether a SWF's ActionScript names Camera or Microphone, which only then
// waits for the capture host to read the devices (Scripting.prepareCapture).
// Its bytes are searched first, as most SWFs hold neither word; a game's own
// Camera class holds the word but not flash.media's, which its constant
// pool tells. getDefinitionByName finds them by a string of the full name.
import { abcReferences } from "@swf2es/format";

const textEncoder = new TextEncoder();
const CLASSES = ["Camera", "Microphone"];
const WORDS = CLASSES.map((name) => textEncoder.encode(name));
const STRINGS = CLASSES.flatMap((name) => [`flash.media.${name}`, `flash.media::${name}`]).map(
  (name) => textEncoder.encode(name),
);
const QUALIFIED = new Set(CLASSES.map((name) => `flash.media::${name}`));

function holds(bytes: Uint8Array, word: Uint8Array): boolean {
  const first = word[0];
  const end = bytes.length - word.length;
  for (let at = bytes.indexOf(first); at !== -1 && at <= end; at = bytes.indexOf(first, at + 1)) {
    let k = 1;
    while (k < word.length && bytes[at + k] === word[k]) {
      k++;
    }

    if (k === word.length) {
      return true;
    }
  }

  return false;
}

/** Whether any of `abcs` may reach flash.media's Camera or Microphone. */
export function namesCapture(abcs: Uint8Array[]): boolean {
  for (const abc of abcs) {
    if (!WORDS.some((word) => holds(abc, word))) {
      continue;
    }

    if (STRINGS.some((name) => holds(abc, name))) {
      return true;
    }

    for (const name of abcReferences(abc)) {
      if (QUALIFIED.has(name)) {
        return true;
      }
    }
  }

  return false;
}
