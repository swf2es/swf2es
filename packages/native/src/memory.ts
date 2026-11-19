// The memories of the modules' live instances, for a host that shows what
// the page holds (the demo site's performance meter). Held weakly: an
// instance let go of, as KeptInstance lets one go whose memory grew, drops
// out once it is collected.

const memories: WeakRef<WebAssembly.Memory>[] = [];
/** The count at which `track` next sweeps out the collected, doubled each time it does. */
let sweepAt = 64;

/** Count `memory` in nativeMemory while its instance lives. */
export function track(memory: WebAssembly.Memory): void {
  // An MP3 decoder is made for each sound played: the collected ones' refs go too, now and then.
  if (memories.length >= sweepAt) {
    sweep();
    sweepAt = Math.max(64, memories.length * 2);
  }

  memories.push(new WeakRef(memory));
}

/**
 * The bytes the native modules' instances hold in their memories now:
 * bitmap kernels, tessellators, lines, decoders, zlib and LZMA, every
 * player's on the page together. A memory grows and never shrinks; one
 * whose instance was let go of counts until it is collected.
 */
export function nativeMemory(): number {
  let bytes = 0;
  for (let i = 0; i < memories.length; i++) {
    bytes += memories[i].deref()?.buffer.byteLength ?? 0;
  }

  return bytes;
}

function sweep(): void {
  let kept = 0;
  for (let i = 0; i < memories.length; i++) {
    if (memories[i].deref()) {
      memories[kept++] = memories[i];
    }
  }

  memories.length = kept;
}
