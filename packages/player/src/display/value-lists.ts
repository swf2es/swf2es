// Caches kept as short lists of entries found by their values, the latest
// used last, rather than in maps by keys formatted from those values on
// every frame: the renderer's lines, gradients and device runs, and the
// slices of a set of layers. Each finds its entry in a loop of its own,
// comparing its fields with `same`, and keeps its list with these.

/** Whether two numbers are the same as a cache's key: NaN the same as NaN, as "NaN" was. */
export function same(x: number, y: number): boolean {
  return x === y || (Number.isNaN(x) && Number.isNaN(y));
}

/** Entry `i` of `list` moved to its end, as the latest used: the entry. */
export function moveLast<T>(list: T[], i: number): T {
  const entry = list[i];
  for (let k = i; k < list.length - 1; k++) {
    list[k] = list[k + 1];
  }

  list[list.length - 1] = entry;
  return entry;
}

/**
 * Room made in `list` for one more, where it holds `most` already: those
 * `gone` dropped in place, then the least lately used, each `let go`.
 */
export function makeRoom<T>(
  list: T[],
  most: number,
  gone: (entry: T) => boolean,
  letGo: (entry: T) => void,
): void {
  if (list.length < most) {
    return;
  }

  let kept = 0;
  for (const entry of list) {
    if (gone(entry)) {
      letGo(entry);
    } else {
      list[kept++] = entry;
    }
  }

  list.length = kept;
  while (list.length >= most) {
    letGo(list.shift() as T);
  }
}
