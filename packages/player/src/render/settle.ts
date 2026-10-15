// Render groups settling: a group left unchanged a while has its Graphics
// batched, and they are drawn alone again as soon as it changes. Pixi's
// render group system tells of each build (noteBuild), which times it.
import type { ColorTransform } from "@swf2es/format";
import { Graphics, type Container as PixiContainer } from "pixi.js";
import { type SharingGraphics, showFor } from "./color.js";

/**
 * How long a render group goes without its instructions being rebuilt
 * before its Graphics are batched. Each Graphics drawn alone is a draw
 * call of its own, thousands in a crowded room, most of them scenery that
 * never changes; batched, they are a few. But a batch packs its vertices
 * again whenever its group is rebuilt, as an animated character's is on
 * most frames: only a group that has settled is batched, and it is drawn
 * alone again as soon as it is rebuilt, by anything but its batching.
 */
export const SETTLE_MS = 2000;

/** A render group as the player marks it: when it was last rebuilt, and whether its Graphics are batched. */
export type Settling = {
  root: PixiContainer | null;
  renderGroupChildren: Settling[];
  structureDidChange: boolean;
  $builtAt?: number;
  $settled?: boolean;
  $settling?: boolean;
  /** The rebuild settleGroups last looked at. */
  $seen?: number;
  /** Whether it was changing as unsettle first touched it, whose rebuild is then its own; and in which call. */
  $changing?: boolean;
  $pass?: number;
  /** The Graphics settle batched in it, some since destroyed, unbatched or moved (unsettle). */
  $batched?: Set<Graphics>;
};

/**
 * A build of `group`'s instructions about to run, as Pixi's render group
 * system tells it (render/hooks.ts): when it was last rebuilt, unless
 * the build is its own batching's, which is no change of its own.
 */
export function noteBuild(group: Settling): void {
  if (group.$settling) {
    group.$settling = false;
  } else {
    group.$builtAt = performance.now();
  }
}

/** A Graphics as settling batches it, with the colour transform it is drawn under. */
type Batching = SharingGraphics & { flashColor?: ColorTransform | null };

/**
 * Batch the Graphics of a render group, its own and not those of a group
 * nested in it: showFor picks the batched copy of each one's shared
 * context, and the group lists it (`$batched`), for unsettle to find. A
 * mask's are left alone: drawn into the group of what it masks, they would
 * be packed there and kept, though its own group's rebuilds draw them
 * alone again.
 */
export function settle(group: Settling): void {
  const root = group.root;
  // Already changing, its next rebuild is one of its own, not its batching's.
  const changing = group.structureDidChange;
  group.$settled = true;
  let switched = false;
  const visit = (container: PixiContainer) => {
    if (container.includeInBuild === false) {
      return;
    }

    const graphics = container as Batching;
    if (container instanceof Graphics && !graphics.settled && graphics.shared) {
      graphics.settled = true;
      showFor(graphics, graphics.flashColor ?? null);
      group.$batched ??= new Set();
      group.$batched.add(graphics);
      switched = true;
    }

    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      if (!children[i].isRenderGroup) {
        visit(children[i]);
      }
    }
  };
  if (root) {
    visit(root);
  }

  if (switched) {
    group.structureDidChange = true;
    group.$settling = !changing;
  }
}

/** Which call of unsettle last marked a group, to note once what it was before the call changed it. */
let passes = 0;

/**
 * Mark `unsettling` unsettled, and look through the Graphics batched by
 * the groups of `scanned` (those, and any whose structure changed): each
 * one still in its settled group stays batched, one moved to another
 * settled group is listed there, and any other, in a group unsettling,
 * one that has not settled, or off the stage, is drawn alone again. A
 * Graphics leaves its group only as the group's structure changes, so the
 * batched of groups that neither unsettle nor change need no look: a
 * static stage's many batched Graphics cost nothing while an animated
 * group beside it is rebuilt on every frame.
 */
export function unsettle(unsettling: Set<Settling>, scanned: Iterable<Settling>): void {
  const pass = ++passes;
  for (const group of unsettling) {
    group.$settled = false;
    mark(group, pass);
  }

  for (const from of scanned) {
    const list = from.$batched;
    if (!list) {
      continue;
    }

    for (const graphics of list as Set<Batching>) {
      if (graphics.destroyed || !graphics.settled) {
        list.delete(graphics);
        continue;
      }

      const group = graphics.parentRenderGroup as unknown as Settling | null;
      if (group?.$settled) {
        if (group !== from) {
          list.delete(graphics);
          group.$batched ??= new Set();
          group.$batched.add(graphics);
        }

        continue;
      }

      list.delete(graphics);
      graphics.settled = false;
      showFor(graphics, graphics.flashColor ?? null);
      if (group) {
        mark(group, pass);
        group.structureDidChange = true;
        group.$settling = !group.$changing;
      }
    }
  }
}

/** Note, once a call, whether `group` was changing before the call: its rebuild is then its own. */
function mark(group: Settling, pass: number): void {
  if (group.$pass !== pass) {
    group.$pass = pass;
    group.$changing = group.structureDidChange;
  }
}
