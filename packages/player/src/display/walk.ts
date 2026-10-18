// The walks of the display list the player makes every frame: the clips
// and buttons whose frames run, kept on each container between changes,
// and a container's children through the timeline masks that clip them.
import type { ButtonObject } from "./buttonobject.js";
import type { Container } from "./container.js";
import { BUTTON, CLIP, type DisplayObject, OTHER } from "./displayobject.js";

/**
 * The clips and buttons the frame's walks visit at and under a container,
 * in tree order, parents first (Player.tick's collect, a round of frame
 * scripts): `ends[i]` is the index after `items[i]` and all under it, to
 * leave a clip out with what it holds. A button's states are not in it,
 * its end the index after it: they are walked as they are, which a button
 * changes without its parent knowing (`frameChildren`, `scriptChildren`).
 */
export interface WalkList {
  items: DisplayObject[];
  ends: number[];
  /** Whether it is what is under its container now; once not, its arrays are made again in. */
  current: boolean;
}

/** The shortest list a container keeps for itself; a shorter one its parent's making walks again. */
const KEPT_WALK = 32;

/**
 * Those the frame's walks visit at and under `root`, as WalkList lays them
 * out: kept on each container till a clip or a container comes or goes
 * under it (Container.relist), so that a frame visits the clips alone,
 * where its walks visited every object with children, twice or more.
 * Made again in the arrays it had, as a busy movie's are made again every
 * frame, some ten thousand objects long.
 */
export function walkList(root: Container): WalkList {
  let list = root.walk;
  if (list?.current) {
    return list;
  }

  list ??= { items: [], ends: [], current: false };
  const length = listInto(root, list, 0, false);
  // Cut to length, which keeps the arrays' room unless far shorter: a length of 0 would not.
  list.items.length = length;
  list.ends.length = length;
  list.current = true;
  root.walk = list;
  return list;
}

/**
 * `c` and those under it written to `list` from index `at`, each
 * container's kept list copied where it has one; `c`'s own kept too where
 * `keep`, and long enough. Returns the index after the last written.
 */
function listInto(c: Container, list: WalkList, at: number, keep = true): number {
  const { items, ends } = list;
  const start = at;
  let n = at;
  if (c.kind === CLIP) {
    items[n] = c;
    ends[n++] = 0;
  }

  const children = c.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.kind === BUTTON) {
      items[n] = child;
      ends[n] = n + 1;
      n++;
      continue;
    }

    if (child.kind === OTHER && child.frameChildren.length === 0) {
      continue;
    }

    const kept = (child as Container).walk;
    if (!kept?.current) {
      n = listInto(child as Container, list, n);
      continue;
    }

    const base = n;
    const keptItems = kept.items;
    const keptEnds = kept.ends;
    for (let k = 0; k < keptItems.length; k++) {
      items[n] = keptItems[k];
      ends[n++] = keptEnds[k] + base;
    }
  }

  if (c.kind === CLIP) {
    ends[start] = n;
  }

  // Long enough, kept for the next list made above it, which then copies it.
  const length = n - start;
  if (keep && length >= KEPT_WALK) {
    let own = c.walk;
    if (!own) {
      own = { items: [], ends: [], current: false };
      c.walk = own;
    }

    const ownItems = own.items;
    const ownEnds = own.ends;
    for (let k = 0; k < length; k++) {
      ownItems[k] = items[start + k];
      ownEnds[k] = ends[start + k] - start;
    }

    ownItems.length = length;
    ownEnds.length = length;
    own.current = true;
  }

  return n;
}

/**
 * The display objects whose frame scripts a display object's run: those
 * whose frames its frames run, but a button's first, in a SWF after 9, up,
 * over, down, then hit test, as Flash runs them while the button is made.
 */
export function scriptChildren(d: DisplayObject): readonly DisplayObject[] {
  if (d.kind === BUTTON && (d as ButtonObject).firstScripts) {
    const b = d as ButtonObject;
    b.firstScripts = false;
    return [b.upState, b.overState, b.downState, b.hitTestState].filter(
      (o, i, all): o is DisplayObject => o !== null && all.indexOf(o) === i && !o.encloses(b),
    );
  }

  return d.kind === BUTTON ? (d as ButtonObject).playingStates() : d.frameChildren;
}

/**
 * A walk of a container's children in render order, for the timeline
 * masks that clip each: a mask clips the children after it until one
 * placed deeper than its clip depth; one a script put among them has no
 * depth and ends nothing. A class, not a generator: the renderer walks
 * every child each time a container's children change.
 */
export class Clips {
  /** The masks open, outermost first. */
  readonly masks: DisplayObject[] = [];

  /** The next child: how many of `masks`, from the first, clip it; it clips those after it, if a mask. */
  enter(child: DisplayObject): number {
    const depth = child.depth;
    const masks = this.masks;
    while (depth !== null && masks.length > 0 && masks[masks.length - 1].clipDepth < depth) {
      masks.pop();
    }

    const n = masks.length;
    if (child.clipDepth > 0) {
      masks.push(child);
    }

    return n;
  }
}
