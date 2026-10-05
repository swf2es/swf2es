// flash.display.DisplayObjectContainer: children by index, as AS3 sees
// them, over the player's render-ordered list.
import { avm2 } from "@swf2es/runtime";
import { hitsOwnPoint } from "../../../bounds.js";
import { Container, type DisplayObject, MovieClip } from "../../../display.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;

export function containerNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};
  // s.rt at call time: the natives are made before the runtime that holds them is.
  const childOf = (v: Value): DisplayObject => {
    const d = v?.$display as DisplayObject | undefined;
    if (!d) {
      throw s.rt.error("TypeError", 2007, "child");
    }

    return d;
  };
  const ownChild = (c: Container, v: Value): DisplayObject => {
    const d = childOf(v);
    if (d.parent !== c) {
      throw s.rt.error("ArgumentError", 2025);
    }

    return d;
  };
  const indexIn = (c: Container, v: Value, max = c.children.length - 1): number => {
    const i = s.rt.toInt(v);
    if (i < 0 || i > max) {
      throw s.rt.error("RangeError", 2006);
    }

    return i;
  };
  const add = (c: Container, v: Value, index: number): Value => {
    const d = childOf(v);
    // Adding an ancestor, or itself, would make a cycle.
    for (let o: DisplayObject | null = c; o; o = o.parent) {
      if (o === d) {
        throw s.rt.error("ArgumentError", 2150);
      }
    }

    // Out of another parent first, with its events; within the same one, a move only.
    const moved = d.parent === c;
    if (d.parent && !moved) {
      s.removing(d);
    }

    c.addChildAt(d, index);
    if (!moved) {
      s.added(d);
    }

    return v;
  };
  const remove = (c: Container, d: DisplayObject): void => {
    s.removing(d);
    c.removeChild(d);
  };

  class DisplayObjectContainerNatives {
    declare $display: Container;
    declare $mouseChildren: boolean | undefined;

    get numChildren(): number {
      return this.$display.children.length;
    }

    /** Itself, if a clip, and every clip in it stopped, those not yet made alive too. */
    stopAllMovieClips(): void {
      const stop = (d: DisplayObject) => {
        if (d instanceof MovieClip) {
          d.playing = false;
        }

        if (d instanceof Container) {
          for (const child of d.children) {
            stop(child);
          }
        }
      };
      stop(this.$display);
    }

    addChild(child: Value): Value {
      const c = this.$display;
      const d = childOf(child);
      // Already a child: moved to the top.
      return add(c, child, d.parent === c ? c.children.length - 1 : c.children.length);
    }

    addChildAt(child: Value, index: Value): Value {
      const c = this.$display;
      const d = childOf(child);
      return add(c, child, indexIn(c, index, c.children.length - (d.parent === c ? 1 : 0)));
    }

    removeChild(child: Value): Value {
      const c = this.$display;
      remove(c, ownChild(c, child));
      return child;
    }

    removeChildAt(index: Value): Value {
      const c = this.$display;
      const d = c.children[indexIn(c, index)];
      remove(c, d);
      return d.object;
    }

    removeChildren(begin: Value, end: Value): void {
      const c = this.$display;
      const from = begin === undefined ? 0 : s.rt.toInt(begin);
      const to =
        end === undefined || s.rt.toInt(end) === 0x7fffffff ? c.children.length : s.rt.toInt(end);
      if (from < 0 || to > c.children.length || from > to) {
        throw s.rt.error("RangeError", 2006);
      }

      for (const d of c.children.slice(from, to)) {
        remove(c, d);
      }
    }

    /**
     * What draws under a point of the stage, of this container's
     * descendants: each visible one whose own drawing is there, within
     * its masks, parents before their children, as the corpus's
     * `displayobjectcontainer_getobjectsunderpoint` has Flash's; masks and
     * objects without a face to a script are left out.
     */
    getObjectsUnderPoint(point: Value): Value {
      if (point === null || point === undefined) {
        throw s.rt.error("TypeError", 2007, "point");
      }

      const x = s.rt.toNumber(s.rt.getProperty(point as avm2.AsObject, s.rt.publicName("x")));
      const y = s.rt.toNumber(s.rt.getProperty(point as avm2.AsObject, s.rt.publicName("y")));
      const found: Value[] = [];
      const stage = s.stage;
      if (!stage) {
        return s.rt.array(found);
      }

      const visit = (c: Container): void => {
        for (const d of c.children) {
          if (!d.visible) {
            continue;
          }

          if (d.object && hitsOwnPoint(d, x, y, stage)) {
            found.push(d.object);
          }

          if (d instanceof Container) {
            visit(d);
          }
        }
      };
      visit(this.$display);
      return s.rt.array(found);
    }

    /** Whether a security sandbox hides any of them: the player has none. */
    areInaccessibleObjectsUnderPoint(point: Value): boolean {
      if (point === null || point === undefined) {
        throw s.rt.error("TypeError", 2007, "point");
      }

      return false;
    }

    getChildAt(index: Value): Value {
      const c = this.$display;
      return c.children[indexIn(c, index)].object;
    }

    getChildIndex(child: Value): number {
      const c = this.$display;
      return c.children.indexOf(ownChild(c, child));
    }

    setChildIndex(child: Value, index: Value): void {
      const c = this.$display;
      const d = ownChild(c, child);
      c.addChildAt(d, indexIn(c, index));
    }

    getChildByName(name: Value): Value {
      const key = String(name);
      return this.$display.children.find((d) => d.name === key)?.object ?? null;
    }

    contains(child: Value): boolean {
      const c = this.$display;
      for (let o: DisplayObject | null = child?.$display ?? null; o; o = o.parent) {
        if (o === c) {
          return true;
        }
      }

      return false;
    }

    swapChildren(a: Value, b: Value): void {
      const c = this.$display;
      c.swapChildren(ownChild(c, a), ownChild(c, b));
    }

    swapChildrenAt(a: Value, b: Value): void {
      const c = this.$display;
      c.swapChildren(c.children[indexIn(c, a)], c.children[indexIn(c, b)]);
    }

    get mouseChildren(): boolean {
      return this.$mouseChildren ?? true;
    }

    set mouseChildren(v: Value) {
      this.$mouseChildren = !!v;
    }

    declare $tabChildren: boolean | undefined;

    // The stage's is always true: setting it sets the root's, removed or not, as Ruffle has it.
    get tabChildren(): boolean {
      return this === s.stage?.object ? true : (this.$tabChildren ?? true);
    }

    set tabChildren(v: Value) {
      const target = this === s.stage?.object ? s.root?.object : this;
      if (target) {
        (target as unknown as { $tabChildren: boolean }).$tabChildren = !!v;
      }
    }
  }

  avm2.registerNativeClass(
    natives,
    "flash.display::DisplayObjectContainer",
    DisplayObjectContainerNatives,
  );
  return natives;
}
